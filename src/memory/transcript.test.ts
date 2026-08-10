import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TranscriptWriter } from './transcript.js'

describe('transcript writer', () => {
  const cleanupDirs: string[] = []
  const mode = (value: { mode: number }) => value.mode & 0o777

  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })

  it('creates its directory and appends one JSON object per line', async () => {
    const root = await mkdtemp(join(tmpdir(), 'giclaw-transcript-'))
    cleanupDirs.push(root)
    const dir = join(root, 'nested', 'transcripts')
    const writer = new TranscriptWriter(dir, 'run-1')

    await writer.append({
      step: 1,
      timestamp: '2026-08-07T00:00:00.000Z',
      method: 'keyPress',
      prompt: 'Bearer transcript-secret sk-123456789012',
      result: 'executed',
    })
    await writer.append({
      step: 2,
      timestamp: '2026-08-07T00:00:01.000Z',
      method: 'aiBoolean',
      prompt: 'done?',
      result: 'executed',
      output: true,
    })
    await writer.append({
      step: 3,
      timestamp: '2026-08-07T00:00:02.000Z',
      method: 'm'.repeat(300),
      prompt: `Bearer prompt-secret ${'p'.repeat(5_000)}`,
      result: 'error',
      errorMessage: `apiKey=error-secret ${'e'.repeat(5_000)}`,
      screenshotPath: `/tmp/${'s'.repeat(5_000)}`,
      output: `sk-123456789012 ${'o'.repeat(5_000)}`,
    })

    expect(writer.getFilePath()).toBe(join(dir, 'run-1.jsonl'))
    const lines = (await readFile(writer.getFilePath(), 'utf-8')).trim().split('\n')
    expect(lines.map(line => JSON.parse(line))).toMatchObject([
      { step: 1, method: 'keyPress', result: 'executed' },
      { step: 2, method: 'aiBoolean', output: true },
      { step: 3, result: 'error' },
    ])
    expect(lines[0]).not.toMatch(/transcript-secret|sk-123/)
    const bounded = JSON.parse(lines[2]!) as Record<string, string>
    expect(bounded.method).toHaveLength(256)
    expect(bounded.prompt).toHaveLength(4_096)
    expect(bounded.errorMessage).toHaveLength(4_096)
    expect(bounded.screenshotPath).toHaveLength(4_096)
    expect(bounded.output).toHaveLength(4_096)
    expect(lines[2]).not.toMatch(/prompt-secret|error-secret|sk-123/)
    expect(mode(await stat(dir))).toBe(0o700)
    expect(mode(await stat(writer.getFilePath()))).toBe(0o600)

    await chmod(writer.getFilePath(), 0o666)
    await writer.append({ step: 4, timestamp: 'now', result: 'done' })
    expect(mode(await stat(writer.getFilePath()))).toBe(0o600)
  })

  it('rejects run IDs that could escape the transcript directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'giclaw-transcript-'))
    cleanupDirs.push(root)
    expect(() => new TranscriptWriter(join(root, 'transcripts'), '../outside')).toThrow('Invalid transcript run ID')
  })
})
