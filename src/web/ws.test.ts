import type { FastifyInstance } from 'fastify'
import type { Gateway } from '../gateway/gateway.js'
import type { ProgressEvent } from '../utils/progress.js'
import type { WebSocketLimits } from './ws.js'
import { EventEmitter } from 'node:events'
import fastifyWebSocket from '@fastify/websocket'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logger } from '../utils/logger.js'
import { registerWebSocket } from './ws.js'

class TestSocket extends EventEmitter {
  readonly OPEN = 1
  readyState = this.OPEN
  bufferedAmount = 0
  send = vi.fn<(message: string, callback?: (error?: Error) => void) => void>()
  terminate = vi.fn()
}

interface TestRegistration {
  connect: (socket: TestSocket) => void
  closeServer: () => void
}

function setup(
  snapshot = { running: false },
  limits: Partial<WebSocketLimits> = {},
): TestRegistration {
  let connect: ((socket: TestSocket) => void) | undefined
  let onClose: ((_instance: unknown, done: () => void) => void) | undefined
  const scopedApp = {
    get: vi.fn((_path: string, _options: unknown, handler: (socket: TestSocket) => void) => {
      connect = handler
    }),
  }
  const app = {
    addHook: vi.fn((_name: string, handler: (_instance: unknown, done: () => void) => void) => {
      onClose = handler
    }),
    register: vi.fn((plugin: (instance: typeof scopedApp) => Promise<void>) => plugin(scopedApp)),
  }
  const gateway = {
    getSnapshot: vi.fn(() => snapshot),
  }

  registerWebSocket(app as unknown as FastifyInstance, gateway as unknown as Gateway, limits)

  if (!connect || !onClose)
    throw new Error('WebSocket route was not registered')

  return {
    connect,
    closeServer: () => onClose?.(app, () => {}),
  }
}

function messages(socket: TestSocket): Array<{ type: string, data: unknown }> {
  return socket.send.mock.calls.map(([message]) => JSON.parse(message) as { type: string, data: unknown })
}

describe('webSocket transport', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    logger.setLevel('info')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends a snapshot, forwards logs and progress, heartbeats, and cleans up listeners', () => {
    const baselineLogs = logger.listenerCount('log')
    const baselineProgress = logger.listenerCount('progress')
    const registration = setup({ running: true })
    const socket = new TestSocket()
    registration.connect(socket)

    const progress: ProgressEvent = {
      phase: 'running',
      taskIndex: 1,
      taskTotal: 2,
      taskId: 'claim-mail',
      step: 3,
      elapsed: 250,
      action: 'tap',
      reason: 'claim',
      timestamp: '2026-08-07T01:00:00.000Z',
    }
    logger.emit('log', {
      timestamp: '2026-08-07T01:00:00.000Z',
      level: 'info',
      message: 'live log',
      args: [],
    })
    logger.emitProgress(progress)
    vi.advanceTimersByTime(30_000)

    expect(messages(socket)).toEqual([
      { type: 'snapshot', data: { running: true } },
      { type: 'log', data: expect.objectContaining({ message: 'live log' }) },
      { type: 'progress', data: progress },
      { type: 'status', data: { alive: true } },
    ])

    socket.emit('close')
    const sentAtClose = socket.send.mock.calls.length
    logger.emit('log', {
      timestamp: '2026-08-07T01:00:01.000Z',
      level: 'info',
      message: 'after close',
      args: [],
    })
    logger.emitProgress(progress)
    vi.advanceTimersByTime(30_000)
    expect(socket.send).toHaveBeenCalledTimes(sentAtClose)
    expect(logger.listenerCount('progress')).toBe(baselineProgress)

    registration.closeServer()
    expect(logger.listenerCount('log')).toBe(baselineLogs)
  })

  it('replays only the newest 500 buffered log entries', () => {
    const registration = setup()
    for (let index = 0; index <= 500; index++) {
      logger.emit('log', {
        timestamp: '2026-08-07T01:00:00.000Z',
        level: 'info',
        message: `log-${index}`,
        args: [],
      })
    }
    const socket = new TestSocket()

    registration.connect(socket)

    const replayed = messages(socket).filter(message => message.type === 'log')
    expect(replayed).toHaveLength(500)
    expect(replayed[0]?.data).toMatchObject({ message: 'log-1' })
    expect(replayed.at(-1)?.data).toMatchObject({ message: 'log-500' })
    socket.emit('close')
    registration.closeServer()
  })

  it('tolerates disconnects during initial sends and heartbeat', () => {
    const registration = setup()
    logger.emit('log', {
      timestamp: '2026-08-07T01:00:00.000Z',
      level: 'info',
      message: 'buffered',
      args: [],
    })
    const snapshotSocket = new TestSocket()
    snapshotSocket.send.mockImplementationOnce(() => {
      throw new Error('disconnected during snapshot')
    })
    expect(() => registration.connect(snapshotSocket)).not.toThrow()

    const replaySocket = new TestSocket()
    replaySocket.send.mockImplementationOnce(() => {}).mockImplementationOnce(() => {
      throw new Error('disconnected during replay')
    })
    expect(() => registration.connect(replaySocket)).not.toThrow()

    const eventSocket = new TestSocket()
    registration.connect(eventSocket)
    eventSocket.send.mockImplementation(() => {
      throw new Error('disconnected')
    })
    expect(() => logger.emit('log', {
      timestamp: '2026-08-07T01:00:01.000Z',
      level: 'info',
      message: 'new',
      args: [],
    })).not.toThrow()
    expect(() => logger.emitProgress({
      phase: 'done',
      taskIndex: 0,
      taskTotal: 0,
      taskId: null,
      step: 0,
      elapsed: 1,
      action: null,
      reason: null,
      timestamp: '2026-08-07T01:00:01.000Z',
    })).not.toThrow()

    const heartbeatSocket = new TestSocket()
    registration.connect(heartbeatSocket)
    heartbeatSocket.send.mockImplementation(() => {
      throw new Error('disconnected during heartbeat')
    })
    vi.advanceTimersByTime(60_000)
    const callsAfterFailedHeartbeat = heartbeatSocket.send.mock.calls.length
    vi.advanceTimersByTime(60_000)
    expect(heartbeatSocket.send).toHaveBeenCalledTimes(callsAfterFailedHeartbeat)

    registration.closeServer()
  })

  it('cleans up active connections when the server closes', () => {
    const baselineLogs = logger.listenerCount('log')
    const baselineProgress = logger.listenerCount('progress')
    const registration = setup()
    const socket = new TestSocket()
    registration.connect(socket)

    registration.closeServer()
    registration.closeServer()

    expect(logger.listenerCount('log')).toBe(baselineLogs)
    expect(logger.listenerCount('progress')).toBe(baselineProgress)
    expect(socket.listenerCount('close')).toBe(0)
    expect(socket.listenerCount('error')).toBe(0)
  })

  it('cleans up after an asynchronous send error or a non-open socket', () => {
    const baselineLogs = logger.listenerCount('log')
    const baselineProgress = logger.listenerCount('progress')
    const registration = setup()
    const socket = new TestSocket()
    let sendCallback: ((error?: Error) => void) | undefined
    socket.send.mockImplementation((_message, callback) => {
      sendCallback = callback
    })
    registration.connect(socket)

    sendCallback?.(new Error('write failed'))
    sendCallback?.(new Error('late duplicate callback'))
    expect(logger.listenerCount('progress')).toBe(baselineProgress)

    const closedSocket = new TestSocket()
    closedSocket.readyState = 3
    registration.connect(closedSocket)
    expect(closedSocket.send).not.toHaveBeenCalled()
    expect(logger.listenerCount('progress')).toBe(baselineProgress)

    registration.closeServer()
    expect(logger.listenerCount('log')).toBe(baselineLogs)
  })

  it('caps active connections and terminates excess clients', () => {
    const registration = setup({ running: false }, { maxConnections: 2 })
    const first = new TestSocket()
    const second = new TestSocket()
    const excess = new TestSocket()

    registration.connect(first)
    registration.connect(second)
    registration.connect(excess)

    expect(first.terminate).not.toHaveBeenCalled()
    expect(second.terminate).not.toHaveBeenCalled()
    expect(excess.terminate).toHaveBeenCalledOnce()
    expect(excess.send).not.toHaveBeenCalled()

    const brokenExcess = new TestSocket()
    brokenExcess.terminate.mockImplementation(() => {
      throw new Error('transport already closed')
    })
    expect(() => registration.connect(brokenExcess)).not.toThrow()

    first.emit('close')
    const replacement = new TestSocket()
    registration.connect(replacement)
    expect(replacement.send).toHaveBeenCalled()
    registration.closeServer()
  })

  it('bounds replay memory and terminates clients that exceed send backpressure', () => {
    const registration = setup({ running: false }, {
      maxBufferedBytes: 200,
      maxLogBufferBytes: 300,
      maxLogBufferEntries: 2,
    })
    for (const message of ['first', 'second', 'third', 'x'.repeat(400)]) {
      logger.emit('log', {
        timestamp: '2026-08-07T01:00:00.000Z',
        level: 'info',
        message,
        args: [],
      })
    }

    const socket = new TestSocket()
    registration.connect(socket)
    const replayed = messages(socket).filter(message => message.type === 'log')
    expect(replayed).toHaveLength(2)
    expect(replayed.map(message => (message.data as { message: string }).message)).toEqual(['second', 'third'])

    socket.bufferedAmount = 200
    logger.emit('log', {
      timestamp: '2026-08-07T01:00:00.000Z',
      level: 'info',
      message: 'slow client',
      args: [],
    })
    expect(socket.terminate).toHaveBeenCalledOnce()

    const brokenSocket = new TestSocket()
    brokenSocket.bufferedAmount = 200
    brokenSocket.terminate.mockImplementation(() => {
      throw new Error('already disconnected')
    })
    expect(() => registration.connect(brokenSocket)).not.toThrow()
    registration.closeServer()
  })

  it('contains unserializable transport data without leaking listeners', () => {
    const registration = setup()
    const socket = new TestSocket()
    registration.connect(socket)
    const circular: { self?: unknown } = {}
    circular.self = circular

    expect(() => logger.emit('log', {
      timestamp: '2026-08-07T01:00:00.000Z',
      level: 'info',
      message: 'circular',
      args: [circular],
    })).not.toThrow()
    expect(socket.terminate).toHaveBeenCalledOnce()
    registration.closeServer()
  })
})

describe('webSocket integration', () => {
  it('uses the real Fastify transport and releases listeners after an asynchronous client close', async () => {
    const baselineLogs = logger.listenerCount('log')
    const baselineProgress = logger.listenerCount('progress')
    const app = Fastify()
    await app.register(fastifyWebSocket)
    registerWebSocket(app, {
      getSnapshot: () => ({ running: true, queueDepth: 0 }),
    } as unknown as Gateway, { maxConnections: 1 })
    await app.ready()

    const received: Array<{ type: string, data: unknown }> = []
    const socket = await app.injectWS('/ws', {}, {
      onInit: (client) => {
        client.on('message', (data: { toString: () => string }) => {
          received.push(JSON.parse(data.toString()) as { type: string, data: unknown })
        })
      },
    })

    await vi.waitFor(() => expect(received).toContainEqual({
      type: 'snapshot',
      data: { running: true, queueDepth: 0 },
    }))
    logger.emit('log', {
      timestamp: '2026-08-07T01:00:00.000Z',
      level: 'info',
      message: 'integration log',
      args: [],
    })
    await vi.waitFor(() => expect(received).toContainEqual({
      type: 'log',
      data: expect.objectContaining({ message: 'integration log' }),
    }))

    let excessClosed = false
    await app.injectWS('/ws', {}, {
      onInit: client => client.once('close', () => {
        excessClosed = true
      }),
    })
    await vi.waitFor(() => expect(excessClosed).toBe(true))
    expect(logger.listenerCount('log')).toBe(baselineLogs + 2)
    expect(logger.listenerCount('progress')).toBe(baselineProgress + 1)

    socket.terminate()
    await vi.waitFor(() => {
      expect(logger.listenerCount('log')).toBe(baselineLogs + 1)
      expect(logger.listenerCount('progress')).toBe(baselineProgress)
    })

    await app.injectWS('/ws')
    expect(logger.listenerCount('log')).toBe(baselineLogs + 2)
    expect(logger.listenerCount('progress')).toBe(baselineProgress + 1)
    await app.close()
    expect(logger.listenerCount('log')).toBe(baselineLogs)
    expect(logger.listenerCount('progress')).toBe(baselineProgress)
  })
})
