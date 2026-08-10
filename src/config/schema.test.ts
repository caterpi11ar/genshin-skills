import { describe, expect, it } from 'vitest'
import { appConfigSchema } from './schema.js'

describe('appConfigSchema task defaults', () => {
  it('enables every real-account-verified reward task by default', () => {
    const config = appConfigSchema.parse({})

    expect(config.tasks.enabled).toEqual([
      'welkin-moon',
      'claim-mail',
      'claim-achievements',
      'claim-event-rewards',
      'battle-pass-claim',
    ])
  })

  it('provides complete nested defaults', () => {
    const config = appConfigSchema.parse({})

    expect(config.browser.viewport).toEqual({ width: 1280, height: 720 })
    expect(config.agent.replanningCycleLimit).toBe(40)
    expect(config.tasks.routines).toEqual({
      daily: ['welkin-moon', 'claim-mail'],
      rewards: ['welkin-moon', 'claim-mail', 'claim-achievements', 'claim-event-rewards', 'battle-pass-claim'],
      full: ['welkin-moon', 'claim-mail', 'claim-achievements', 'claim-event-rewards', 'battle-pass-claim'],
    })
    expect(config.model).toMatchObject({ family: '', stream: false })
    expect(config.memory).toMatchObject({
      maxArtifactFiles: 1_000,
      maxArtifactBytes: 1024 * 1024 * 1024,
    })
  })

  it('accepts supported overrides', () => {
    const config = appConfigSchema.parse({
      locale: 'en',
      model: { family: 'gpt-5', stream: true },
      browser: { viewport: { width: 1920, height: 1080 } },
      queue: { maxDepth: 3 },
    })

    expect(config.locale).toBe('en')
    expect(config.model).toMatchObject({ family: 'gpt-5', stream: true })
    expect(config.browser.viewport).toEqual({ width: 1920, height: 1080 })
    expect(config.queue.maxDepth).toBe(3)
  })

  it.each([
    { queue: { maxDepth: 0 } },
    { queue: { maxDepth: 10_001 } },
    { tasks: { enabled: [] } },
    { tasks: { skillsDirs: [] } },
    { agent: { replanningCycleLimit: 201 } },
    { browser: { startupUrl: 'not-a-url' } },
    { browser: { startupUrl: 'http://example.com/game' } },
    { browser: { startupUrl: 'https://user:password@example.com/game' } },
    { browser: { viewport: { width: 0 } } },
    { browser: { dialogAutoDismissMs: -1 } },
    { login: { timeoutMs: 0 } },
    { login: { pollIntervalMs: 0 } },
    { model: { baseUrl: 'http://example.com/v1' } },
    { model: { baseUrl: 'not-a-url' } },
    { model: { baseUrl: 'https://[' } },
    { model: { baseUrl: 'https://user:password@example.com/v1' } },
    { model: { baseUrl: 'https://@example.com/v1' } },
    { model: { baseUrl: 'https://example.com/v1?apiKey=secret' } },
    { model: { baseUrl: 'https://example.com/v1?' } },
    { model: { baseUrl: 'https://example.com/v1#' } },
    { model: { baseUrl: ' http://127.0.0.1:3002/v1' } },
    { model: { baseUrl: 'http://127.0.0.2:3002/v1' } },
    { schedule: { cron: 'not a cron' } },
    { schedule: { timezone: 'Not/A_Timezone' } },
    { web: { port: 0 } },
    { web: { port: 65_536 } },
    { memory: { maxHistory: 0 } },
    { memory: { maxArtifactFiles: 0 } },
    { memory: { maxArtifactBytes: 0 } },
    { logLevel: 'trace' },
  ])('rejects invalid configuration %#', (value) => {
    expect(() => appConfigSchema.parse(value)).toThrow()
  })

  it.each([
    'https://models.example.com/v1',
    'http://127.0.0.1:3002/v1',
    'http://localhost:3002/v1',
    'http://[::1]:3002/v1',
  ])('accepts secure or loopback model URL %s', (baseUrl) => {
    expect(appConfigSchema.parse({ model: { baseUrl } }).model.baseUrl).toBe(baseUrl)
  })
})
