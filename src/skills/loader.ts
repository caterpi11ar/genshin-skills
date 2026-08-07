import type { SkillDefinition, SkillStep, StepMethod } from './types.js'
import { readdir, readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import matter from 'gray-matter'
import { z } from 'zod'
import { ConfigError } from '../utils/errors.js'
import { validateStepArgument } from './step-arguments.js'
import { STEP_METHODS } from './types.js'

const frontmatterSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must use kebab-case'),
  name: z.string().min(1),
  description: z.string().min(1),
  enabled: z.boolean().default(true),
  timeoutMs: z.number().int().positive().default(600_000),
  retries: z.number().int().min(0).default(1),
  dependsOn: z.array(z.string()).default([]),
})

const VALID_METHODS = new Set<string>(STEP_METHODS)

function parseSteps(text: string, sourcePath: string): SkillStep[] {
  const steps: SkillStep[] = []

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('- '))
      continue

    const content = line.slice(2)
    const colonIdx = content.indexOf(':')
    if (colonIdx === -1) {
      throw new ConfigError(`Invalid step in ${sourcePath}: "${line}" (expected "- method: argument")`)
    }

    const method = content.slice(0, colonIdx).trim()
    const prompt = content.slice(colonIdx + 1).trim()
    if (!VALID_METHODS.has(method)) {
      throw new ConfigError(
        `Unknown step method "${method}" in ${sourcePath}. Valid methods: ${STEP_METHODS.join(', ')}`,
      )
    }
    if (!prompt) {
      throw new ConfigError(`Empty argument for step "${method}" in ${sourcePath}`)
    }
    try {
      validateStepArgument(method as StepMethod, prompt)
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new ConfigError(`Invalid argument for step "${method}" in ${sourcePath}: ${message}`)
    }
    steps.push({ method: method as StepMethod, prompt })
  }

  return steps
}

function parseSkillBody(markdown: string, sourcePath: string): {
  steps: SkillStep[]
  background?: string
  goal?: string
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

  const steps = parseSteps(sections.get('steps') ?? '', sourcePath)
  if (steps.length === 0) {
    throw new ConfigError(`Skill ${sourcePath} has no executable steps in its "## Steps" section`)
  }

  const background = (sections.get('background') ?? '').trim() || undefined
  const goal = (sections.get('goal') ?? '').trim() || undefined

  const knownIssuesRaw = (sections.get('known issues') ?? '').trim()
  const knownIssues = knownIssuesRaw
    .split('\n')
    .map(line => line.replace(/^- /, '').trim())
    .filter(Boolean)

  return {
    steps,
    background,
    goal,
    knownIssues: knownIssues.length > 0 ? knownIssues : undefined,
  }
}

export async function loadSkills(dirs: string[]): Promise<SkillDefinition[]> {
  // Later directories intentionally override earlier ones. This lets users
  // replace a built-in skill with ~/.giclaw/skills/<id>/SKILL.md.
  const skills = new Map<string, SkillDefinition>()

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
      const parsed = frontmatterSchema.safeParse(data)
      if (!parsed.success) {
        throw new ConfigError(
          `Invalid frontmatter in ${skillFile}: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join(', ')}`,
        )
      }
      const frontmatter = parsed.data
      if (frontmatter.id !== basename(join(absDir, entry))) {
        throw new ConfigError(
          `Skill id "${frontmatter.id}" must match its directory name "${entry}" (${skillFile})`,
        )
      }
      if (frontmatter.dependsOn.includes(frontmatter.id)) {
        throw new ConfigError(`Skill "${frontmatter.id}" cannot depend on itself (${skillFile})`)
      }
      const { steps, background, goal, knownIssues } = parseSkillBody(body, skillFile)

      skills.set(frontmatter.id, {
        ...frontmatter,
        steps,
        background,
        goal,
        knownIssues,
        sourcePath: skillFile,
      })
    }
  }

  return [...skills.values()]
}
