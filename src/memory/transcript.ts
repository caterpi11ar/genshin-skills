import type { TranscriptEntry } from './types.js'
import { join } from 'node:path'
import { appendPrivateFile } from '../config/paths.js'
import { sanitizeBoundedText, sanitizeSensitiveData } from '../utils/logger.js'

/**
 * Append-only JSONL writer for execution transcripts.
 */
export class TranscriptWriter {
  private filePath: string
  private initialized = false

  constructor(transcriptsDir: string, runId: string) {
    if (!/^[\w.-]+$/.test(runId) || runId === '.' || runId === '..')
      throw new Error('Invalid transcript run ID')
    this.filePath = join(transcriptsDir, `${runId}.jsonl`)
  }

  async append(entry: TranscriptEntry): Promise<void> {
    if (!this.initialized) {
      this.initialized = true
    }
    const sanitized = sanitizeSensitiveData(entry) as TranscriptEntry
    if (sanitized.method !== undefined)
      sanitized.method = sanitizeBoundedText(sanitized.method, 256)
    if (sanitized.prompt !== undefined)
      sanitized.prompt = sanitizeBoundedText(sanitized.prompt)
    if (sanitized.errorMessage !== undefined)
      sanitized.errorMessage = sanitizeBoundedText(sanitized.errorMessage)
    if (sanitized.screenshotPath !== undefined)
      sanitized.screenshotPath = sanitizeBoundedText(sanitized.screenshotPath)
    if (typeof sanitized.output === 'string')
      sanitized.output = sanitizeBoundedText(sanitized.output)
    const line = `${JSON.stringify(sanitized)}\n`
    await appendPrivateFile(this.filePath, line)
  }

  getFilePath(): string {
    return this.filePath
  }
}
