import type { TaskContext, TaskDefinition, TaskResult } from './base-task.js'
import { EventEmitter } from 'node:events'
import { retry } from '../utils/delay.js'
import { StepExecutionError, TaskError, TimeoutError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'

export interface RunResult {
  results: TaskResult[]
  startedAt: Date
  completedAt: Date
}

export class TaskRunner extends EventEmitter {
  private tasks: TaskDefinition[] = []

  register(task: TaskDefinition): void {
    this.tasks.push(task)
  }

  registerAll(tasks: TaskDefinition[]): void {
    for (const task of tasks) {
      this.register(task)
    }
  }

  getEnabledTasks(enabledIds: string[]): TaskDefinition[] {
    const taskMap = new Map(this.tasks.map(t => [t.id, t]))
    const ordered: TaskDefinition[] = []
    const resolved = new Set<string>()
    const resolving = new Set<string>()

    const visit = (id: string, chain: string[]): void => {
      if (resolved.has(id))
        return
      const task = taskMap.get(id)
      if (!task)
        throw new TaskError(`Unknown task "${id}" (dependency chain: ${[...chain, id].join(' -> ')})`, id)
      if (resolving.has(id))
        throw new TaskError(`Circular task dependency: ${[...chain, id].join(' -> ')}`, id)

      resolving.add(id)
      for (const dependency of task.dependsOn ?? [])
        visit(dependency, [...chain, id])
      resolving.delete(id)
      resolved.add(id)
      ordered.push(task)
    }

    for (const id of enabledIds)
      visit(id, [])

    return ordered
  }

  async runAll(
    ctx: Omit<TaskContext, 'logger'>,
    enabledIds: string[],
  ): Promise<RunResult> {
    const enabled = this.getEnabledTasks(enabledIds)
    const results: TaskResult[] = []
    const resultsByTaskId = new Map<string, TaskResult>()
    const startedAt = new Date()

    logger.info(`▶ Starting task run: ${enabled.length} task(s) enabled`)

    for (let i = 0; i < enabled.length; i++) {
      const task = enabled[i]!
      this.emit('task:index', { taskIndex: i + 1, taskTotal: enabled.length, taskId: task.id })
      const failedDependencies = (task.dependsOn ?? []).filter((dependencyId) => {
        const dependencyResult = resultsByTaskId.get(dependencyId)
        return dependencyResult && !dependencyResult.success
      })
      if (failedDependencies.length > 0) {
        const message = `Skipped because prerequisite task(s) failed: ${failedDependencies.join(', ')}`
        const result: TaskResult = {
          taskId: task.id,
          success: false,
          message,
          durationMs: 0,
          completedAt: new Date(),
          error: { name: 'DependencyError', message },
        }
        results.push(result)
        resultsByTaskId.set(task.id, result)
        this.emit('task:complete', result)
        logger.warn(`⏭️ [${task.id}] ${message}`)
        continue
      }
      logger.info(`⏳ [${task.id}] Starting (Task ${i + 1}/${enabled.length}): ${task.name}`)
      const result = await this.runSingle(task, { ...ctx, logger })
      results.push(result)
      resultsByTaskId.set(task.id, result)
      if (result.error?.name === 'TimeoutError') {
        logger.error(`Stopping the run after fatal timeout in "${task.id}"`)
        break
      }
    }

    const completedAt = new Date()
    const runResult: RunResult = { results, startedAt, completedAt }

    this.emit('run:complete', runResult)
    const passed = results.filter(r => r.success).length
    const total = results.length
    const icon = passed === total ? '🎉' : '⚠️'
    logger.info(
      `${icon} Task run complete: ${passed}/${total} succeeded`,
    )

    return runResult
  }

  private async runSingle(
    task: TaskDefinition,
    ctx: TaskContext,
  ): Promise<TaskResult> {
    this.emit('task:start', { taskId: task.id, name: task.name })

    const start = Date.now()

    const execute = async (): Promise<TaskResult> => {
      // Wrap with timeout
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // Closing the page aborts any in-flight screenshot/model-driven page
          // action. A timed-out attempt must never overlap a retry or next task.
          void ctx.page.close({ runBeforeUnload: false }).catch(() => {})
          reject(new TimeoutError(`task:${task.id}`, task.timeoutMs))
        }, task.timeoutMs)
      })

      try {
        const result = await Promise.race([task.execute(ctx), timeoutPromise])
        if (!result.success)
          throw new TaskError(result.message, task.id)
        return result
      }
      finally {
        if (timer)
          clearTimeout(timer)
      }
    }

    try {
      const retries = task.retries ?? 0
      let result: TaskResult

      if (retries > 0) {
        result = await retry(execute, {
          retries,
          delayMs: 2000,
          onRetry: (attempt) => {
            logger.warn(`🔄 [${task.id}] Retry attempt ${attempt}`)
          },
          shouldRetry: error => !(error instanceof TimeoutError),
        })
      }
      else {
        result = await execute()
      }

      this.emit('task:complete', result)
      if (result.success) {
        logger.info(`✅ [${task.id}] Completed: ${result.message}`)
      }
      else {
        logger.error(`❌ [${task.id}] Failed: ${result.message}`)
      }
      return result
    }
    catch (err) {
      const durationMs = Date.now() - start
      const error = err instanceof Error ? err : new Error(String(err))
      const result: TaskResult = {
        taskId: task.id,
        success: false,
        message: error.message,
        durationMs,
        completedAt: new Date(),
        error: { name: error.name, message: error.message },
        screenshot: error instanceof StepExecutionError ? error.screenshotPath : undefined,
      }

      this.emit('task:complete', result)
      logger.error(`❌ [${task.id}] Failed: ${error.message}`)
      return result
    }
  }
}
