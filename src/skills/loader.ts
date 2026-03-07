import type { SkillDefinition, SkillStep, StepMethod } from './types.js'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import matter from 'gray-matter'
import { z } from 'zod'

const frontmatterSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  enabled: z.boolean().default(true),
  timeoutMs: z.number().default(600_000),
  retries: z.number().default(1),
})

const VALID_METHODS = new Set<StepMethod>(['aiAct', 'aiTap', 'aiWaitFor', 'aiAssert', 'aiBoolean', 'keyPress'])

function parseSteps(text: string): SkillStep[] {
  return text.split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('- '))
    .map((line) => {
      const content = line.slice(2) // remove "- "
      const colonIdx = content.indexOf(': ')
      if (colonIdx === -1)
        return null
      const method = content.slice(0, colonIdx) as StepMethod
      if (!VALID_METHODS.has(method))
        return null
      const prompt = content.slice(colonIdx + 2)
      return { method, prompt }
    })
    .filter((s): s is SkillStep => s != null)
}

function parseSkillBody(markdown: string): {
  steps: SkillStep[]
  background?: string
  knownIssues?: string[]
} {
  const sections = new Map<string, string>()
  let currentHeading = ''

  for (const line of markdown.split('\n')) {
    const headingMatch = line.match(/^## (.+)/)
    if (headingMatch) {
      currentHeading = headingMatch[1]!.trim().toLowerCase()
    }
    else if (currentHeading) {
      const existing = sections.get(currentHeading) ?? ''
      sections.set(currentHeading, `${existing + line}\n`)
    }
  }

  const steps = parseSteps(sections.get('steps') ?? '')

  const background = (sections.get('background') ?? '').trim() || undefined

  const knownIssuesRaw = (sections.get('known issues') ?? '').trim()
  const knownIssues = knownIssuesRaw
    .split('\n')
    .map(line => line.replace(/^- /, '').trim())
    .filter(Boolean)

  return {
    steps,
    background,
    knownIssues: knownIssues.length > 0 ? knownIssues : undefined,
  }
}

export async function loadSkills(dirs: string[]): Promise<SkillDefinition[]> {
  const skills: SkillDefinition[] = []

  for (const dir of dirs) {
    const absDir = resolve(dir)
    let entries: string[]
    try {
      entries = await readdir(absDir)
    }
    catch {
      continue // directory doesn't exist, skip
    }

    for (const entry of entries) {
      const skillFile = join(absDir, entry, 'SKILL.md')
      let content: string
      try {
        content = await readFile(skillFile, 'utf-8')
      }
      catch {
        continue // no SKILL.md, skip
      }

      const { data, content: body } = matter(content)
      const frontmatter = frontmatterSchema.parse(data)
      const { steps, background, knownIssues } = parseSkillBody(body)

      skills.push({
        ...frontmatter,
        steps,
        background,
        knownIssues,
        sourcePath: skillFile,
      })
    }
  }

  return skills
}
