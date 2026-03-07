export type StepMethod = 'aiAct' | 'aiTap' | 'aiWaitFor' | 'aiAssert' | 'aiBoolean' | 'keyPress'

export interface SkillStep {
  method: StepMethod
  prompt: string
}

export interface SkillDefinition {
  id: string
  name: string
  description: string
  enabled: boolean
  timeoutMs: number
  retries: number
  steps: SkillStep[]
  background?: string
  knownIssues?: string[]
  sourcePath: string
}
