import type { Page } from 'playwright'
import type { TaskContext, TaskDefinition } from '../tasks/base-task.js'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loginFlow } from '../browser/login.js'
import { SessionManager } from '../browser/session-manager.js'
import { appConfigSchema } from '../config/schema.js'
import { Gateway } from '../gateway/gateway.js'
import { registerApi } from './api.js'

vi.mock('../browser/login.js', () => ({
  loginFlow: vi.fn(),
}))

describe('hTTP to persisted task-run integration', () => {
  const cleanupDirs: string[] = []

  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })

  it('runs through the real gateway, queue, task runner, and state store', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'giclaw-api-integration-'))
    cleanupDirs.push(dataDir)
    const config = appConfigSchema.parse({
      model: {
        name: 'offline-model',
        baseUrl: 'https://example.test/v1',
        apiKey: 'offline-key',
      },
      tasks: {
        enabled: ['integration-task'],
        skillsDirs: [dataDir],
        routines: { integration: ['integration-task'] },
      },
      memory: { dataDir, maxHistory: 5 },
    })
    const execute = vi.fn(async (_context: TaskContext) => ({
      taskId: 'integration-task',
      success: true,
      message: 'persisted through the full in-process chain',
      durationMs: 5,
      completedAt: new Date('2026-08-07T02:00:00.000Z'),
    }))
    const task: TaskDefinition = {
      id: 'integration-task',
      name: 'Integration task',
      description: 'Offline integration fixture',
      defaultEnabled: true,
      timeoutMs: 1_000,
      retries: 0,
      dependsOn: [],
      execute,
    }

    vi.mocked(loginFlow).mockResolvedValue()
    vi.spyOn(SessionManager.prototype, 'getPage').mockReturnValue({} as Page)
    vi.spyOn(SessionManager.prototype, 'close').mockResolvedValue()
    const gateway = new Gateway(config)
    gateway.getTaskRunner().register(task)
    const app = Fastify()
    registerApi(app, gateway)
    await app.ready()

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/run',
        payload: { routine: 'integration' },
      })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ status: 'started', tasks: ['integration-task'] })

      await vi.waitFor(async () => {
        await expect(gateway.getRunHistory()).resolves.toHaveLength(1)
      })

      expect(execute).toHaveBeenCalledOnce()
      const historyResponse = await app.inject({ method: 'GET', url: '/api/history' })
      expect(historyResponse.statusCode).toBe(200)
      expect(historyResponse.json()).toEqual([
        expect.objectContaining({
          trigger: 'api',
          results: [{
            taskId: 'integration-task',
            success: true,
            message: 'persisted through the full in-process chain',
            durationMs: 5,
          }],
        }),
      ])
      const persisted = JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf-8'))
      expect(persisted).toMatchObject({
        totalRuns: 1,
        lastSuccess: true,
        history: [expect.objectContaining({ trigger: 'api' })],
      })
    }
    finally {
      await app.close()
      await gateway.shutdown()
    }
  })

  it('reports concurrent admission from the real queue without false acceptance', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'giclaw-api-capacity-'))
    cleanupDirs.push(dataDir)
    const config = appConfigSchema.parse({
      model: {
        name: 'offline-model',
        baseUrl: 'https://example.test/v1',
        apiKey: 'offline-key',
      },
      tasks: {
        enabled: ['blocking-task'],
        skillsDirs: [dataDir],
      },
      memory: { dataDir, maxHistory: 5 },
      queue: { maxDepth: 1 },
    })
    let releaseFirst!: () => void
    let execution = 0
    const execute = vi.fn(async () => {
      execution += 1
      if (execution === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
      }
      const now = new Date()
      return {
        taskId: 'blocking-task',
        success: true,
        message: 'completed',
        durationMs: 1,
        completedAt: now,
      }
    })
    const task: TaskDefinition = {
      id: 'blocking-task',
      name: 'Blocking task',
      description: 'Queue capacity fixture',
      defaultEnabled: true,
      timeoutMs: 5_000,
      retries: 0,
      dependsOn: [],
      execute,
    }

    vi.mocked(loginFlow).mockResolvedValue()
    vi.spyOn(SessionManager.prototype, 'getPage').mockReturnValue({} as Page)
    vi.spyOn(SessionManager.prototype, 'close').mockResolvedValue()
    const gateway = new Gateway(config)
    gateway.getTaskRunner().register(task)
    const app = Fastify()
    registerApi(app, gateway)
    await app.ready()

    try {
      const first = await app.inject({ method: 'POST', url: '/api/run' })
      const second = await app.inject({ method: 'POST', url: '/api/run' })
      const rejected = await app.inject({ method: 'POST', url: '/api/run' })

      expect(first.statusCode).toBe(200)
      expect(first.json().status).toBe('started')
      expect(second.statusCode).toBe(202)
      expect(second.json().status).toBe('queued')
      expect(rejected.statusCode).toBe(429)
      expect(rejected.json()).toEqual({ error: 'Queue is full (1/1)' })
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())

      releaseFirst()
      await vi.waitFor(async () => {
        await expect(gateway.getRunHistory()).resolves.toHaveLength(2)
      })
      expect(execute).toHaveBeenCalledTimes(2)
    }
    finally {
      releaseFirst?.()
      await app.close()
      await gateway.shutdown()
    }
  })
})
