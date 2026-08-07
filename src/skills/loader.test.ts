import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadSkills } from './loader.js'

async function writeSkill(
  root: string,
  id: string,
  body: string,
  name: string = id,
): Promise<string> {
  const dir = join(root, id)
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'SKILL.md')
  await writeFile(path, `---
id: ${id}
name: ${name}
description: test skill
---

${body}
`, 'utf-8')
  return path
}

describe('loadSkills', () => {
  it('loads executable steps and context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'giclaw-skills-'))
    await writeSkill(root, 'demo', `## Background
background text

## Goal
goal text

## Steps
- keyPress: Escape
- wait: 1s

## Known Issues
- issue one`)

    const [skill] = await loadSkills([root])
    expect(skill).toMatchObject({
      id: 'demo',
      background: 'background text',
      goal: 'goal text',
      knownIssues: ['issue one'],
      dependsOn: [],
      steps: [
        { method: 'keyPress', prompt: 'Escape' },
        { method: 'wait', prompt: '1s' },
      ],
    })
  })

  it('rejects empty and unknown workflows instead of silently succeeding', async () => {
    const emptyRoot = await mkdtemp(join(tmpdir(), 'giclaw-empty-'))
    await writeSkill(emptyRoot, 'empty', '## Goal\nNo executable section')
    await expect(loadSkills([emptyRoot])).rejects.toThrow('has no executable steps')

    const invalidRoot = await mkdtemp(join(tmpdir(), 'giclaw-invalid-'))
    await writeSkill(invalidRoot, 'invalid', '## Steps\n- teleport: Mondstadt')
    await expect(loadSkills([invalidRoot])).rejects.toThrow('Unknown step method "teleport"')
  })

  it('lets a later skill directory override a built-in skill', async () => {
    const builtins = await mkdtemp(join(tmpdir(), 'giclaw-builtins-'))
    const custom = await mkdtemp(join(tmpdir(), 'giclaw-custom-'))
    await writeSkill(builtins, 'demo', '## Steps\n- keyPress: Escape', 'Built in')
    await writeSkill(custom, 'demo', '## Steps\n- keyPress: Enter', 'Custom')

    const skills = await loadSkills([builtins, custom])
    expect(skills).toHaveLength(1)
    expect(skills[0]?.name).toBe('Custom')
    expect(skills[0]?.steps[0]?.prompt).toBe('Enter')
  })
})
