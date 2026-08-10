import type { Gateway } from '../gateway/gateway.js'
import type { GatewaySnapshot } from '../gateway/types.js'
import type { RunResult } from '../tasks/task-runner.js'
import { EventEmitter } from 'node:events'
import process from 'node:process'
import { PassThrough, Writable } from 'node:stream'
import { render } from 'ink'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { logger } from '../utils/logger.js'
import { Dashboard } from './Dashboard.js'

const ANSI_PATTERN = new RegExp(`${String.fromCodePoint(27)}\\[[\\d;]*[a-z]`, 'gi')

interface MountedDashboard {
  output: () => string
  stdin: PassThrough
  state: EventEmitter
  runner: EventEmitter
  gateway: {
    enqueueRun: ReturnType<typeof vi.fn>
    shutdown: ReturnType<typeof vi.fn>
  }
  setSnapshot: (next: GatewaySnapshot) => void
  cleanup: () => void
}

function idleSnapshot(): GatewaySnapshot {
  return {
    running: false,
    currentRunId: null,
    currentTask: null,
    queueDepth: 0,
    lastRunAt: null,
    lastSuccess: null,
    phase: 'idle',
    taskIndex: 0,
    taskTotal: 0,
    currentStep: 0,
    elapsed: 0,
    currentAction: null,
    currentReason: null,
  }
}

function mountDashboard(shutdown: () => Promise<void> = async () => {}): MountedDashboard {
  let lastFrame = ''
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      lastFrame = String(chunk)
      callback()
    },
  }) as NodeJS.WriteStream
  Object.defineProperty(stdout, 'columns', { value: 160 })
  Object.defineProperty(stdout, 'rows', { value: 40 })

  const stdin = new PassThrough()
  Object.defineProperty(stdin, 'isTTY', { value: true })
  Object.defineProperty(stdin, 'setRawMode', { value: vi.fn() })
  Object.defineProperty(stdin, 'ref', { value: vi.fn() })
  Object.defineProperty(stdin, 'unref', { value: vi.fn() })

  const state = new EventEmitter()
  const runner = new EventEmitter()
  let snapshot = idleSnapshot()
  const gateway = {
    state,
    config: { schedule: { cron: '0 6 * * *', timezone: 'Asia/Shanghai' } },
    getSnapshot: vi.fn(() => snapshot),
    getTaskRunner: vi.fn(() => runner),
    enqueueRun: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn(shutdown),
  }

  const instance = render(<Dashboard gateway={gateway as unknown as Gateway} />, {
    stdout,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: stdout,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  })

  return {
    // Keep only Ink's current debug frame. Retaining every historical frame
    // made the 200+ log-boundary test measure buffer growth instead of the
    // dashboard behavior it is meant to verify.
    output: () => lastFrame.replace(ANSI_PATTERN, ''),
    stdin,
    state,
    runner,
    gateway,
    setSnapshot: (next) => {
      snapshot = next
      state.emit('change', next)
    },
    cleanup: () => {
      instance.unmount()
      instance.cleanup()
      stdin.destroy()
    },
  }
}

async function flush(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
}

describe('tUI dashboard', () => {
  afterEach(() => {
    logger.unmute()
  })

  it('renders state, run results, bounded logs, and removes subscriptions on unmount', async () => {
    const baselineLogs = logger.listenerCount('log')
    const mounted = mountDashboard()
    await flush()

    expect(mounted.output()).toContain('Genshin Impact Claw')
    expect(mounted.output()).toContain('Schedule: 0 6 * * * (Asia/Shanghai)')
    expect(mounted.output()).toContain('○ Idle')

    mounted.setSnapshot({
      ...idleSnapshot(),
      running: true,
      phase: 'running',
      currentRunId: 'run-1',
      currentTask: 'claim-mail',
      taskIndex: 1,
      taskTotal: 2,
      currentStep: 3,
      elapsed: 2_000,
      currentAction: 'tap',
      currentReason: 'claim',
      queueDepth: 2,
    })
    const time = new Date('2026-08-07T01:00:00.000Z')
    const result: RunResult = {
      startedAt: time,
      completedAt: time,
      results: [{ taskId: 'claim-mail', success: true, message: 'done', durationMs: 100, completedAt: time }],
    }
    mounted.runner.emit('run:complete', result)
    for (let index = 0; index <= 200; index++) {
      logger.emit('log', {
        timestamp: time.toISOString(),
        level: 'info',
        message: `dashboard-log-${index}`,
        args: [],
      })
    }
    await flush()

    expect(mounted.output()).toContain('● Running')
    expect(mounted.output()).toContain('Queue: 2')
    expect(mounted.output()).toContain('Last Run')
    expect(mounted.output()).toContain('dashboard-log-200')
    expect(mounted.output()).not.toContain('dashboard-log-0')
    expect(mounted.state.listenerCount('change')).toBe(1)
    expect(mounted.runner.listenerCount('run:complete')).toBe(1)
    expect(logger.listenerCount('log')).toBe(baselineLogs + 1)

    mounted.cleanup()
    await flush()
    expect(mounted.state.listenerCount('change')).toBe(0)
    expect(mounted.runner.listenerCount('run:complete')).toBe(0)
    expect(logger.listenerCount('log')).toBe(baselineLogs)
  })

  it('handles run, scroll, and clear keyboard controls', async () => {
    const mounted = mountDashboard()
    await flush()
    const time = new Date('2026-08-07T01:00:00.000Z').toISOString()
    for (let index = 0; index < 20; index++) {
      logger.emit('log', { timestamp: time, level: 'info', message: `log-${index}`, args: [] })
    }
    await flush()

    mounted.stdin.write('\u001B[A')
    await flush()
    expect(mounted.output()).toContain('(5-19/20) ↑ ↓')
    expect(mounted.output()).toContain('log-4')
    expect(mounted.output()).not.toContain('log-19')

    mounted.stdin.write('\u001B[B')
    await flush()
    expect(mounted.output()).toContain('(6-20/20) ↑')
    expect(mounted.output()).toContain('log-19')

    mounted.stdin.write('r')
    await flush()
    expect(mounted.gateway.enqueueRun).toHaveBeenCalledWith('manual')

    mounted.setSnapshot({ ...idleSnapshot(), running: true, phase: 'running' })
    await flush()
    mounted.stdin.write('r')
    await flush()
    mounted.stdin.write('c')
    await flush()
    expect(mounted.gateway.enqueueRun).toHaveBeenCalledOnce()
    expect(mounted.output()).toContain('No logs')
    expect(mounted.output()).not.toContain('log-19')

    mounted.cleanup()
    await flush()
  })

  it.each([
    [async () => {}, 0],
    [async () => { throw new Error('shutdown failed') }, 1],
  ])('exits with the expected status after quit %#', async (shutdown, status) => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const unmute = vi.spyOn(logger, 'unmute')
    const mounted = mountDashboard(shutdown)
    await flush()

    mounted.stdin.write('q')
    await vi.waitFor(() => expect(mounted.gateway.shutdown).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(status))

    expect(unmute).toHaveBeenCalled()
    mounted.cleanup()
  })
})
