import type { Page } from 'playwright'
import type { TaskDefinition } from './base-task.js'
import { describe, expect, it, vi } from 'vitest'
import { appConfigSchema } from '../config/schema.js'
import { TaskRunner } from './task-runner.js'

function task(id: string, dependsOn: string[] = []): TaskDefinition {
  return {
    id,
    name: id,
    description: id,
    defaultEnabled: true,
    timeoutMs: 1000,
    dependsOn,
    execute: async () => ({
      taskId: id,
      success: true,
      message: 'done',
      durationMs: 0,
      completedAt: new Date(),
    }),
  }
}

describe('taskRunner dependency resolution', () => {
  it('adds transitive dependencies once and preserves requested order', () => {
    const runner = new TaskRunner()
    runner.registerAll([
      task('launch'),
      task('mail', ['launch']),
      task('events', ['launch']),
    ])

    expect(runner.getEnabledTasks(['mail', 'events']).map(item => item.id))
      .toEqual(['launch', 'mail', 'events'])
  })

  it('rejects unknown tasks and circular dependencies', () => {
    const runner = new TaskRunner()
    runner.registerAll([task('a', ['b']), task('b', ['a'])])

    expect(() => runner.getEnabledTasks(['missing'])).toThrow('Unknown task "missing"')
    expect(() => runner.getEnabledTasks(['a'])).toThrow('Circular task dependency')
  })

  it('does not execute a task when its prerequisite failed', async () => {
    const runner = new TaskRunner()
    const executeDependent = vi.fn(task('dependent').execute)
    const failed = task('failed')
    failed.execute = async () => ({
      taskId: 'failed',
      success: false,
      message: 'failed deliberately',
      durationMs: 0,
      completedAt: new Date(),
    })
    const dependent = task('dependent', ['failed'])
    dependent.execute = executeDependent
    runner.registerAll([failed, dependent])

    const result = await runner.runAll({
      page: {} as Page,
      modelConfig: {},
      config: appConfigSchema.parse({}),
    }, ['dependent'])

    expect(executeDependent).not.toHaveBeenCalled()
    expect(result.results.map(item => ({
      taskId: item.taskId,
      success: item.success,
      error: item.error?.name,
    }))).toEqual([
      { taskId: 'failed', success: false, error: 'TaskError' },
      { taskId: 'dependent', success: false, error: 'DependencyError' },
    ])
  })
})
