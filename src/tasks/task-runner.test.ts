import type { Page } from 'playwright'
import type { TaskDefinition, TaskResult } from './base-task.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appConfigSchema } from '../config/schema.js'
import { StepExecutionError, TimeoutError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'
import { TaskRunner } from './task-runner.js'

const PENDING_OPERATION = Symbol.for('giclaw.pending-step-operation')

function timeoutWithPending(pending: Promise<unknown>, operation = 'visual wait'): TimeoutError {
  const error = new TimeoutError(operation, 123)
  Object.defineProperty(error, PENDING_OPERATION, { value: pending })
  return error
}

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
  afterEach(() => {
    vi.useRealTimers()
  })

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

  it('treats omitted dependency arrays as empty', async () => {
    const runner = new TaskRunner()
    const standalone = task('standalone')
    delete standalone.dependsOn
    runner.register(standalone)

    expect(runner.getEnabledTasks(['standalone'])).toEqual([standalone])
    await expect(runner.runAll({
      page: {} as Page,
      modelConfig: {},
      config: appConfigSchema.parse({}),
    }, ['standalone'])).resolves.toMatchObject({
      results: [expect.objectContaining({ taskId: 'standalone', success: true })],
    })
  })

  it('rejects a run cancelled before it starts without executing tasks', async () => {
    const runner = new TaskRunner()
    const cancelled = task('cancelled-before-start')
    cancelled.execute = vi.fn(cancelled.execute)
    runner.register(cancelled)
    const controller = new AbortController()
    const reason = new Error('cancelled before start')
    controller.abort(reason)

    await expect(runner.runAll({
      page: {} as Page,
      modelConfig: {},
      config: appConfigSchema.parse({}),
    }, [cancelled.id], controller.signal)).rejects.toMatchObject({
      name: 'CancellationError',
      cause: reason,
    })
    expect(cancelled.execute).not.toHaveBeenCalled()
  })

  it('stops before the next task when cancellation arrives between tasks', async () => {
    const runner = new TaskRunner()
    const controller = new AbortController()
    const reason = new Error('cancelled between tasks')
    const first = task('first')
    first.execute = vi.fn(first.execute)
    const second = task('second')
    second.execute = vi.fn(second.execute)
    runner.registerAll([first, second])
    runner.on('task:complete', ({ taskId }) => {
      if (taskId === first.id)
        controller.abort(reason)
    })

    await expect(runner.runAll({
      page: {} as Page,
      modelConfig: {},
      config: appConfigSchema.parse({}),
    }, [first.id, second.id], controller.signal)).rejects.toMatchObject({
      name: 'CancellationError',
      cause: reason,
    })
    expect(first.execute).toHaveBeenCalledOnce()
    expect(second.execute).not.toHaveBeenCalled()
  })

  it('honors cancellation requested synchronously by a task-start observer', async () => {
    const runner = new TaskRunner()
    const controller = new AbortController()
    const reason = new Error('cancelled by observer')
    const cancelled = task('observer-cancelled')
    cancelled.execute = vi.fn(async ({ signal }) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
      return {
        taskId: cancelled.id,
        success: true,
        message: 'unwound',
        durationMs: 0,
        completedAt: new Date(),
      }
    })
    runner.register(cancelled)
    runner.on('task:start', () => controller.abort(reason))

    await expect(runner.runAll({
      page: { close: vi.fn(async () => {}) } as unknown as Page,
      modelConfig: {},
      config: appConfigSchema.parse({}),
    }, [cancelled.id], controller.signal)).rejects.toMatchObject({
      name: 'CancellationError',
      cause: reason,
    })
    expect(cancelled.execute).toHaveBeenCalledOnce()
  })

  it('rejects unknown tasks and circular dependencies', () => {
    const runner = new TaskRunner()
    runner.registerAll([task('a', ['b']), task('b', ['a'])])

    expect(() => runner.getEnabledTasks(['missing'])).toThrow('Unknown task "missing"')
    expect(() => runner.getEnabledTasks(['a'])).toThrow('Circular task dependency')
  })

  it('stops immediately when a prerequisite task fails', async () => {
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
    ])
  })

  it('does not continue with independent tasks after a failure', async () => {
    const runner = new TaskRunner()
    const failed = task('failed')
    failed.execute = vi.fn(async () => ({
      taskId: 'failed',
      success: false,
      message: 'failed deliberately',
      durationMs: 0,
      completedAt: new Date(),
    }))
    const independent = task('independent')
    independent.execute = vi.fn(independent.execute)
    runner.registerAll([failed, independent])

    const result = await runner.runAll({
      page: {} as Page,
      modelConfig: {},
      config: appConfigSchema.parse({}),
    }, ['failed', 'independent'])

    expect(result.results.map(item => [item.taskId, item.success])).toEqual([
      ['failed', false],
    ])
    expect(independent.execute).not.toHaveBeenCalled()
  })

  it('retries non-timeout failures and eventually returns success', async () => {
    vi.useFakeTimers()
    const runner = new TaskRunner()
    const retried = task('retried')
    retried.retries = 2
    retried.execute = vi.fn()
      .mockResolvedValueOnce({
        taskId: 'retried',
        success: false,
        message: 'not yet',
        durationMs: 0,
        completedAt: new Date(),
      })
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({
        taskId: 'retried',
        success: true,
        message: 'done',
        durationMs: 0,
        completedAt: new Date(),
      })
    runner.register(retried)

    const runPromise = runner.runAll({
      page: { close: vi.fn() } as unknown as Page,
      modelConfig: {},
      config: appConfigSchema.parse({}),
    }, ['retried'])
    await vi.advanceTimersByTimeAsync(4000)

    const result = await runPromise
    expect(retried.execute).toHaveBeenCalledTimes(3)
    expect(result.results[0]).toMatchObject({ taskId: 'retried', success: true })
  })

  it('cancels promptly while waiting for a retry backoff', async () => {
    const runner = new TaskRunner()
    const retried = task('cancelled-retry')
    retried.retries = 2
    retried.execute = vi.fn(async () => {
      throw new Error('transient')
    })
    runner.register(retried)
    const controller = new AbortController()

    const run = runner.runAll({
      page: {} as Page,
      modelConfig: {},
      config: appConfigSchema.parse({}),
    }, [retried.id], controller.signal)
    await vi.waitFor(() => expect(retried.execute).toHaveBeenCalledOnce())
    controller.abort(new Error('shutdown during retry'))

    await expect(run).rejects.toMatchObject({
      name: 'CancellationError',
      cause: expect.objectContaining({ message: 'shutdown during retry' }),
    })
    expect(retried.execute).toHaveBeenCalledOnce()
  })

  it('closes the page, does not retry, and stops the run after timeout', async () => {
    vi.useFakeTimers()
    const runner = new TaskRunner()
    const timedOut = task('timed-out')
    timedOut.timeoutMs = 25
    timedOut.retries = 3
    const cleanup = vi.fn()
    timedOut.execute = vi.fn(async ({ signal }) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      cleanup()
      return {
        taskId: 'timed-out',
        success: true,
        message: 'unwound',
        durationMs: 25,
        completedAt: new Date(),
      }
    })
    const after = task('after')
    after.execute = vi.fn(after.execute)
    runner.registerAll([timedOut, after])
    const close = vi.fn(async () => {})

    const runPromise = runner.runAll({
      page: { close } as unknown as Page,
      modelConfig: {},
      config: appConfigSchema.parse({}),
    }, ['timed-out', 'after'])
    await vi.advanceTimersByTimeAsync(25)

    const result = await runPromise
    expect(close).toHaveBeenCalledWith({ runBeforeUnload: false })
    expect(cleanup).toHaveBeenCalledOnce()
    expect(timedOut.execute).toHaveBeenCalledOnce()
    expect(after.execute).not.toHaveBeenCalled()
    expect(result.results).toHaveLength(1)
    expect(result.results[0]).toMatchObject({
      taskId: 'timed-out',
      success: false,
      error: { name: 'TimeoutError' },
    })
  })

  it('waits for page close and task unwind before resolving a timeout', async () => {
    vi.useFakeTimers()
    const runner = new TaskRunner()
    const timedOut = task('slow-cleanup')
    timedOut.timeoutMs = 10
    let releaseCleanup!: () => void
    let releaseClose!: () => void
    const cleanupGate = new Promise<void>(resolve => releaseCleanup = resolve)
    const closeGate = new Promise<void>(resolve => releaseClose = resolve)
    timedOut.execute = async ({ signal }) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      await cleanupGate
      return {
        taskId: timedOut.id,
        success: true,
        message: 'cleaned',
        durationMs: 10,
        completedAt: new Date(),
      }
    }
    runner.register(timedOut)
    const close = vi.fn(() => closeGate)
    let settled = false

    const runPromise = runner.runAll({
      page: { close } as unknown as Page,
      modelConfig: {},
      config: appConfigSchema.parse({}),
    }, [timedOut.id]).then((result) => {
      settled = true
      return result
    })
    await vi.advanceTimersByTimeAsync(10)

    expect(close).toHaveBeenCalledOnce()
    releaseCleanup()
    await Promise.resolve()
    expect(settled).toBe(false)
    releaseClose()

    await expect(runPromise).resolves.toMatchObject({
      results: [expect.objectContaining({
        error: expect.objectContaining({ name: 'TimeoutError' }),
      })],
    })
  })

  it('preserves the timeout when forced page cleanup fails', async () => {
    vi.useFakeTimers()
    const runner = new TaskRunner()
    const timedOut = task('close-failure')
    timedOut.timeoutMs = 5
    timedOut.execute = async ({ signal }) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      return {
        taskId: timedOut.id,
        success: true,
        message: 'unwound',
        durationMs: 5,
        completedAt: new Date(),
      }
    }
    runner.register(timedOut)
    const cleanupError = new Error('page close failed')

    const runPromise = runner.runAll({
      page: { close: vi.fn().mockRejectedValue(cleanupError) } as unknown as Page,
      modelConfig: {},
      config: appConfigSchema.parse({}),
    }, [timedOut.id])
    await vi.advanceTimersByTimeAsync(5)

    await expect(runPromise).resolves.toMatchObject({
      results: [expect.objectContaining({
        error: expect.objectContaining({ name: 'TimeoutError' }),
      })],
    })

    await expect(runner.runAll({
      page: {} as Page,
      modelConfig: {},
      config: appConfigSchema.parse({}),
    }, [timedOut.id])).rejects.toMatchObject({
      name: 'QuarantinedError',
      code: 'QUARANTINED',
      cause: cleanupError,
    })
  })

  it('allows a later run when an aborted task rejects after the page closes cleanly', async () => {
    vi.useFakeTimers()
    const runner = new TaskRunner()
    const timedOut = task('rejecting-cleanup')
    timedOut.timeoutMs = 5
    const unwindError = new Error('abort cleanup failed')
    let attempt = 0
    timedOut.execute = async ({ signal }) => {
      if (attempt++ > 0) {
        return {
          taskId: timedOut.id,
          success: true,
          message: 'next run completed',
          durationMs: 0,
          completedAt: new Date(),
        }
      }
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      throw unwindError
    }
    runner.register(timedOut)

    const run = runner.runAll({
      page: { close: vi.fn(async () => {}) } as unknown as Page,
      modelConfig: {},
      config: appConfigSchema.parse({}),
    }, [timedOut.id])
    await vi.advanceTimersByTimeAsync(5)

    await expect(run).resolves.toMatchObject({
      results: [expect.objectContaining({
        error: expect.objectContaining({ name: 'TimeoutError' }),
      })],
    })
    await expect(runner.runAll({
      page: {} as Page,
      modelConfig: {},
      config: appConfigSchema.parse({}),
    }, [timedOut.id])).resolves.toMatchObject({
      results: [expect.objectContaining({ taskId: timedOut.id })],
    })
  })

  it('waits for an attached timed-out operation to settle before allowing later work', async () => {
    const runner = new TaskRunner({ cleanupTimeoutMs: 100 })
    const timedOut = task('visual-timeout')
    const future = task('future-after-visual-timeout')
    future.execute = vi.fn(future.execute)
    let releaseOperation!: () => void
    const operation = new Promise<void>(resolve => releaseOperation = resolve)
    const original = timeoutWithPending(operation)
    timedOut.execute = vi.fn(async () => {
      throw original
    })
    runner.registerAll([timedOut, future])
    const close = vi.fn(async () => {})
    let settled = false

    const run = runner.runAll({
      page: { close } as unknown as Page,
      modelConfig: {},
      config: appConfigSchema.parse({}),
    }, [timedOut.id]).then((result) => {
      settled = true
      return result
    })
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())

    expect(settled).toBe(false)
    releaseOperation()
    await expect(run).resolves.toMatchObject({
      results: [expect.objectContaining({
        success: false,
        message: original.message,
        error: { name: 'TimeoutError', message: original.message },
      })],
    })
    await expect(runner.runAll({
      page: {} as Page,
      modelConfig: {},
      config: appConfigSchema.parse({}),
    }, [future.id])).resolves.toMatchObject({
      results: [expect.objectContaining({ success: true })],
    })
    expect(future.execute).toHaveBeenCalledOnce()
  })

  it('quarantines when an attached timed-out operation misses the cleanup deadline', async () => {
    vi.useFakeTimers()
    const runner = new TaskRunner({ cleanupTimeoutMs: 20 })
    const timedOut = task('stuck-visual-timeout')
    const future = task('blocked-after-visual-timeout')
    future.execute = vi.fn(future.execute)
    const original = timeoutWithPending(new Promise<never>(() => {}), 'stuck visual wait')
    timedOut.execute = vi.fn(async () => {
      throw original
    })
    runner.registerAll([timedOut, future])
    const close = vi.fn(async () => {})

    const run = runner.runAll({
      page: { close } as unknown as Page,
      modelConfig: {},
      config: appConfigSchema.parse({}),
    }, [timedOut.id])
    await vi.advanceTimersByTimeAsync(20)

    await expect(run).resolves.toMatchObject({
      results: [expect.objectContaining({
        message: original.message,
        error: { name: 'TimeoutError', message: original.message },
      })],
    })
    expect(close).toHaveBeenCalledOnce()
    await expect(runner.runAll({
      page: {} as Page,
      modelConfig: {},
      config: appConfigSchema.parse({}),
    }, [future.id])).rejects.toMatchObject({ name: 'QuarantinedError' })
    expect(future.execute).not.toHaveBeenCalled()
  })

  it('preserves an attached timeout and quarantines when its page cannot close', async () => {
    const runner = new TaskRunner()
    const timedOut = task('visual-close-failure')
    const future = task('blocked-after-close-failure')
    future.execute = vi.fn(future.execute)
    const original = timeoutWithPending(Promise.resolve(), 'visual close failure')
    timedOut.execute = vi.fn(async () => {
      throw original
    })
    runner.registerAll([timedOut, future])
    const closeError = new Error('could not close visual page')

    const result = await runner.runAll({
      page: { close: vi.fn().mockRejectedValue(closeError) } as unknown as Page,
      modelConfig: {},
      config: appConfigSchema.parse({}),
    }, [timedOut.id])

    expect(result.results[0]).toMatchObject({
      message: original.message,
      error: { name: 'TimeoutError', message: original.message },
    })
    await expect(runner.runAll({
      page: {} as Page,
      modelConfig: {},
      config: appConfigSchema.parse({}),
    }, [future.id])).rejects.toMatchObject({
      name: 'QuarantinedError',
      cause: closeError,
    })
    expect(future.execute).not.toHaveBeenCalled()
  })

  it('bounds a non-cooperative timeout cleanup and quarantines all future work', async () => {
    vi.useFakeTimers()
    const runner = new TaskRunner({ cleanupTimeoutMs: 20 })
    const stuck = task('stuck')
    stuck.timeoutMs = 10
    stuck.execute = vi.fn(() => new Promise<never>(() => {}))
    const future = task('future')
    future.execute = vi.fn(future.execute)
    runner.registerAll([stuck, future])
    const close = vi.fn(async () => {})

    const stuckRun = runner.runAll({
      page: { close } as unknown as Page,
      modelConfig: {},
      config: appConfigSchema.parse({}),
    }, [stuck.id])
    await vi.advanceTimersByTimeAsync(30)

    await expect(stuckRun).resolves.toMatchObject({
      results: [expect.objectContaining({
        error: expect.objectContaining({ name: 'TimeoutError' }),
      })],
    })
    expect(close).toHaveBeenCalledOnce()
    await expect(runner.runAll({
      page: {} as Page,
      modelConfig: {},
      config: appConfigSchema.parse({}),
    }, [future.id])).rejects.toMatchObject({ name: 'QuarantinedError' })
    expect(future.execute).not.toHaveBeenCalled()
  })

  it('cancels a pending task externally, uses the cleanup deadline, and quarantines', async () => {
    vi.useFakeTimers()
    const runner = new TaskRunner({ cleanupTimeoutMs: 15 })
    const stuck = task('cancelled-stuck')
    stuck.timeoutMs = 1_000
    stuck.execute = vi.fn(() => new Promise<never>(() => {}))
    runner.register(stuck)
    const controller = new AbortController()
    const close = vi.fn(async () => {})
    const run = runner.runAll({
      page: { close } as unknown as Page,
      modelConfig: {},
      config: appConfigSchema.parse({}),
    }, [stuck.id], controller.signal)
    await vi.waitFor(() => expect(stuck.execute).toHaveBeenCalledOnce())

    controller.abort(new Error('shutdown requested'))
    await vi.advanceTimersByTimeAsync(15)

    await expect(run).rejects.toMatchObject({
      name: 'CancellationError',
      cause: expect.objectContaining({ message: 'shutdown requested' }),
    })
    expect(close).toHaveBeenCalledOnce()
    await expect(runner.runAll({
      page: {} as Page,
      modelConfig: {},
      config: appConfigSchema.parse({}),
    }, [stuck.id])).rejects.toMatchObject({ name: 'QuarantinedError' })
  })

  it('serializes direct runs so task side effects cannot overlap', async () => {
    const runner = new TaskRunner()
    const first = task('first')
    const second = task('second')
    let releaseFirst!: () => void
    const firstGate = new Promise<void>(resolve => releaseFirst = resolve)
    first.execute = vi.fn(async () => {
      await firstGate
      return {
        taskId: first.id,
        success: true,
        message: 'first done',
        durationMs: 0,
        completedAt: new Date(),
      }
    })
    second.execute = vi.fn(second.execute)
    runner.registerAll([first, second])
    const ctx = {
      page: {} as Page,
      modelConfig: {},
      config: appConfigSchema.parse({}),
    }

    const firstRun = runner.runAll(ctx, [first.id])
    const secondRun = runner.runAll(ctx, [second.id])
    await vi.waitFor(() => expect(first.execute).toHaveBeenCalledOnce())
    expect(second.execute).not.toHaveBeenCalled()

    releaseFirst()
    await firstRun
    await secondRun
    expect(second.execute).toHaveBeenCalledOnce()
  })

  it('propagates failure screenshot paths from step errors', async () => {
    const runner = new TaskRunner()
    const failed = task('failed-step')
    failed.execute = async () => {
      throw new StepExecutionError('step failed', 2, '/tmp/failure.png')
    }
    runner.register(failed)

    const result = await runner.runAll({
      page: {} as Page,
      modelConfig: {},
      config: appConfigSchema.parse({}),
    }, ['failed-step'])

    expect(result.results[0]).toMatchObject({
      success: false,
      screenshot: '/tmp/failure.png',
      error: { name: 'StepExecutionError' },
    })
  })

  it('normalizes non-Error task failures', async () => {
    const runner = new TaskRunner()
    const failed = task('plain-failure')
    failed.execute = async () => new Promise((_, reject) => {
      // eslint-disable-next-line prefer-promise-reject-errors
      reject('plain task failure')
    })
    runner.register(failed)

    const result = await runner.runAll({
      page: {} as Page,
      modelConfig: {},
      config: appConfigSchema.parse({}),
    }, ['plain-failure'])

    expect(result.results[0]).toMatchObject({
      success: false,
      error: { name: 'Error', message: 'plain task failure' },
    })
  })

  it('treats inaccessible pending-operation metadata as an ordinary task failure', async () => {
    const runner = new TaskRunner()
    const failed = task('hostile-timeout-metadata')
    const metadataError = new Error('pending metadata is inaccessible')
    const hostileError = new Proxy(metadataError, {
      getOwnPropertyDescriptor(target, property) {
        if (property === PENDING_OPERATION)
          throw new Error('metadata trap failed')
        return Reflect.getOwnPropertyDescriptor(target, property)
      },
    })
    failed.execute = vi.fn(async () => {
      throw hostileError
    })
    runner.register(failed)
    const close = vi.fn(async () => {})

    const result = await runner.runAll({
      page: { close } as unknown as Page,
      modelConfig: {},
      config: appConfigSchema.parse({}),
    }, [failed.id])

    expect(result.results[0]).toMatchObject({
      success: false,
      error: { name: 'Error', message: metadataError.message },
    })
    expect(close).not.toHaveBeenCalled()
    expect(failed.execute).toHaveBeenCalledOnce()
  })

  it('redacts and bounds successful result fields before observers receive them', async () => {
    const runner = new TaskRunner()
    const completed = task('bounded-result')
    completed.execute = async () => ({
      taskId: `Bearer task-secret ${'t'.repeat(500)}`,
      success: true,
      message: `apiKey=message-secret ${'m'.repeat(5_000)}`,
      durationMs: 1,
      completedAt: new Date(),
      screenshot: `/tmp/${'s'.repeat(5_000)}`,
      error: {
        name: `Bearer name-secret ${'n'.repeat(500)}`,
        message: `token=error-secret ${'e'.repeat(5_000)}`,
      },
    })
    runner.register(completed)
    const observed: TaskResult[] = []
    runner.on('task:complete', result => observed.push(result))

    const result = await runner.runAll({
      page: {} as Page,
      modelConfig: {},
      config: appConfigSchema.parse({}),
    }, [completed.id])

    const safe = result.results[0]!
    expect(observed[0]).toBe(safe)
    expect(safe.taskId).toHaveLength(256)
    expect(safe.message).toHaveLength(4_096)
    expect(safe.screenshot).toHaveLength(4_096)
    expect(safe.error?.name).toHaveLength(256)
    expect(safe.error?.message).toHaveLength(4_096)
    expect(JSON.stringify(safe)).not.toMatch(/task-secret|message-secret|name-secret|error-secret/)
  })

  it('emits task and run lifecycle events in execution order', async () => {
    const runner = new TaskRunner()
    runner.register(task('one'))
    const events: string[] = []
    runner.on('task:index', ({ taskId }) => events.push(`index:${taskId}`))
    runner.on('task:start', ({ taskId }) => events.push(`start:${taskId}`))
    runner.on('task:complete', result => events.push(`complete:${result.taskId}`))
    runner.on('run:complete', () => events.push('run:complete'))

    await runner.runAll({
      page: {} as Page,
      modelConfig: {},
      config: appConfigSchema.parse({}),
    }, ['one'])

    expect(events).toEqual(['index:one', 'start:one', 'complete:one', 'run:complete'])
  })

  it('does not let lifecycle listener failures turn completed work into a failed run', async () => {
    const runner = new TaskRunner()
    const completed = task('completed')
    completed.execute = vi.fn(completed.execute)
    runner.register(completed)
    const observerError = new Error('observer failed')
    for (const event of ['task:index', 'task:start', 'task:complete', 'run:complete'])
      runner.on(event, () => { throw observerError })

    await expect(runner.runAll({
      page: {} as Page,
      modelConfig: {},
      config: appConfigSchema.parse({}),
    }, [completed.id])).resolves.toMatchObject({
      results: [expect.objectContaining({ success: true })],
    })
    expect(completed.execute).toHaveBeenCalledOnce()
  })

  it('still completes when both an observer and observer-error logging throw', async () => {
    const runner = new TaskRunner()
    runner.register(task('completed'))
    runner.on('task:start', () => {
      throw new Error('observer failed')
    })
    vi.spyOn(logger, 'error').mockImplementation(() => {
      throw new Error('logger failed')
    })

    await expect(runner.runAll({
      page: {} as Page,
      modelConfig: {},
      config: appConfigSchema.parse({}),
    }, ['completed'])).resolves.toMatchObject({
      results: [expect.objectContaining({ success: true })],
    })
  })

  it('fail-fast stops all transitive dependents after an upstream failure', async () => {
    const runner = new TaskRunner()
    const root = task('root')
    root.execute = async () => ({
      taskId: 'root',
      success: false,
      message: 'root failed',
      durationMs: 0,
      completedAt: new Date(),
    })
    const middle = task('middle', ['root'])
    const leaf = task('leaf', ['middle'])
    middle.execute = vi.fn(middle.execute)
    leaf.execute = vi.fn(leaf.execute)
    runner.registerAll([root, middle, leaf])

    const result = await runner.runAll({
      page: {} as Page,
      modelConfig: {},
      config: appConfigSchema.parse({}),
    }, ['leaf'])

    expect(result.results.map(item => item.error?.name)).toEqual([
      'TaskError',
    ])
    expect(middle.execute).not.toHaveBeenCalled()
    expect(leaf.execute).not.toHaveBeenCalled()
  })
})
