import type { AddressInfo } from 'node:net'
import type { Gateway } from '../gateway/gateway.js'
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { logger } from '../utils/logger.js'
import { WEB_SESSION_COOKIE } from './security.js'
import { startWebServer } from './server.js'

interface WebSocketResult {
  message?: unknown
  status: number
}

async function unusedLoopbackPort(): Promise<number> {
  const reservation = createServer()
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject)
    reservation.listen(0, '127.0.0.1', resolve)
  })
  const port = (reservation.address() as AddressInfo).port
  await new Promise<void>((resolve, reject) => {
    reservation.close(error => error ? reject(error) : resolve())
  })
  return port
}

function maskedCloseFrame(): Buffer {
  const payload = Buffer.allocUnsafe(2)
  payload.writeUInt16BE(1000)
  const mask = randomBytes(4)
  const frame = Buffer.allocUnsafe(2 + mask.length + payload.length)
  frame[0] = 0x88
  frame[1] = 0x80 | payload.length
  mask.copy(frame, 2)
  for (let index = 0; index < payload.length; index++)
    frame[6 + index] = payload[index]! ^ mask[index % mask.length]!
  return frame
}

function readTextFrame(buffer: Buffer): unknown | undefined {
  if (buffer.length < 2)
    return undefined
  const opcode = buffer[0]! & 0x0F
  let payloadLength = buffer[1]! & 0x7F
  let offset = 2
  if (payloadLength === 126) {
    if (buffer.length < 4)
      return undefined
    payloadLength = buffer.readUInt16BE(2)
    offset = 4
  }
  if (opcode !== 1 || buffer.length < offset + payloadLength)
    return undefined
  return JSON.parse(buffer.subarray(offset, offset + payloadLength).toString('utf8')) as unknown
}

function requestWebSocket(
  port: number,
  headers: Record<string, string> = {},
): Promise<WebSocketResult> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let upgradedSocket: { destroy: () => void } | undefined
    const req = request({
      host: '127.0.0.1',
      port,
      path: '/ws',
      headers: {
        'connection': 'Upgrade',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        'sec-websocket-version': '13',
        'upgrade': 'websocket',
        ...headers,
      },
    })
    const finish = (result: WebSocketResult) => {
      if (settled)
        return
      settled = true
      if (timer)
        clearTimeout(timer)
      resolve(result)
    }
    const fail = (error: Error) => {
      if (settled)
        return
      settled = true
      if (timer)
        clearTimeout(timer)
      upgradedSocket?.destroy()
      req.destroy()
      reject(error)
    }

    timer = setTimeout(fail, 3_000, new Error('WebSocket integration request timed out'))
    req.once('error', fail)
    req.once('response', (response) => {
      const status = response.statusCode ?? 0
      response.destroy()
      finish({ status })
    })
    req.once('upgrade', (response, socket, head) => {
      upgradedSocket = socket
      let received = Buffer.from(head)
      let message = readTextFrame(received)
      let closeSent = false
      const closeCleanly = () => {
        if (closeSent)
          return
        closeSent = true
        socket.end(maskedCloseFrame())
      }
      if (message !== undefined)
        closeCleanly()
      socket.on('data', (chunk: Buffer) => {
        if (message !== undefined)
          return
        received = Buffer.concat([received, chunk])
        message = readTextFrame(received)
        if (message !== undefined)
          closeCleanly()
      })
      socket.once('error', fail)
      socket.once('close', () => {
        if (message === undefined) {
          fail(new Error('Authenticated WebSocket closed before sending a snapshot'))
          return
        }
        finish({ status: response.statusCode ?? 101, message })
      })
    })
    req.end()
  })
}

function gatewayForPort(port: number): Gateway {
  return {
    config: {
      web: { port },
      schedule: { cron: '0 6 * * *', timezone: 'Asia/Shanghai' },
      tasks: { enabled: ['claim-mail'], routines: {} },
      model: { apiKey: 'test-key' },
      queue: { maxDepth: 1 },
    },
    getSnapshot: () => ({ running: false, queueDepth: 0 }),
    getRunHistory: async () => [],
    getSkillSummaries: () => [],
  } as unknown as Gateway
}

async function startOnUnusedPort(): Promise<{
  handle: Awaited<ReturnType<typeof startWebServer>>
  port: number
}> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await unusedLoopbackPort()
    try {
      return { port, handle: await startWebServer(gatewayForPort(port)) }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE')
        throw error
    }
  }
  throw new Error('Could not reserve a loopback port for the integration test')
}

describe('real web server integration', () => {
  it('listens, authenticates HTTP and WebSocket requests, and closes idempotently', { timeout: 10_000 }, async () => {
    vi.spyOn(logger, 'info').mockImplementation(() => {})
    const { handle, port } = await startOnUnusedPort()
    const baseUrl = `http://127.0.0.1:${port}`

    try {
      const root = await fetch(`${baseUrl}/`, { headers: { connection: 'close' } })
      expect(root.status).toBe(200)
      expect(await root.text()).toContain('<!DOCTYPE html>')
      const setCookie = root.headers.get('set-cookie')
      expect(setCookie).toContain(`${WEB_SESSION_COOKIE}=`)
      const cookie = setCookie?.split(';', 1)[0] as string

      const unauthorizedApi = await fetch(`${baseUrl}/api/status`, {
        headers: { connection: 'close' },
      })
      expect(unauthorizedApi.status).toBe(401)

      const authorizedApi = await fetch(`${baseUrl}/api/status`, {
        headers: { connection: 'close', cookie, origin: baseUrl },
      })
      expect(authorizedApi.status).toBe(200)
      await expect(authorizedApi.json()).resolves.toMatchObject({
        running: false,
        queueDepth: 0,
      })

      await expect(requestWebSocket(port)).resolves.toEqual({ status: 401 })
      await expect(requestWebSocket(port, {
        cookie,
        origin: 'http://evil.example',
      })).resolves.toEqual({ status: 403 })
      await expect(requestWebSocket(port, { cookie, origin: baseUrl })).resolves.toEqual({
        status: 101,
        message: {
          type: 'snapshot',
          data: { running: false, queueDepth: 0 },
        },
      })
    }
    finally {
      await handle.close()
      await handle.close()
    }

    await expect(fetch(`${baseUrl}/`, {
      headers: { connection: 'close' },
      signal: AbortSignal.timeout(1_000),
    })).rejects.toThrow()
  })
})
