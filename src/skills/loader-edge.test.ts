import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadSkills } from './loader.js'

vi.mock('./step-arguments.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./step-arguments.js')>()
  return {
    ...actual,
    validateStepArgument: vi.fn(() => {
      // eslint-disable-next-line no-throw-literal
      throw 'plain validation failure'
    }),
  }
})

describe('loadSkills error normalization', () => {
  const cleanupDirs: string[] = []

  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })

  it('normalizes non-Error step validation failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'giclaw-skill-edge-'))
    cleanupDirs.push(root)
    const skillDir = join(root, 'demo')
    await mkdir(skillDir)
    await writeFile(join(skillDir, 'SKILL.md'), `---
id: demo
name: Demo
description: Demo skill
---

## Steps
- keyPress: Escape
`, 'utf-8')

    await expect(loadSkills([root]))
      .rejects
      .toThrow('Invalid argument for step "keyPress" in')
    await expect(loadSkills([root]))
      .rejects
      .toThrow('plain validation failure')
  })
})
