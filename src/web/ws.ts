import type { FastifyInstance } from 'fastify'
import type { Gateway } from '../gateway/gateway.js'
import type { LogEntry } from '../utils/logger.js'
import type { ProgressEvent } from '../utils/progress.js'
import { Buffer } from 'node:buffer'
import { logger } from '../utils/logger.js'

export interface WebSocketLimits {
  maxBufferedBytes: number
  maxConnections: number
  maxLogBufferBytes: number
  maxLogBufferEntries: number
}

export const DEFAULT_WEB_SOCKET_LIMITS: WebSocketLimits = {
  maxBufferedBytes: 1024 * 1024,
  maxConnections: 8,
  maxLogBufferBytes: 1024 * 1024,
  maxLogBufferEntries: 500,
}

interface BufferedLog {
  entry: LogEntry
  size: number
}

export function registerWebSocket(
  app: FastifyInstance,
  gateway: Gateway,
  overrides: Partial<WebSocketLimits> = {},
): void {
  const limits = { ...DEFAULT_WEB_SOCKET_LIMITS, ...overrides }
  // Circular buffer for recent logs
  const logBuffer: BufferedLog[] = []
  let logBufferBytes = 0
  const activeConnections = new Set<() => void>()

  const bufferLog = (entry: LogEntry) => {
    let size: number
    try {
      size = Buffer.byteLength(JSON.stringify(entry))
    }
    catch {
      return
    }
    if (size > limits.maxLogBufferBytes)
      return

    logBuffer.push({ entry, size })
    logBufferBytes += size
    while (
      logBuffer.length > limits.maxLogBufferEntries
      || logBufferBytes > limits.maxLogBufferBytes
    ) {
      const removed = logBuffer.shift() as BufferedLog
      logBufferBytes -= removed.size
    }
  }
  logger.on('log', bufferLog)

  app.addHook('onClose', (_instance, done) => {
    logger.removeListener('log', bufferLog)
    for (const cleanup of activeConnections)
      cleanup()
    done()
  })

  app.register(async (fastify) => {
    fastify.get('/ws', { websocket: true }, (socket) => {
      if (activeConnections.size >= limits.maxConnections) {
        try {
          socket.terminate()
        }
        catch {
          // No listeners were installed for the rejected transport.
        }
        return
      }

      let heartbeat: ReturnType<typeof setInterval> | undefined
      let cleanedUp = false

      function cleanup(): void {
        if (cleanedUp)
          return
        cleanedUp = true
        logger.removeListener('log', onLog)
        logger.removeListener('progress', onProgress)
        if (heartbeat)
          clearInterval(heartbeat)
        socket.removeListener('close', cleanup)
        socket.removeListener('error', cleanup)
        activeConnections.delete(cleanup)
      }

      function terminate(): void {
        cleanup()
        try {
          socket.terminate()
        }
        catch {
          // The transport is already gone.
        }
      }

      function send(type: string, data: unknown): boolean {
        if (cleanedUp || socket.readyState !== socket.OPEN) {
          cleanup()
          return false
        }
        try {
          const payload = JSON.stringify({ type, data })
          if (socket.bufferedAmount + Buffer.byteLength(payload) > limits.maxBufferedBytes) {
            terminate()
            return false
          }
          socket.send(payload, (error?: Error) => {
            if (error)
              terminate()
          })
          return true
        }
        catch {
          terminate()
          return false
        }
      }

      function onLog(entry: LogEntry): void {
        send('log', entry)
      }

      function onProgress(event: ProgressEvent): void {
        send('progress', event)
      }

      activeConnections.add(cleanup)
      logger.on('log', onLog)
      logger.on('progress', onProgress)
      socket.once('close', cleanup)
      socket.once('error', cleanup)

      // Send current snapshot and recent logs on connect.
      if (!send('snapshot', gateway.getSnapshot()))
        return
      for (const { entry } of logBuffer) {
        if (!send('log', entry))
          return
      }

      // Heartbeat
      heartbeat = setInterval(() => {
        send('status', { alive: true })
      }, 30_000)
    })
  })
}
