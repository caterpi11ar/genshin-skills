export interface TranscriptEntry {
  step: number
  timestamp: string
  method?: string
  prompt?: string
  result: 'executed' | 'done' | 'error'
  errorMessage?: string
  screenshotPath?: string
}

export interface RunSummary {
  runId: string
  trigger: 'cron' | 'manual' | 'api'
  startedAt: string
  completedAt: string
  results: Array<{
    taskId: string
    success: boolean
    message: string
    durationMs: number
  }>
}

export interface PersistedState {
  lastRunId: string | null
  lastRunAt: string | null
  lastSuccess: boolean | null
  totalRuns: number
  history: RunSummary[]
}
