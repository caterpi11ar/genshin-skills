import type { FastifyInstance } from 'fastify'
import type { Gateway } from '../gateway/gateway.js'
import { logger } from '../utils/logger.js'

export function registerApi(app: FastifyInstance, gateway: Gateway): void {
  const config = gateway.config

  // GET /api/status
  app.get('/api/status', async () => {
    const snapshot = gateway.getSnapshot()
    const history = await gateway.getRunHistory(1)
    const lastRun = history.at(-1)

    return {
      running: snapshot.running,
      queueDepth: snapshot.queueDepth,
      lastRun: lastRun
        ? {
            startedAt: lastRun.startedAt,
            completedAt: lastRun.completedAt,
            results: lastRun.results,
          }
        : null,
      schedule: config.schedule,
    }
  })

  // GET /api/tasks
  app.get('/api/tasks', async () => {
    return gateway.getSkillSummaries()
  })

  // GET /api/config
  app.get('/api/config', async () => {
    return {
      ...config,
      model: {
        ...config.model,
        apiKey: config.model.apiKey ? '***' : '',
      },
    }
  })

  // GET /api/history
  app.get('/api/history', async (request) => {
    const query = request.query as { limit?: string }
    const limit = query.limit ? Number(query.limit) : 20
    return gateway.getRunHistory(limit)
  })

  // POST /api/run
  app.post('/api/run', async (request, reply) => {
    const body = (request.body ?? {}) as { tasks?: string[], routine?: string }
    if (body.tasks && body.routine) {
      return reply.status(400).send({ error: 'Use either tasks or routine, not both' })
    }

    let taskIds = body.tasks
    if (body.routine) {
      taskIds = config.tasks.routines[body.routine]
      if (!taskIds) {
        return reply.status(400).send({
          error: `Unknown routine "${body.routine}"`,
          availableRoutines: Object.keys(config.tasks.routines),
        })
      }
    }
    try {
      gateway.getTaskRunner().getEnabledTasks(taskIds ?? config.tasks.enabled)
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return reply.status(400).send({ error: message })
    }

    const snapshot = gateway.getSnapshot()
    if (snapshot.running && snapshot.queueDepth >= config.queue.maxDepth) {
      return reply.status(429).send({
        error: `Queue is full (${snapshot.queueDepth}/${config.queue.maxDepth})`,
      })
    }

    const status = snapshot.running ? 'queued' : 'started'
    gateway.enqueueRun('api', taskIds).catch((err) => {
      logger.error('API-triggered run failed', err)
    })
    return reply.status(status === 'queued' ? 202 : 200).send({
      status,
      tasks: gateway.getTaskRunner().getEnabledTasks(taskIds ?? config.tasks.enabled).map(task => task.id),
    })
  })
}
