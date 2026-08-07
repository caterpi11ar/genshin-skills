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
})
