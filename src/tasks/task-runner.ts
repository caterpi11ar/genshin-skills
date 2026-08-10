import type { TaskContext, TaskDefinition, TaskResult } from './base-task.js'
import { EventEmitter } from 'node:events'
import { delay } from '../utils/delay.js'
import {
  cancellationError,
  CancellationError,
  QuarantinedError,
  StepExecutionError,
  TaskError,
  TimeoutError,
  toError,
} from '../utils/errors.js'
import { logger, sanitizeBoundedText } from '../utils/logger.js'

export interface RunResult {
  results: TaskResult[]
  startedAt: Date
  completedAt: Date
}

export interface TaskRunnerOptions {
  cleanupTimeoutMs?: number
}

const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000
const PENDING_OPERATION = Symbol.for('giclaw.pending-step-operation')

type TaskOutcome
  = | { status: 'fulfilled', result: TaskResult }
    | { status: 'rejected', error: unknown }

interface AttemptStop {
  status: 'stopped'
  error: CancellationError | TimeoutError
}

type CleanupOutcome
  = | { status: 'fulfilled' }
    | { status: 'rejected', error: unknown }

function getPendingOperation(error: unknown): Promise<unknown> | undefined {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null)
    return undefined

  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, PENDING_OPERATION)
    return descriptor?.value instanceof Promise ? descriptor.value : undefined
  }
  catch {
    return undefined
  }
}

function settledCleanup(pending: Promise<unknown>): Promise<CleanupOutcome> {
  return pending.then(
    () => ({ status: 'fulfilled' as const }),
    error => ({ status: 'rejected' as const, error }),
  )
}

function sanitizeTaskResult(result: TaskResult): TaskResult {
  return {
    ...result,
    taskId: sanitizeBoundedText(result.taskId, 256),
    message: sanitizeBoundedText(result.message),
    screenshot: result.screenshot === undefined
      ? undefined
      : sanitizeBoundedText(result.screenshot),
    error: result.error === undefined
      ? undefined
      : {
          name: sanitizeBoundedText(result.error.name, 256),
          message: sanitizeBoundedText(result.error.message),
        },
  }
}

export class TaskRunner extends EventEmitter {
  private tasks: TaskDefinition[] = []
  private readonly cleanupTimeoutMs: number
  private quarantinedError: QuarantinedError | null = null
  /**
   * Serialize complete runs, including timeout cleanup. This prevents a caller
   * that bypasses TaskQueue from starting a new browser run while the previous
   * task is still unwinding.
   */
  private runTail: Promise<void> = Promise.resolve()

  constructor(options: TaskRunnerOptions = {}) {
    super()
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS
  }

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

  runAll(
    ctx: Omit<TaskContext, 'logger' | 'signal'>,
    enabledIds: string[],
    signal?: AbortSignal,
  ): Promise<RunResult> {
    const run = this.runTail.then(() => this.runAllExclusive(ctx, enabledIds, signal))
    this.runTail = run.then(() => undefined, () => undefined)
    return run
  }

  private async runAllExclusive(
    ctx: Omit<TaskContext, 'logger' | 'signal'>,
    enabledIds: string[],
    signal?: AbortSignal,
  ): Promise<RunResult> {
    this.assertUsable()
    if (signal?.aborted)
      throw cancellationError('task run', signal.reason)

    const enabled = this.getEnabledTasks(enabledIds)
    const results: TaskResult[] = []
    const startedAt = new Date()

    logger.info(`▶ Starting task run: ${enabled.length} task(s) enabled`)

    for (let i = 0; i < enabled.length; i++) {
      this.assertUsable()
      if (signal?.aborted)
        throw cancellationError('task run', signal.reason)

      const task = enabled[i]!
      this.emitSafely('task:index', { taskIndex: i + 1, taskTotal: enabled.length, taskId: task.id })
      logger.info(`⏳ [${task.id}] Starting (Task ${i + 1}/${enabled.length}): ${task.name}`)
      const result = await this.runSingle(task, ctx, signal)
      results.push(result)
      if (!result.success) {
        logger.error(`Stopping the run after failure in "${task.id}"`)
        break
      }
    }

    const completedAt = new Date()
    const runResult: RunResult = { results, startedAt, completedAt }

    this.emitSafely('run:complete', runResult)
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
    ctx: Omit<TaskContext, 'logger' | 'signal'>,
    externalSignal?: AbortSignal,
  ): Promise<TaskResult> {
    this.emitSafely('task:start', { taskId: task.id, name: task.name })

    const start = Date.now()

    const execute = async (): Promise<TaskResult> => {
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      let removeExternalAbort: (() => void) | undefined
      const stopPromise = new Promise<AttemptStop>((resolve) => {
        timer = setTimeout(() => resolve({
          status: 'stopped',
          error: new TimeoutError(`task:${task.id}`, task.timeoutMs),
        }), task.timeoutMs)
        if (externalSignal) {
          const onAbort = () => resolve({
            status: 'stopped',
            error: cancellationError(`task:${task.id}`, externalSignal.reason),
          })
          externalSignal.addEventListener('abort', onAbort, { once: true })
          removeExternalAbort = () => externalSignal.removeEventListener('abort', onAbort)
          // task:start observers run synchronously before this listener is
          // installed and may request cancellation re-entrantly.
          if (externalSignal.aborted)
            onAbort()
        }
      })
      const taskPromise = Promise.resolve().then(() => task.execute({
        ...ctx,
        logger,
        signal: controller.signal,
      }))
      const taskOutcome: Promise<TaskOutcome> = taskPromise.then(
        result => ({ status: 'fulfilled' as const, result }),
        error => ({ status: 'rejected' as const, error }),
      )

      try {
        const outcome = await Promise.race([taskOutcome, stopPromise])
        if (outcome.status === 'stopped') {
          controller.abort(outcome.error)
          await this.cleanStoppedAttempt(task, ctx, taskOutcome)
          throw outcome.error
        }

        if (outcome.status === 'rejected') {
          const pendingOperation = getPendingOperation(outcome.error)
          if (pendingOperation) {
            controller.abort(outcome.error)
            await this.cleanStoppedAttempt(task, ctx, pendingOperation)
          }
          throw outcome.error
        }

        const result = sanitizeTaskResult(outcome.result)
        if (!result.success)
          throw new TaskError(result.message, task.id)
        return result
      }
      finally {
        if (timer)
          clearTimeout(timer)
        removeExternalAbort?.()
        if (!controller.signal.aborted)
          controller.abort()
      }
    }

    try {
      const retries = task.retries ?? 0
      let attempt = 0
      while (true) {
        try {
          const result = await execute()
          this.emitSafely('task:complete', result)
          // execute() converts unsuccessful task results into TaskError, so
          // reaching this point always means the task succeeded.
          logger.info(`✅ [${task.id}] Completed: ${result.message}`)
          return result
        }
        catch (error) {
          if (error instanceof TimeoutError || error instanceof CancellationError || attempt >= retries)
            throw error
          logger.warn(`🔄 [${task.id}] Retry attempt ${attempt + 1}`)
          try {
            await delay(2_000, externalSignal)
          }
          catch {
            throw cancellationError(
              `task:${task.id}`,
              externalSignal!.reason,
            )
          }
          attempt++
        }
      }
    }
    catch (err) {
      if (err instanceof CancellationError)
        throw err
      const durationMs = Date.now() - start
      const error = err instanceof Error ? err : new Error(String(err))
      const safeMessage = sanitizeBoundedText(error.message)
      const safeName = sanitizeBoundedText(error.name, 256)
      const result: TaskResult = {
        taskId: task.id,
        success: false,
        message: safeMessage,
        durationMs,
        completedAt: new Date(),
        error: { name: safeName, message: safeMessage },
        screenshot: error instanceof StepExecutionError && error.screenshotPath
          ? sanitizeBoundedText(error.screenshotPath)
          : undefined,
      }

      this.emitSafely('task:complete', result)
      logger.error(`❌ [${task.id}] Failed: ${safeMessage}`)
      return result
    }
  }

  private async cleanStoppedAttempt(
    task: TaskDefinition,
    ctx: Omit<TaskContext, 'logger' | 'signal'>,
    pendingOperation: Promise<unknown>,
  ): Promise<void> {
    const pageClose = Promise.resolve()
      .then(() => ctx.page.close({ runBeforeUnload: false }))
      .then(
        () => ({ status: 'fulfilled' as const }),
        error => ({ status: 'rejected' as const, error }),
      )
    const cleanup = Promise.all([pageClose, settledCleanup(pendingOperation)])
    const cleanupTimedOut = Symbol('cleanup-timed-out')
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<typeof cleanupTimedOut>((resolve) => {
      timer = setTimeout(resolve, this.cleanupTimeoutMs, cleanupTimedOut)
    })

    try {
      const outcome = await Promise.race([cleanup, deadline])
      if (outcome === cleanupTimedOut) {
        this.quarantine(new TimeoutError(
          `cleanup after task:${task.id}`,
          this.cleanupTimeoutMs,
        ))
        return
      }

      const [closeOutcome] = outcome
      if (closeOutcome.status === 'rejected') {
        this.quarantine(toError(closeOutcome.error))
      }
      // Rejection is the normal way most browser/model operations unwind after
      // their AbortSignal fires or the page closes. Once the task has settled
      // and page.close() succeeded there can be no overlapping side effects,
      // so keep the original timeout/cancellation without quarantining.
    }
    finally {
      if (timer)
        clearTimeout(timer)
    }
  }

  private quarantine(cause: Error): void {
    this.quarantinedError = new QuarantinedError(
      'Task runner is quarantined because a stopped attempt did not clean up safely',
      cause,
    )
    logger.error(this.quarantinedError.message, cause)
    this.emitSafely('quarantine', this.quarantinedError)
  }

  private assertUsable(): void {
    if (this.quarantinedError)
      throw this.quarantinedError
  }

  private emitSafely(event: string, ...args: unknown[]): void {
    try {
      this.emit(event, ...args)
    }
    catch (error) {
      try {
        logger.error(`Task runner "${event}" listener failed`, error)
      }
      catch {
        // Observability failures must not alter task execution semantics.
      }
    }
  }
}
