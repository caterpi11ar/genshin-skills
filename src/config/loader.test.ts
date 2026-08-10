import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cleanupDirs: string[] = []
const mode = (value: { mode: number }) => value.mode & 0o777

async function freshLoader() {
  vi.resetModules()
  return import('./loader.js')
}

async function jsonFile(value: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'giclaw-config-'))
  cleanupDirs.push(dir)
  const path = join(dir, 'config.json')
  await writeFile(path, JSON.stringify(value), 'utf-8')
  return path
}

describe('config loader', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })

  it('returns schema defaults when an explicit file is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'giclaw-config-missing-'))
    cleanupDirs.push(dir)
    const { loadConfig } = await freshLoader()
    const config = await loadConfig({ configPath: join(dir, 'missing.json') })

    expect(config.tasks.enabled).toHaveLength(5)
    expect(config.browser.viewport).toEqual({ width: 1280, height: 720 })
  })

  it('deep-merges CLI overrides while replacing arrays', async () => {
    const path = await jsonFile({
      locale: 'zh',
      browser: { headless: true, viewport: { width: 1024, height: 768 } },
      model: { name: 'file-model', baseUrl: 'https://example.test/v1', apiKey: 'file-key' },
      tasks: { enabled: ['welkin-moon', 'claim-mail'] },
    })
    const { getConfig, loadConfig } = await freshLoader()
    const config = await loadConfig({
      configPath: path,
      cliOverrides: {
        browser: { headless: false, viewport: { width: 1920 } },
        tasks: { enabled: ['claim-mail'] },
      },
    })

    expect(config.browser).toMatchObject({
      headless: false,
      viewport: { width: 1920, height: 768 },
    })
    expect(config.tasks.enabled).toEqual(['claim-mail'])
    expect(config.model.name).toBe('file-model')
    expect(getConfig()).toBe(config)
  })

  it('rejects malformed JSON with the source path', async () => {
    const path = await jsonFile({})
    await writeFile(path, '{broken', 'utf-8')
    const { loadConfig } = await freshLoader()

    await expect(loadConfig({ configPath: path })).rejects.toMatchObject({
      name: 'ConfigError',
      code: 'CONFIG_ERROR',
      message: `Failed to parse config file: ${path}`,
    })
  })

  it('rejects values that fail schema validation', async () => {
    const path = await jsonFile({ queue: { maxDepth: 0 } })
    const { loadConfig } = await freshLoader()

    await expect(loadConfig({ configPath: path })).rejects.toThrow('queue.maxDepth')
  })

  it('requires loadConfig before getConfig is used', async () => {
    const { getConfig } = await freshLoader()
    expect(() => getConfig()).toThrow('Config not loaded')
  })

  it('does not modify the source config file', async () => {
    const path = await jsonFile({ browser: { headless: true } })
    const before = await readFile(path, 'utf-8')
    const { loadConfig } = await freshLoader()
    await loadConfig({ configPath: path, cliOverrides: { browser: { headless: false } } })
    expect(await readFile(path, 'utf-8')).toBe(before)
  })

  it('restricts permissions on an existing config file', async () => {
    const path = await jsonFile({})
    await chmod(path, 0o666)
    const { loadConfig } = await freshLoader()

    await loadConfig({ configPath: path })

    expect(mode(await stat(path))).toBe(0o600)
  })

  it('prefers a config.json in the current working directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'giclaw-config-cwd-'))
    const previousCwd = process.cwd()
    await writeFile(join(dir, 'config.json'), JSON.stringify({
      model: { name: 'cwd-model' },
    }), 'utf-8')
    try {
      process.chdir(dir)
      const { loadConfig } = await freshLoader()
      await expect(loadConfig()).resolves.toMatchObject({ model: { name: 'cwd-model' } })
    }
    finally {
      process.chdir(previousCwd)
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('falls back to the state config when the current directory has no config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'giclaw-config-fallback-'))
    const fallbackPath = join(dir, 'state-config.json')
    const previousCwd = process.cwd()
    await writeFile(fallbackPath, JSON.stringify({
      model: { name: 'state-model' },
    }), 'utf-8')
    vi.resetModules()
    const { PATHS } = await import('./paths.js')
    const originalPath = PATHS.configPath
    PATHS.configPath = fallbackPath
    try {
      process.chdir(dir)
      const { loadConfig } = await import('./loader.js')
      await expect(loadConfig()).resolves.toMatchObject({ model: { name: 'state-model' } })
    }
    finally {
      process.chdir(previousCwd)
      PATHS.configPath = originalPath
      await rm(dir, { recursive: true, force: true })
    }
  })
})
