import type { Page } from 'playwright'
import type { AppConfig } from '../config/schema.js'
import type { RunResult } from '../tasks/task-runner.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loginFlow } from '../browser/login.js'
import { SessionManager } from '../browser/session-manager.js'
import { appConfigSchema } from '../config/schema.js'
import { enforceArtifactRetention } from '../memory/artifact-retention.js'
import { StateStore } from '../memory/state-store.js'
import { TaskRunner } from '../tasks/task-runner.js'
import { QuarantinedError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'
import { Gateway } from './gateway.js'
import { Scheduler } from './scheduler.js'

vi.mock('../browser/login.js', () => ({
  loginFlow: vi.fn(),
}))

vi.mock('../memory/artifact-retention.js', () => ({
  enforceArtifactRetention: vi.fn(),
}))

const startedAt = new Date('2026-08-07T01:00:00.000Z')
const completedAt = new Date('2026-08-07T01:00:02.000Z')

function createConfig(model: Partial<AppConfig['model']> = {}): AppConfig {
  return appConfigSchema.parse({
    model: {
      name: 'test-model',
      baseUrl: 'https://example.test/v1',
      apiKey: 'test-key',
      family: 'openai',
      stream: true,
      ...model,
    },
    tasks: {
      enabled: ['welkin-moon'],
      skillsDirs: ['./skills'],
    },
    memory: {
      dataDir: '/tmp/giclaw-gateway-test',
      maxHistory: 5,
    },
  })
}

function successfulResult(success = true): RunResult {
  return {
    startedAt,
    completedAt,
    results: [{
      taskId: 'welkin-moon',
      success,
      message: success ? 'done' : 'failed',
      durationMs: 2_000,
      completedAt,
    }],
  }
}

function abortActiveRun(gateway: Gateway, reason: Error): void {
  const controllers = (gateway as unknown as {
    activeControllers: Map<string, AbortController>
  }).activeControllers
  const controller = controllers.values().next().value
  if (!controller)
    throw new Error('Expected an active Gateway run controller')
  controller.abort(reason)
}

describe('gateway execution pipeline', () => {
  beforeEach(() => {
    vi.mocked(loginFlow).mockResolvedValue()
    vi.mocked(enforceArtifactRetention).mockResolvedValue({
      deleted: [],
      retainedFiles: 0,
      retainedBytes: 0,
    })
    vi.spyOn(SessionManager.prototype, 'getPage').mockReturnValue({} as Page)
    vi.spyOn(SessionManager.prototype, 'close').mockResolvedValue()
    vi.spyOn(StateStore.prototype, 'updateAfterRun').mockResolvedValue()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs tasks, forwards progress, persists a summary, and closes the session', async () => {
    const result = successfulResult()
    const runAll = vi.spyOn(TaskRunner.prototype, 'runAll').mockImplementation(async (context) => {
      context.onProgress?.(3, 500, 'tap reward', 'claim it')
      return result
    })
    const persist = vi.spyOn(StateStore.prototype, 'updateAfterRun')
    const close = vi.spyOn(SessionManager.prototype, 'close')
    const gateway = new Gateway(createConfig())
    const phases: string[] = []
    const completed: unknown[][] = []
    gateway.state.on('progress', event => phases.push(event.phase))
    gateway.state.on('run:complete', (...args) => completed.push(args))

    await expect(gateway.runOnce()).resolves.toBe(result)

    expect(loginFlow).toHaveBeenCalledOnce()
    expect(runAll).toHaveBeenCalledOnce()
    expect(runAll.mock.calls[0]?.[0]).toMatchObject({
      page: {},
      streamModelResponses: true,
      screenshotDir: '/tmp/giclaw-gateway-test/screenshots',
    })
    expect(runAll.mock.calls[0]?.[1]).toEqual(['welkin-moon'])
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({
      trigger: 'manual',
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      results: [{
        taskId: 'welkin-moon',
        success: true,
        message: 'done',
        durationMs: 2_000,
      }],
    }))
    expect(enforceArtifactRetention).toHaveBeenCalledTimes(2)
    expect(enforceArtifactRetention).toHaveBeenCalledWith(
      [
        '/tmp/giclaw-gateway-test/transcripts',
        '/tmp/giclaw-gateway-test/screenshots',
      ],
      { maxFiles: 1_000, maxBytes: 1024 * 1024 * 1024 },
    )
    expect(phases).toEqual(['login', 'running', 'running', 'done'])
    expect(completed).toHaveLength(1)
    expect(completed[0]?.[1]).toBe(result)
    expect(gateway.getSnapshot()).toMatchObject({
      running: false,
      currentRunId: null,
      lastRunAt: completedAt.toISOString(),
      lastSuccess: true,
      phase: 'done',
      currentStep: 0,
      currentAction: null,
      currentReason: null,
    })
    expect(close).toHaveBeenCalledOnce()
  })

  it('redacts action and reason before state and progress observers receive them', async () => {
    const result = successfulResult()
    vi.spyOn(TaskRunner.prototype, 'runAll').mockImplementation(async (context) => {
      context.onProgress?.(
        1,
        10,
        'POST authorization=Bearer action-secret',
        'apiKey=reason-secret sk-123456789012',
      )
      return result
    })
    const gateway = new Gateway(createConfig())
    const snapshots: Array<{ currentAction: string | null, currentReason: string | null }> = []
    const stateProgress: Array<{ action: string | null, reason: string | null }> = []
    const loggerProgress: Array<{ action: string | null, reason: string | null }> = []
    const onLoggerProgress = (event: { action: string | null, reason: string | null }) => {
      loggerProgress.push(event)
    }
    gateway.state.on('change', snapshot => snapshots.push(snapshot))
    gateway.state.on('progress', event => stateProgress.push(event))
    logger.on('progress', onLoggerProgress)

    try {
      await gateway.runOnce()
    }
    finally {
      logger.off('progress', onLoggerProgress)
    }

    expect(snapshots).toContainEqual(expect.objectContaining({
      currentAction: 'POST authorization=[REDACTED]',
      currentReason: 'apiKey=[REDACTED] [REDACTED]',
    }))
    expect(stateProgress).toContainEqual(expect.objectContaining({
      action: 'POST authorization=[REDACTED]',
      reason: 'apiKey=[REDACTED] [REDACTED]',
    }))
    expect(loggerProgress).toContainEqual(expect.objectContaining({
      action: 'POST authorization=[REDACTED]',
      reason: 'apiKey=[REDACTED] [REDACTED]',
    }))
    const serialized = JSON.stringify({ snapshots, stateProgress, loggerProgress })
    expect(serialized).not.toMatch(/action-secret|reason-secret|sk-123/)
  })

  it('fails before login when artifact retention cannot establish a safe boundary', async () => {
    const retentionError = new Error('unsafe artifact directory')
    vi.mocked(enforceArtifactRetention).mockRejectedValueOnce(retentionError)
    const runAll = vi.spyOn(TaskRunner.prototype, 'runAll')
    const gateway = new Gateway(createConfig())

    await expect(gateway.runOnce()).rejects.toBe(retentionError)

    expect(loginFlow).not.toHaveBeenCalled()
    expect(runAll).not.toHaveBeenCalled()
    expect(StateStore.prototype.updateAfterRun).not.toHaveBeenCalled()
  })

  it('reports completed browser work accurately when post-run retention fails', async () => {
    const result = successfulResult()
    const retentionError = new Error('artifact cleanup failed')
    vi.spyOn(TaskRunner.prototype, 'runAll').mockResolvedValue(result)
    vi.mocked(enforceArtifactRetention)
      .mockResolvedValueOnce({
        deleted: [],
        retainedFiles: 0,
        retainedBytes: 0,
      })
      .mockRejectedValueOnce(retentionError)
    const persist = vi.spyOn(StateStore.prototype, 'updateAfterRun')
    const gateway = new Gateway(createConfig())

    await expect(gateway.runOnce()).resolves.toBe(result)

    expect(SessionManager.prototype.close).toHaveBeenCalledOnce()
    expect(persist).toHaveBeenCalledOnce()
    expect(gateway.getSnapshot()).toMatchObject({
      running: false,
      phase: 'done',
      lastSuccess: true,
    })
  })

  it('does not label completed browser work as failed when history persistence fails', async () => {
    const result = successfulResult()
    const persistenceError = new Error('state disk unavailable')
    vi.spyOn(TaskRunner.prototype, 'runAll').mockResolvedValue(result)
    vi.spyOn(StateStore.prototype, 'updateAfterRun').mockRejectedValue(persistenceError)
    const gateway = new Gateway(createConfig())

    await expect(gateway.runOnce()).resolves.toBe(result)

    expect(SessionManager.prototype.close).toHaveBeenCalledOnce()
    expect(gateway.getSnapshot()).toMatchObject({
      running: false,
      phase: 'done',
      lastSuccess: true,
    })
  })

  it('uses explicitly requested tasks and records an unsuccessful task run', async () => {
    const runAll = vi.spyOn(TaskRunner.prototype, 'runAll').mockResolvedValue(successfulResult(false))
    const gateway = new Gateway(createConfig())

    await gateway.runOnce(['claim-mail'])

    expect(runAll.mock.calls[0]?.[1]).toEqual(['claim-mail'])
    expect(gateway.getSnapshot()).toMatchObject({
      phase: 'done',
      lastSuccess: false,
    })
  })

  it('runs API requests through the queue and preserves the trigger in history', async () => {
    const result = successfulResult()
    vi.spyOn(TaskRunner.prototype, 'runAll').mockResolvedValue(result)
    const persist = vi.spyOn(StateStore.prototype, 'updateAfterRun')
    const gateway = new Gateway(createConfig())

    await expect(gateway.enqueueRun('api', ['claim-mail'])).resolves.toBe(result)

    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'api' }))
    expect(gateway.getSnapshot().queueDepth).toBe(0)
  })

  it('serializes manual runOnce pipelines through the same queue', async () => {
    let releaseFirst!: () => void
    const firstResult = new Promise<RunResult>((resolve) => {
      releaseFirst = () => resolve(successfulResult())
    })
    const runAll = vi.spyOn(TaskRunner.prototype, 'runAll')
      .mockReturnValueOnce(firstResult)
      .mockResolvedValueOnce(successfulResult())
    const gateway = new Gateway(createConfig())

    const first = gateway.runOnce(['first'])
    const second = gateway.runOnce(['second'])
    await vi.waitFor(() => expect(runAll).toHaveBeenCalledOnce())
    expect(loginFlow).toHaveBeenCalledOnce()

    releaseFirst()
    await first
    await second

    expect(runAll).toHaveBeenCalledTimes(2)
    expect(runAll.mock.calls[0]?.[1]).toEqual(['first'])
    expect(runAll.mock.calls[1]?.[1]).toEqual(['second'])
    expect(loginFlow).toHaveBeenCalledTimes(2)
  })

  it('honors cancellation immediately after pre-run artifact retention', async () => {
    const reason = new Error('shutdown after retention')
    const gateway = new Gateway(createConfig())
    vi.mocked(enforceArtifactRetention).mockImplementationOnce(async () => {
      abortActiveRun(gateway, reason)
      return { deleted: [], retainedFiles: 0, retainedBytes: 0 }
    })

    await expect(gateway.runOnce()).rejects.toMatchObject({
      name: 'CancellationError',
      cause: reason,
    })

    expect(loginFlow).not.toHaveBeenCalled()
  })

  it('honors cancellation immediately after login completes', async () => {
    const reason = new Error('shutdown after login')
    const gateway = new Gateway(createConfig())
    vi.mocked(loginFlow).mockImplementationOnce(async () => {
      abortActiveRun(gateway, reason)
    })
    const runAll = vi.spyOn(TaskRunner.prototype, 'runAll')

    await expect(gateway.runOnce()).rejects.toMatchObject({
      name: 'CancellationError',
      cause: reason,
    })

    expect(runAll).not.toHaveBeenCalled()
  })

  it('preserves a completed task result when cancellation arrives at the commit point', async () => {
    const reason = new Error('shutdown after tasks')
    const gateway = new Gateway(createConfig())
    vi.spyOn(TaskRunner.prototype, 'runAll').mockImplementationOnce(async () => {
      abortActiveRun(gateway, reason)
      return successfulResult()
    })
    const persist = vi.spyOn(StateStore.prototype, 'updateAfterRun')

    await expect(gateway.runOnce()).resolves.toEqual(successfulResult())

    expect(persist).toHaveBeenCalledOnce()
    expect(gateway.getSnapshot()).toMatchObject({ phase: 'done', lastSuccess: true })
  })

  it('preserves a completed task result when cancellation arrives during browser close', async () => {
    const reason = new Error('shutdown during browser close')
    const gateway = new Gateway(createConfig())
    vi.spyOn(TaskRunner.prototype, 'runAll').mockResolvedValue(successfulResult())
    vi.spyOn(SessionManager.prototype, 'close').mockImplementationOnce(async () => {
      abortActiveRun(gateway, reason)
    })
    const persist = vi.spyOn(StateStore.prototype, 'updateAfterRun')

    await expect(gateway.runOnce()).resolves.toEqual(successfulResult())

    expect(persist).toHaveBeenCalledOnce()
    expect(gateway.getSnapshot()).toMatchObject({ phase: 'done', lastSuccess: true })
  })

  it('shutdown closes intake and cancels a pending login', async () => {
    vi.mocked(loginFlow).mockImplementation(async (_session, _config, signal) => {
      await new Promise<never>((_, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    const close = vi.spyOn(SessionManager.prototype, 'close')
    const gateway = new Gateway(createConfig())
    const run = gateway.runOnce()
    const runRejection = expect(run).rejects.toMatchObject({ name: 'CancellationError' })
    await vi.waitFor(() => expect(loginFlow).toHaveBeenCalledOnce())

    const firstShutdown = gateway.shutdown()
    const secondShutdown = gateway.shutdown()
    expect(secondShutdown).toBe(firstShutdown)
    await firstShutdown
    await runRejection

    expect(close).toHaveBeenCalled()
    await expect(gateway.runOnce()).rejects.toThrow('Queue is closed')
  })

  it('shutdown has a deadline even if active login code ignores cancellation', async () => {
    vi.useFakeTimers()
    vi.mocked(loginFlow).mockImplementation(() => new Promise<void>(() => {}))
    const gateway = new Gateway(createConfig())
    const run = gateway.runOnce()
    void run.catch(() => {})
    await vi.waitFor(() => expect(loginFlow).toHaveBeenCalledOnce())

    const shutdown = gateway.shutdown()
    const shutdownRejection = expect(shutdown).rejects.toMatchObject({
      name: 'AggregateError',
      message: 'Gateway shutdown did not complete cleanly',
    })
    await vi.advanceTimersByTimeAsync(7_000)

    await shutdownRejection
    await expect(gateway.enqueueRun('api')).rejects.toThrow('Queue is closed')
  })

  it('reports session cleanup rejection during shutdown', async () => {
    const cleanupError = new Error('session close failed')
    const gateway = new Gateway(createConfig())
    const sessions = (gateway as unknown as {
      activeSessions: Set<{ close: () => Promise<void> }>
    }).activeSessions
    sessions.add({ close: vi.fn().mockRejectedValue(cleanupError) })

    await expect(gateway.shutdown()).rejects.toMatchObject({
      name: 'AggregateError',
      errors: expect.arrayContaining([cleanupError]),
    })
  })

  it('bounds a session cleanup operation that never settles', async () => {
    vi.useFakeTimers()
    const gateway = new Gateway(createConfig())
    const sessions = (gateway as unknown as {
      activeSessions: Set<{ close: () => Promise<void> }>
    }).activeSessions
    sessions.add({ close: vi.fn(() => new Promise<void>(() => {})) })

    const shutdown = gateway.shutdown()
    const rejection = expect(shutdown).rejects.toMatchObject({
      name: 'AggregateError',
      errors: expect.arrayContaining([
        expect.objectContaining({ name: 'TimeoutError' }),
      ]),
    })
    await vi.advanceTimersByTimeAsync(7_000)

    await rejection
  })

  it('continues shutdown after scheduler, queue, and abort cleanup throw', async () => {
    vi.spyOn(Scheduler.prototype, 'start').mockImplementation(() => {})
    const schedulerError = new Error('scheduler stop failed')
    vi.spyOn(Scheduler.prototype, 'stop').mockRejectedValue(schedulerError)
    const gateway = new Gateway(createConfig())
    await gateway.start()
    const queueError = new Error('queue close failed')
    const internals = gateway as unknown as {
      queue: { close: () => void }
      activeControllers: Map<string, { abort: () => void }>
    }
    vi.spyOn(internals.queue, 'close').mockImplementation(() => {
      throw queueError
    })
    const abortError = new Error('abort failed')
    internals.activeControllers.set('broken', {
      abort: () => {
        throw abortError
      },
    })

    await expect(gateway.shutdown()).rejects.toMatchObject({
      name: 'AggregateError',
      errors: expect.arrayContaining([schedulerError, queueError, abortError]),
    })
  })

  it('keeps gateway state synchronized with task and queue events', () => {
    const gateway = new Gateway(createConfig())
    const runner = gateway.getTaskRunner()
    const queue = (gateway as unknown as { queue: { emit: (event: string) => void } }).queue

    runner.emit('task:start', { taskId: 'claim-mail' })
    runner.emit('task:index', { taskIndex: 2, taskTotal: 5, taskId: 'claim-mail' })
    expect(gateway.getSnapshot()).toMatchObject({
      currentTask: 'claim-mail',
      taskIndex: 2,
      taskTotal: 5,
    })

    runner.emit('task:complete', successfulResult().results[0])
    expect(gateway.getSnapshot()).toMatchObject({
      currentTask: null,
      currentStep: 0,
      currentAction: null,
      currentReason: null,
    })

    gateway.state.update({ queueDepth: 99 })
    queue.emit('error')
    expect(gateway.getSnapshot().queueDepth).toBe(0)
  })

  it('closes queue admission immediately when the task runner is quarantined', async () => {
    const gateway = new Gateway(createConfig())
    const quarantine = new QuarantinedError('unsafe stopped attempt')

    gateway.getTaskRunner().emit('quarantine', quarantine)

    await expect(gateway.runOnce()).rejects.toMatchObject({
      name: 'QueueError',
      cause: quarantine,
    })
    expect(loginFlow).not.toHaveBeenCalled()
  })

  it('reports a scheduler stop failure triggered by task runner quarantine', async () => {
    const schedulerError = new Error('quarantine scheduler stop failed')
    vi.spyOn(Scheduler.prototype, 'start').mockImplementation(() => {})
    const stop = vi.spyOn(Scheduler.prototype, 'stop').mockRejectedValue(schedulerError)
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const gateway = new Gateway(createConfig())
    await gateway.start()

    gateway.getTaskRunner().emit(
      'quarantine',
      new QuarantinedError('unsafe stopped attempt'),
    )
    await vi.waitFor(() => {
      expect(warning).toHaveBeenCalledWith(
        'Could not stop scheduler after task runner quarantine',
        schedulerError,
      )
    })

    expect(stop).toHaveBeenCalledOnce()
  })

  it('sets error state, emits the normalized error, and still closes the session', async () => {
    vi.mocked(loginFlow).mockRejectedValue('login unavailable')
    const close = vi.spyOn(SessionManager.prototype, 'close')
    const gateway = new Gateway(createConfig())
    const errors: Error[] = []
    const progressReasons: Array<string | null> = []
    gateway.state.on('run:error', (_runId, error) => errors.push(error))
    gateway.state.on('progress', event => progressReasons.push(event.reason))

    await expect(gateway.runOnce()).rejects.toThrow('login unavailable')

    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ name: 'Error', message: 'login unavailable' })
    expect(progressReasons.at(-1)).toBe('login unavailable')
    expect(gateway.getSnapshot()).toMatchObject({
      running: false,
      currentRunId: null,
      phase: 'error',
      currentReason: 'login unavailable',
    })
    expect(close).toHaveBeenCalledOnce()
  })

  it('redacts error text in state and observer events without replacing the caller error', async () => {
    const original = new Error('Bearer login-secret apiKey=query-secret sk-123456789012')
    vi.mocked(loginFlow).mockRejectedValue(original)
    const gateway = new Gateway(createConfig())
    const observedErrors: Error[] = []
    const progressReasons: Array<string | null> = []
    gateway.state.on('run:error', (_runId, error) => observedErrors.push(error))
    gateway.state.on('progress', event => progressReasons.push(event.reason))

    await expect(gateway.runOnce()).rejects.toBe(original)

    expect(gateway.getSnapshot().currentReason).toBe(
      'Bearer [REDACTED] apiKey=[REDACTED] [REDACTED]',
    )
    expect(progressReasons.at(-1)).toBe(
      'Bearer [REDACTED] apiKey=[REDACTED] [REDACTED]',
    )
    expect(observedErrors).toHaveLength(1)
    expect(observedErrors[0]).not.toBe(original)
    expect(observedErrors[0]?.message).toBe(
      'Bearer [REDACTED] apiKey=[REDACTED] [REDACTED]',
    )
    expect(observedErrors[0]?.stack).not.toMatch(/login-secret|query-secret|sk-123/)
  })

  it('does not report or persist success when its browser cannot be closed', async () => {
    const result = successfulResult()
    vi.spyOn(TaskRunner.prototype, 'runAll').mockResolvedValue(result)
    const cleanupError = new Error('close failed')
    vi.spyOn(SessionManager.prototype, 'close').mockRejectedValue(cleanupError)
    const persist = vi.spyOn(StateStore.prototype, 'updateAfterRun')
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const gateway = new Gateway(createConfig())

    await expect(gateway.runOnce()).rejects.toBe(cleanupError)

    expect(persist).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(
      'Gateway stopped accepting work because a browser session could not be closed safely',
      cleanupError,
    )
    await expect(gateway.runOnce()).rejects.toMatchObject({
      name: 'QueueError',
      cause: expect.objectContaining({ name: 'QuarantinedError' }),
    })
  })

  it('preserves the pipeline error when session cleanup also fails', async () => {
    const pipelineError = new Error('login failed')
    const cleanupError = new Error('close failed')
    vi.mocked(loginFlow).mockRejectedValue(pipelineError)
    vi.spyOn(SessionManager.prototype, 'close').mockRejectedValue(cleanupError)
    const logError = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const gateway = new Gateway(createConfig())
    const emitted: Error[] = []
    gateway.state.on('run:error', (_runId, error) => emitted.push(error))

    await expect(gateway.runOnce()).rejects.toBe(pipelineError)

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).not.toBe(pipelineError)
    expect(emitted[0]).toMatchObject({
      name: 'Error',
      message: 'login failed',
    })
    expect(logError).toHaveBeenCalledWith(
      'Gateway stopped accepting work because a browser session could not be closed safely',
      cleanupError,
    )
  })

  it('stops an active scheduler and quarantines intake when failed-run cleanup is unsafe', async () => {
    const pipelineError = new Error('login failed')
    const cleanupError = new Error('close failed')
    vi.mocked(loginFlow).mockRejectedValue(pipelineError)
    vi.spyOn(SessionManager.prototype, 'close').mockRejectedValue(cleanupError)
    vi.spyOn(Scheduler.prototype, 'start').mockImplementation(() => {})
    const stop = vi.spyOn(Scheduler.prototype, 'stop').mockResolvedValue()
    vi.spyOn(logger, 'error').mockImplementation(() => {})
    const gateway = new Gateway(createConfig())
    await gateway.start()

    await expect(gateway.runOnce()).rejects.toBe(pipelineError)

    expect(stop).toHaveBeenCalledOnce()
    await expect(gateway.runOnce()).rejects.toMatchObject({
      name: 'QueueError',
      cause: expect.objectContaining({
        name: 'QuarantinedError',
        cause: cleanupError,
      }),
    })
  })

  it('preserves the pipeline error and quarantines intake when scheduler stop also fails', async () => {
    const pipelineError = new Error('login failed')
    const cleanupError = new Error('close failed')
    const schedulerError = new Error('scheduler stop failed')
    vi.mocked(loginFlow).mockRejectedValue(pipelineError)
    vi.spyOn(SessionManager.prototype, 'close').mockRejectedValue(cleanupError)
    vi.spyOn(Scheduler.prototype, 'start').mockImplementation(() => {})
    vi.spyOn(Scheduler.prototype, 'stop').mockRejectedValue(schedulerError)
    vi.spyOn(logger, 'error').mockImplementation(() => {})
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const gateway = new Gateway(createConfig())
    await gateway.start()

    await expect(gateway.runOnce()).rejects.toBe(pipelineError)

    expect(warning).toHaveBeenCalledWith(
      'Could not stop scheduler after unsafe session cleanup',
      schedulerError,
    )
    await expect(gateway.runOnce()).rejects.toMatchObject({
      name: 'QueueError',
      cause: expect.objectContaining({ name: 'QuarantinedError' }),
    })
  })

  it.each([
    ['gemini', 'gemini-pro', 'gemini'],
    ['qwen-vl', 'qwen-vl-max', 'qwen2.5-vl'],
    ['qwen', 'qwen-vl-max', 'qwen2.5-vl'],
    ['doubao', 'doubao-vision', 'doubao-vision'],
    ['gpt-5', 'gpt-5.6', 'gpt-5'],
    ['openai', 'gpt-5.6', 'gpt-5'],
  ])('maps %s/%s to the Midscene family %s', async (family, name, expectedFamily) => {
    const runAll = vi.spyOn(TaskRunner.prototype, 'runAll').mockResolvedValue(successfulResult())

    await new Gateway(createConfig({ family, name })).runOnce()

    expect(runAll.mock.calls[0]?.[0].modelConfig).toEqual({
      MIDSCENE_MODEL_NAME: name,
      MIDSCENE_MODEL_BASE_URL: 'https://example.test/v1',
      MIDSCENE_MODEL_API_KEY: 'test-key',
      MIDSCENE_MODEL_FAMILY: expectedFamily,
    })
  })

  it('leaves the Midscene family unset for a generic OpenAI-compatible model', async () => {
    const runAll = vi.spyOn(TaskRunner.prototype, 'runAll').mockResolvedValue(successfulResult())

    await new Gateway(createConfig({ family: 'openai', name: 'other-model' })).runOnce()

    expect(runAll.mock.calls[0]?.[0].modelConfig).not.toHaveProperty('MIDSCENE_MODEL_FAMILY')
  })

  it('delegates history reads to the state store', async () => {
    const history = [{
      runId: 'run-1',
      trigger: 'api' as const,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      results: [],
    }]
    const getHistory = vi.spyOn(StateStore.prototype, 'getHistory').mockResolvedValue(history)
    const gateway = new Gateway(createConfig())

    await expect(gateway.getRunHistory(3)).resolves.toBe(history)
    expect(getHistory).toHaveBeenCalledWith(3)
  })

  it('starts and stops daemon scheduling', async () => {
    const start = vi.spyOn(Scheduler.prototype, 'start').mockImplementation(() => {})
    const stop = vi.spyOn(Scheduler.prototype, 'stop').mockResolvedValue()
    const gateway = new Gateway(createConfig())

    await gateway.start()
    await gateway.shutdown()

    expect(start).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('rejects duplicate starts instead of leaking an older scheduler', async () => {
    const start = vi.spyOn(Scheduler.prototype, 'start').mockImplementation(() => {})
    const gateway = new Gateway(createConfig())

    await gateway.start()
    await expect(gateway.start()).rejects.toThrow('already started')

    expect(start).toHaveBeenCalledOnce()
    await gateway.shutdown()
  })

  it('rolls back a scheduler whose startup throws', async () => {
    const startupError = new Error('invalid schedule')
    vi.spyOn(Scheduler.prototype, 'start').mockImplementation(() => {
      throw startupError
    })
    const stop = vi.spyOn(Scheduler.prototype, 'stop').mockResolvedValue()
    const gateway = new Gateway(createConfig())

    await expect(gateway.start()).rejects.toBe(startupError)

    expect(stop).toHaveBeenCalledOnce()
  })

  it('preserves scheduler startup failure when rollback also fails', async () => {
    const startupError = new Error('invalid schedule')
    const rollbackError = new Error('rollback failed')
    vi.spyOn(Scheduler.prototype, 'start').mockImplementation(() => {
      throw startupError
    })
    vi.spyOn(Scheduler.prototype, 'stop').mockRejectedValue(rollbackError)
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    await expect(new Gateway(createConfig()).start()).rejects.toBe(startupError)

    expect(warning).toHaveBeenCalledWith(
      'Could not roll back scheduler after startup failure',
      rollbackError,
    )
  })

  it('does not restart after shutdown has begun', async () => {
    vi.spyOn(Scheduler.prototype, 'start').mockImplementation(() => {})
    vi.spyOn(Scheduler.prototype, 'stop').mockResolvedValue()
    const gateway = new Gateway(createConfig())
    await gateway.start()
    await gateway.shutdown()

    await expect(gateway.start()).rejects.toThrow('after shutdown has begun')
  })

  it('enqueues cron ticks and reports asynchronous cron failures', async () => {
    vi.spyOn(Scheduler.prototype, 'start').mockImplementation(() => {})
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {})
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const gateway = new Gateway(createConfig())
    const enqueue = vi.spyOn(gateway, 'enqueueRun').mockResolvedValue(successfulResult())
    await gateway.start()
    const scheduler = (gateway as unknown as { scheduler: { onTick: () => void } }).scheduler

    scheduler.onTick()
    expect(enqueue).toHaveBeenCalledWith('cron')
    expect(info).toHaveBeenCalledWith('Cron triggered — starting task run')

    enqueue.mockRejectedValueOnce(new Error('cron failed'))
    scheduler.onTick()
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(
      'Cron run failed',
      expect.objectContaining({ message: 'cron failed' }),
    ))
  })
})
