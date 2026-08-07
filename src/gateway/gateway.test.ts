import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appConfigSchema } from '../config/schema.js'
import { Gateway } from './gateway.js'

describe('gateway skill catalog', () => {
  it('validates built-ins and expands a selected skill dependency', async () => {
    const config = appConfigSchema.parse({
      model: {
        name: 'test-model',
        baseUrl: 'https://example.test/v1',
        apiKey: 'test-key',
        family: 'openai',
      },
      tasks: {
        enabled: ['welkin-moon', 'claim-mail'],
        skillsDirs: [resolve('skills')],
        routines: {
          daily: ['claim-mail'],
        },
      },
    })

    const gateway = new Gateway(config)
    await gateway.init()

    expect(gateway.getSkillSummaries()).toHaveLength(6)
    expect(gateway.getTaskRunner().getEnabledTasks(['claim-mail']).map(task => task.id))
      .toEqual(['welkin-moon', 'claim-mail'])
  })
})
