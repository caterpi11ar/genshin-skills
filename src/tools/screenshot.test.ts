import type { Page } from 'playwright'
import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureScreenshot, saveScreenshot } from './screenshot.js'

describe('screenshot tools', () => {
  const cleanupDirs: string[] = []
  const mode = (value: { mode: number }) => value.mode & 0o777

  afterEach(async () => {
    vi.useRealTimers()
    await Promise.all(cleanupDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })

  it('returns base64 screenshot data', async () => {
    const screenshot = vi.fn(async () => Buffer.from('image'))
    const page = { screenshot } as unknown as Page
    await expect(captureScreenshot(page)).resolves.toBe(Buffer.from('image').toString('base64'))
  })

  it('creates the directory and writes a timestamped checkpoint path', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-07T01:02:03.456Z'))
    const root = await mkdtemp(join(tmpdir(), 'giclaw-shot-'))
    cleanupDirs.push(root)
    const dir = join(root, 'nested')
    const screenshot = vi.fn(async () => Buffer.from('image'))
    const page = { screenshot } as unknown as Page

    const path = await saveScreenshot(page, dir, '../failure secret')

    expect(path).toBe(join(dir, 'failure-secret-2026-08-07T01-02-03-456Z.png'))
    expect(await readFile(path, 'utf-8')).toBe('image')
    expect(mode(await stat(dir))).toBe(0o700)
    expect(mode(await stat(path))).toBe(0o600)
    expect(screenshot).toHaveBeenCalledWith()
  })

  it('uses a safe fallback for labels containing no filename characters', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-07T01:02:03.456Z'))
    const root = await mkdtemp(join(tmpdir(), 'giclaw-shot-'))
    cleanupDirs.push(root)
    const page = { screenshot: vi.fn(async () => Buffer.from('image')) } as unknown as Page

    await expect(saveScreenshot(page, join(root, 'screenshots'), '!!!')).resolves.toBe(
      join(root, 'screenshots', 'screenshot-2026-08-07T01-02-03-456Z.png'),
    )
  })
})
