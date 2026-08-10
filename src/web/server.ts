import type { Socket } from 'node:net'
import type { Gateway } from '../gateway/gateway.js'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import fastifyStatic from '@fastify/static'
import fastifyWebSocket from '@fastify/websocket'
import Fastify from 'fastify'
import { logger } from '../utils/logger.js'
import { registerApi } from './api.js'
import { registerWebSecurity } from './security.js'
import { registerWebSocket } from './ws.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const MAX_WEB_SOCKET_PAYLOAD_BYTES = 64 * 1024

export interface WebServerHandle {
  close: () => Promise<void>
}

export async function startWebServer(gateway: Gateway): Promise<WebServerHandle> {
  const app = Fastify({
    logger: false,
    // Daemon shutdown already stops accepting work before closing transports.
    // Force any stale keep-alive or upgraded socket closed so app.close()
    // cannot wait forever on a disconnected dashboard client.
    forceCloseConnections: true,
  })
  const port = gateway.config.web.port
  const sockets = new Set<Socket>()
  const onConnection = (socket: Socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  }
  app.server.on('connection', onConnection)
  let closePromise: Promise<void> | undefined
  const handle: WebServerHandle = {
    close: () => {
      if (!closePromise) {
        closePromise = app.close()
        app.server.removeListener('connection', onConnection)
        // Rejected WebSocket upgrades are raw TCP sockets and are not always
        // retained by Fastify's normal connection tracker. Destroy every
        // socket owned by this server so shutdown remains bounded.
        for (const socket of sockets)
          socket.destroy()
        sockets.clear()
      }
      return closePromise
    },
  }

  try {
    registerWebSecurity(app, port)

    await app.register(fastifyWebSocket, {
      options: { maxPayload: MAX_WEB_SOCKET_PAYLOAD_BYTES },
      preClose(done) {
        // The plugin's default uses a graceful WebSocket close handshake,
        // which can wait forever for a suspended or non-cooperative client.
        // Daemon shutdown needs a hard transport boundary.
        for (const client of this.websocketServer.clients)
          client.terminate()
        this.websocketServer.close(done)
      },
    })

    await app.register(fastifyStatic, {
      root: resolve(__dirname, 'public'),
      prefix: '/',
    })

    registerApi(app, gateway)
    registerWebSocket(app, gateway)

    await app.listen({ port, host: '127.0.0.1' })
  }
  catch (error) {
    try {
      await handle.close()
    }
    catch (closeError) {
      logger.error('Failed to clean up web server after startup error', closeError)
    }
    throw error
  }
  logger.info(`Web panel running at http://127.0.0.1:${port}`)
  return handle
}
