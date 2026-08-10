import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { atomicWritePrivateFile, ensurePrivateDir, ensureStateDir, initStateDir, PATHS, securePrivateFile, syncPrivateDirectory } from './paths.js'

const mode = (value: { mode: number }) => value.mode & 0o777

describe('configuration paths', () => {
  let root: string
  let original: typeof PATHS

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'giclaw-paths-'))
    original = { ...PATHS }
    Object.assign(PATHS, {
      stateDir: join(root, '.giclaw'),
      configPath: join(root, '.giclaw', 'config.json'),
      cookiePath: join(root, '.giclaw', 'cookies.json'),
      dataDir: join(root, '.giclaw', 'data'),
      transcriptsDir: join(root, '.giclaw', 'data', 'transcripts'),
      screenshotDir: join(root, '.giclaw', 'data', 'screenshots'),
      skillsDir: join(root, '.giclaw', 'skills'),
    })
  })

  afterEach(async () => {
    Object.assign(PATHS, original)
    await rm(root, { recursive: true, force: true })
  })

  it('creates every runtime directory idempotently', async () => {
    await ensureStateDir()
    await ensureStateDir()

    await expect(Promise.all([
      PATHS.stateDir,
      PATHS.dataDir,
      PATHS.transcriptsDir,
      PATHS.screenshotDir,
      PATHS.skillsDir,
    ].map(path => access(path)))).resolves.toBeDefined()
    for (const path of [PATHS.stateDir, PATHS.dataDir, PATHS.transcriptsDir, PATHS.screenshotDir, PATHS.skillsDir])
      expect(mode(await stat(path))).toBe(0o700)

    await chmod(PATHS.dataDir, 0o777)
    await ensureStateDir()
    expect(mode(await stat(PATHS.dataDir))).toBe(0o700)
  })

  it('writes defaults once and never overwrites an existing config', async () => {
    await expect(initStateDir()).resolves.toEqual({ created: [PATHS.configPath] })
    const defaults = JSON.parse(await readFile(PATHS.configPath, 'utf-8')) as Record<string, unknown>
    expect(defaults).toMatchObject({
      locale: 'zh',
      model: { name: '', baseUrl: '', apiKey: '' },
      browser: {},
      tasks: {},
      schedule: {},
    })
    expect(mode(await stat(PATHS.configPath))).toBe(0o600)

    await chmod(PATHS.configPath, 0o666)
    await expect(initStateDir()).resolves.toEqual({ created: [] })
    expect(JSON.parse(await readFile(PATHS.configPath, 'utf-8'))).toEqual(defaults)
    expect(mode(await stat(PATHS.configPath))).toBe(0o600)
  })

  it('atomically replaces private files without widening permissions', async () => {
    const path = join(root, 'private', 'value.json')
    await atomicWritePrivateFile(path, 'old')
    await chmod(path, 0o666)

    await atomicWritePrivateFile(path, 'new')

    expect(await readFile(path, 'utf-8')).toBe('new')
    expect(mode(await stat(path))).toBe(0o600)
    expect(mode(await stat(join(root, 'private')))).toBe(0o700)

    await expect(atomicWritePrivateFile(join(root, 'private', 'invalid'), null as unknown as string)).rejects.toBeDefined()
    expect(await readdir(join(root, 'private'))).toEqual(['value.json'])
  })

  it('syncs only real directories without following symbolic links', async () => {
    const directory = join(root, 'private')
    const file = join(root, 'value')
    const link = join(root, 'linked-directory')
    await ensurePrivateDir(directory)
    await writeFile(file, 'not a directory')
    await symlink(directory, link)

    await expect(syncPrivateDirectory(directory)).resolves.toBeUndefined()
    await expect(syncPrivateDirectory(file)).rejects.toBeDefined()
    await expect(syncPrivateDirectory(link)).rejects.toBeDefined()
  })

  it('repairs all existing sensitive files in managed directories', async () => {
    await ensureStateDir()
    const files = [
      PATHS.configPath,
      PATHS.cookiePath,
      join(PATHS.dataDir, 'state.json'),
      join(PATHS.dataDir, 'state.json.bak'),
      join(PATHS.dataDir, 'state.json.tmp'),
      join(PATHS.transcriptsDir, 'run.jsonl'),
      join(PATHS.screenshotDir, 'shot.png'),
    ]
    for (const path of files) {
      await writeFile(path, 'private', { mode: 0o666 })
      await chmod(path, 0o666)
    }
    const nestedDir = join(PATHS.transcriptsDir, 'nested')
    const nestedFile = join(nestedDir, 'nested.jsonl')
    const skillDir = join(PATHS.skillsDir, 'custom')
    const skillScript = join(skillDir, 'tool.sh')
    await mkdir(nestedDir)
    await chmod(nestedDir, 0o777)
    await writeFile(nestedFile, 'private')
    await chmod(nestedFile, 0o666)
    await mkdir(skillDir)
    await chmod(skillDir, 0o777)
    await writeFile(skillScript, '#!/bin/sh\n', { mode: 0o755 })
    await chmod(skillScript, 0o755)

    await ensureStateDir()

    for (const path of files)
      expect(mode(await stat(path))).toBe(0o600)
    expect(mode(await stat(nestedDir))).toBe(0o700)
    expect(mode(await stat(nestedFile))).toBe(0o600)
    expect(mode(await stat(skillDir))).toBe(0o700)
    expect(mode(await stat(skillScript))).toBe(0o755)
  })

  it('rejects symlink state directories', async () => {
    const target = join(root, 'target')
    await atomicWritePrivateFile(join(target, 'value'), 'safe')
    await atomicWritePrivateFile(join(PATHS.stateDir, 'seed'), 'safe')
    await symlink(target, PATHS.dataDir)

    await expect(ensureStateDir()).rejects.toBeDefined()
    await expect(securePrivateFile(target)).rejects.toThrow('not a regular file')
    expect(await readFile(join(target, 'value'), 'utf-8')).toBe('safe')
  })

  it('rejects symlink private files without changing their targets', async () => {
    const target = join(root, 'target.json')
    const link = join(root, 'link.json')
    await atomicWritePrivateFile(target, 'safe')
    await symlink(target, link)

    await expect(securePrivateFile(link)).rejects.toBeDefined()
    await ensureStateDir()
    await symlink(target, join(PATHS.transcriptsDir, 'linked.jsonl'))
    await expect(ensureStateDir()).rejects.toBeDefined()
    expect(await readFile(target, 'utf-8')).toBe('safe')
  })
})
