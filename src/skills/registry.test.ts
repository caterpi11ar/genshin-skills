import type { Page } from 'playwright'
import type { SkillDefinition } from './types.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { appConfigSchema } from '../config/schema.js'

import { SkillRegistry } from './registry.js'

const mocks = vi.hoisted(() => ({
  loadSkills: vi.fn(),
  executeSteps: vi.fn(),
}))

vi.mock('./loader.js', () => ({ loadSkills: mocks.loadSkills }))
vi.mock('../agent/step-executor.js', () => ({ executeSteps: mocks.executeSteps }))

function skill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    id: 'mail',
    name: 'Mail',
    description: 'Claim mail',
    enabled: true,
    timeoutMs: 5000,
    retries: 2,
    dependsOn: ['launch'],
    steps: [{ method: 'keyPress', prompt: 'Escape' }],
    background: 'background',
    goal: 'goal',
    knownIssues: ['issue'],
    sourcePath: '/skills/mail/SKILL.md',
    ...overrides,
  }
}

describe('skillRegistry', () => {
  beforeEach(() => {
    mocks.loadSkills.mockReset()
    mocks.executeSteps.mockReset().mockResolvedValue({
      success: true,
      reason: 'All steps completed',
      steps: 1,
      durationMs: 12,
    })
  })

  it('loads, lists, and retrieves skills', async () => {
    const loaded = [skill(), skill({ id: 'events', name: 'Events' })]
    mocks.loadSkills.mockResolvedValue(loaded)
    const registry = new SkillRegistry()

    await registry.loadFromDirs(['/skills'])

    expect(mocks.loadSkills).toHaveBeenCalledWith(['/skills'])
    expect(registry.getAll()).toBe(loaded)
    expect(registry.get('events')?.name).toBe('Events')
    expect(registry.get('missing')).toBeUndefined()
  })

  it('converts skill metadata and execution context into task definitions', async () => {
    mocks.loadSkills.mockResolvedValue([skill()])
    const registry = new SkillRegistry()
    await registry.loadFromDirs(['/skills'])
    const [definition] = registry.toTaskDefinitions()
    const config = appConfigSchema.parse({ agent: { replanningCycleLimit: 77 } })
    const transcript = { append: vi.fn() }
    const onProgress = vi.fn()
    const signal = new AbortController().signal

    const result = await definition!.execute({
      page: {} as Page,
      signal,
      modelConfig: { model: 'test' },
      streamModelResponses: true,
      config,
      logger: {} as never,
      transcript: transcript as never,
      screenshotDir: '/screens',
      onProgress,
    })

    expect(definition).toMatchObject({
      id: 'mail',
      defaultEnabled: true,
      timeoutMs: 5000,
      retries: 2,
      dependsOn: ['launch'],
    })
    expect(mocks.executeSteps).toHaveBeenCalledWith({
      skillId: 'mail',
      page: {},
      signal,
      steps: [{ method: 'keyPress', prompt: 'Escape' }],
      modelConfig: { model: 'test' },
      streamModelResponses: true,
      replanningCycleLimit: 77,
      timeoutMs: 5000,
      background: 'background',
      goal: 'goal',
      knownIssues: ['issue'],
      transcript,
      screenshotDir: '/screens',
      onProgress,
    })
    expect(result).toMatchObject({
      taskId: 'mail',
      success: true,
      message: 'All steps completed',
      durationMs: 12,
      completedAt: expect.any(Date),
    })
  })

  it('uses the configured default screenshot directory when context omits one', async () => {
    mocks.loadSkills.mockResolvedValue([skill()])
    const registry = new SkillRegistry()
    await registry.loadFromDirs(['/skills'])
    const [definition] = registry.toTaskDefinitions()

    await definition!.execute({
      page: {} as Page,
      signal: new AbortController().signal,
      modelConfig: {},
      config: appConfigSchema.parse({}),
      logger: {} as never,
    })

    expect(mocks.executeSteps).toHaveBeenCalledWith(expect.objectContaining({
      screenshotDir: expect.stringMatching(/screenshots$/),
    }))
  })
})
