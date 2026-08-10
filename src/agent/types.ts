import type { Page } from 'playwright'
import type { TranscriptWriter } from '../memory/transcript.js'
import type { SkillStep } from '../skills/types.js'

export interface StepContext {
  skillId: string
  page: Page
  signal: AbortSignal
  steps: SkillStep[]
  modelConfig: Record<string, string>
  streamModelResponses?: boolean
  replanningCycleLimit?: number
  timeoutMs: number
  background?: string
  goal?: string
  knownIssues?: string[]
  transcript?: TranscriptWriter
  screenshotDir?: string
  onProgress?: (step: number, elapsed: number, method: string, prompt: string) => void
}

export interface AgentResult {
  success: boolean
  reason: string
  steps: number
  durationMs: number
}
