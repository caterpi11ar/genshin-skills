import type { Page } from 'playwright'
import type { TranscriptWriter } from '../memory/transcript.js'
import type { SkillStep } from '../skills/types.js'

export interface StepContext {
  page: Page
  steps: SkillStep[]
  modelConfig: Record<string, string>
  timeoutMs: number
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
