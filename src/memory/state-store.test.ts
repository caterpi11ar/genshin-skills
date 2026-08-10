import type { PersistedState, RunSummary } from './types.js'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logger } from '../utils/logger.js'
import { StateStore } from './state-store.js'

function summary(id: string, success: boolean): RunSummary {
  return {
    runId: id,
    trigger: 'manual',
    startedAt: `2026-08-07T00:00:0${id}Z`,
    completedAt: `2026-08-07T00:00:1${id}Z`,
    results: [{ taskId: 'task', success, message: success ? 'ok' : 'failed', durationMs: 1 }],
  }
}

const temporaryDirectories: string[] = []
const mode = (value: { mode: number }) => value.mode & 0o777

async function temporaryDirectory(prefix = 'giclaw-state-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(dir)
  return dir
}

beforeEach(() => {
  logger.mute()
})

afterEach(async () => {
  vi.restoreAllMocks()
  logger.unmute()
  await Promise.all(temporaryDirectories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function updateStateFromChildProcess(directory: string, id: string): Promise<void> {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'src/memory/state-store.ts')).href
  const script = `
    import { StateStore } from ${JSON.stringify(moduleUrl)}
    const id = process.env.GICLAW_STATE_TEST_RUN_ID
    const directory = process.env.GICLAW_STATE_TEST_DIR
    await new StateStore(directory, 100, { acquireTimeoutMs: 5000, retryIntervalMs: 2 })
      .updateAfterRun({
        runId: id,
        trigger: 'manual',
        startedAt: '2026-08-07T00:00:00Z',
        completedAt: '2026-08-07T00:00:01Z',
        results: [{ taskId: 'task', success: true, message: 'ok', durationMs: 1 }],
      })
  `
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GICLAW_STATE_TEST_DIR: directory,
        GICLAW_STATE_TEST_RUN_ID: id,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf-8')
    child.stderr.on('data', chunk => stderr += chunk)
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0)
        resolve()
      else
        reject(new Error(`State child failed (${code ?? signal}): ${stderr}`))
    })
  })
}

describe('state store', () => {
  it('does not write before state has been loaded', async () => {
    const dir = await temporaryDirectory('giclaw-state-unloaded-')
    const store = new StateStore(dir)

    await expect(store.save()).resolves.toBeUndefined()
    await expect(readFile(join(dir, 'state.json'), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns an isolated default state when no file exists', async () => {
    const dir = await temporaryDirectory()
    const store = new StateStore(dir)

    await expect(store.getState()).resolves.toEqual({
      lastRunId: null,
      lastRunAt: null,
      lastSuccess: null,
      totalRuns: 0,
      history: [],
    })
  })

  it('explicitly saves state after it has been loaded', async () => {
    const dir = await temporaryDirectory()
    const store = new StateStore(dir)
    await store.load()

    await store.save()

    expect(JSON.parse(await readFile(join(dir, 'state.json'), 'utf-8'))).toMatchObject({
      totalRuns: 0,
      history: [],
    })
  })

  it('persists summaries, success state, history limits, and backups', async () => {
    const dir = await temporaryDirectory()
    const store = new StateStore(dir, 2)

    await store.updateAfterRun(summary('1', true))
    await store.updateAfterRun(summary('2', false))
    await store.updateAfterRun(summary('3', true))

    await expect(store.getState()).resolves.toMatchObject({
      lastRunId: '3',
      lastRunAt: '2026-08-07T00:00:13Z',
      lastSuccess: true,
      totalRuns: 3,
    })
    await expect(store.getHistory()).resolves.toEqual([summary('2', false), summary('3', true)])
    await expect(store.getHistory(1)).resolves.toEqual([summary('3', true)])

    const persisted = JSON.parse(await readFile(join(dir, 'state.json'), 'utf-8'))
    const backup = JSON.parse(await readFile(join(dir, 'state.json.bak'), 'utf-8'))
    expect(persisted.history).toHaveLength(2)
    expect(backup.lastRunId).toBe('2')
    expect(mode(await stat(dir))).toBe(0o700)
    expect(mode(await stat(join(dir, 'state.json')))).toBe(0o600)
    expect(mode(await stat(join(dir, 'state.json.bak')))).toBe(0o600)
  })

  it('recovers from malformed state files', async () => {
    const dir = await temporaryDirectory()
    await writeFile(join(dir, 'state.json'), '{broken', 'utf-8')
    const store = new StateStore(dir)

    await expect(store.getState()).resolves.toMatchObject({ totalRuns: 0, history: [] })
    await store.updateAfterRun(summary('1', true))
    expect(JSON.parse(await readFile(join(dir, 'state.json'), 'utf-8')).lastRunId).toBe('1')
  })

  it('fills missing fields in compatible older state files', async () => {
    const dir = await temporaryDirectory()
    await writeFile(join(dir, 'state.json'), JSON.stringify({ lastRunId: 'legacy-run' }), 'utf-8')
    const store = new StateStore(dir)

    await expect(store.getState()).resolves.toEqual({
      lastRunId: 'legacy-run',
      lastRunAt: null,
      lastSuccess: null,
      totalRuns: 0,
      history: [],
    })
  })

  it('keeps a validated legacy candidate when its best-effort repair fails', async () => {
    const dir = await temporaryDirectory()
    await writeFile(join(dir, 'state.json'), JSON.stringify({ lastRunId: 'legacy-run' }), 'utf-8')
    const store = new StateStore(dir)
    const internal = store as unknown as { serialize: (state: PersistedState) => string }
    internal.serialize = () => {
      throw new Error('repair unavailable')
    }

    await expect(store.getState()).resolves.toMatchObject({
      lastRunId: 'legacy-run',
      totalRuns: 0,
      history: [],
    })
  })

  it('rejects structurally invalid state files and safely resets all fields', async () => {
    const dir = await temporaryDirectory()
    await writeFile(join(dir, 'state.json'), JSON.stringify({
      lastRunId: 42,
      lastRunAt: [],
      lastSuccess: 'yes',
      totalRuns: -1,
      history: [{ runId: 'broken' }],
    }), 'utf-8')
    const store = new StateStore(dir)

    await expect(store.getState()).resolves.toEqual({
      lastRunId: null,
      lastRunAt: null,
      lastSuccess: null,
      totalRuns: 0,
      history: [],
    })
  })

  it('loads candidates in canonical, temporary, then backup order and restores canonical state', async () => {
    const canonicalDir = await temporaryDirectory()
    await writeFile(join(canonicalDir, 'state.json'), JSON.stringify({ lastRunId: 'canonical' }), 'utf-8')
    await writeFile(join(canonicalDir, 'state.json.tmp'), JSON.stringify({ lastRunId: 'temporary' }), 'utf-8')
    await writeFile(join(canonicalDir, 'state.json.bak'), JSON.stringify({ lastRunId: 'backup' }), 'utf-8')
    await expect(new StateStore(canonicalDir).getState()).resolves.toMatchObject({ lastRunId: 'canonical' })

    const temporaryDir = await temporaryDirectory()
    await writeFile(join(temporaryDir, 'state.json'), '{broken', 'utf-8')
    await writeFile(join(temporaryDir, 'state.json.tmp'), JSON.stringify({ lastRunId: 'temporary' }), 'utf-8')
    await writeFile(join(temporaryDir, 'state.json.bak'), JSON.stringify({ lastRunId: 'backup' }), 'utf-8')
    await expect(new StateStore(temporaryDir).getState()).resolves.toMatchObject({ lastRunId: 'temporary' })
    expect(JSON.parse(await readFile(join(temporaryDir, 'state.json'), 'utf-8')).lastRunId).toBe('temporary')

    const backupDir = await temporaryDirectory()
    await writeFile(join(backupDir, 'state.json'), '{broken', 'utf-8')
    await writeFile(join(backupDir, 'state.json.tmp'), '{broken', 'utf-8')
    await writeFile(join(backupDir, 'state.json.bak'), JSON.stringify({ lastRunId: 'backup' }), 'utf-8')
    await expect(new StateStore(backupDir).getState()).resolves.toMatchObject({ lastRunId: 'backup' })
    expect(JSON.parse(await readFile(join(backupDir, 'state.json'), 'utf-8')).lastRunId).toBe('backup')

    for (const path of [
      join(canonicalDir, 'state.json'),
      join(canonicalDir, 'state.json.tmp'),
      join(canonicalDir, 'state.json.bak'),
      join(temporaryDir, 'state.json'),
      join(temporaryDir, 'state.json.tmp'),
      join(temporaryDir, 'state.json.bak'),
      join(backupDir, 'state.json'),
      join(backupDir, 'state.json.tmp'),
      join(backupDir, 'state.json.bak'),
    ]) {
      expect(mode(await stat(path))).toBe(0o600)
    }
  })

  it('keeps the valid canonical file if writing its temporary replacement fails', async () => {
    const dir = await temporaryDirectory()
    const store = new StateStore(dir)
    await store.updateAfterRun(summary('1', true))
    await mkdir(join(dir, 'state.json.tmp'))

    await expect(store.updateAfterRun(summary('2', true))).rejects.toBeDefined()

    const diskState = JSON.parse(await readFile(join(dir, 'state.json'), 'utf-8'))
    expect(diskState.lastRunId).toBe('1')
    await expect(store.getState()).resolves.toMatchObject({ lastRunId: '1', totalRuns: 1 })
    await expect(new StateStore(dir).getState()).resolves.toMatchObject({ lastRunId: '1' })
  })

  it('redacts secrets from state strings before they reach memory or disk', async () => {
    const dir = await temporaryDirectory()
    const store = new StateStore(dir)
    const unsafe = summary('1', false)
    unsafe.results[0]!.message = 'Bearer bearer-secret apiKey=query-secret sk-123456789012'

    await store.updateAfterRun(unsafe)

    const state = await store.getState()
    expect(state.history[0]!.results[0]!.message).not.toMatch(/bearer-secret|query-secret|sk-123/)
    expect(await readFile(join(dir, 'state.json'), 'utf-8')).not.toMatch(/bearer-secret|query-secret|sk-123/)
  })

  it('sanitizes secrets already present in a state candidate', async () => {
    const dir = await temporaryDirectory()
    const unsafe = summary('1', false)
    unsafe.results[0]!.message = 'Bearer old-bearer-secret token=old-query-secret'
    await writeFile(join(dir, 'state.json'), JSON.stringify({ history: [unsafe] }), 'utf-8')

    const state = await new StateStore(dir).getState()

    expect(state.history[0]!.results[0]!.message).not.toMatch(/old-bearer-secret|old-query-secret/)
    expect(await readFile(join(dir, 'state.json'), 'utf-8')).not.toMatch(/old-bearer-secret|old-query-secret/)
  })

  it('serializes concurrent updates without losing runs or colliding on temporary files', async () => {
    const dir = await temporaryDirectory()
    const store = new StateStore(dir)

    await Promise.all([
      store.updateAfterRun(summary('1', true)),
      store.updateAfterRun(summary('2', false)),
    ])

    await expect(store.getState()).resolves.toMatchObject({
      lastRunId: '2',
      totalRuns: 2,
      history: [{ runId: '1' }, { runId: '2' }],
    })
  })

  it('serializes concurrent updates across independent store instances', async () => {
    const dir = await temporaryDirectory()
    const first = new StateStore(dir, 100, { acquireTimeoutMs: 1_000, retryIntervalMs: 2 })
    const second = new StateStore(dir, 100, { acquireTimeoutMs: 1_000, retryIntervalMs: 2 })

    await Promise.all([
      first.updateAfterRun(summary('1', true)),
      second.updateAfterRun(summary('2', false)),
    ])

    const persisted = await new StateStore(dir).getState()
    expect(persisted.totalRuns).toBe(2)
    expect(persisted.history.map(run => run.runId).sort()).toEqual(['1', '2'])
    await expect(stat(join(dir, 'state.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('serializes updates made by separate operating-system processes', async () => {
    const dir = await temporaryDirectory()

    await Promise.all([
      updateStateFromChildProcess(dir, 'child-1'),
      updateStateFromChildProcess(dir, 'child-2'),
    ])

    const persisted = JSON.parse(await readFile(join(dir, 'state.json'), 'utf-8')) as PersistedState
    expect(persisted.totalRuns).toBe(2)
    expect(persisted.history.map(run => run.runId).sort()).toEqual(['child-1', 'child-2'])
    await expect(stat(join(dir, 'state.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 10_000)

  it('creates a private lock and removes it after the operation completes', async () => {
    const dir = await temporaryDirectory()
    const store = new StateStore(dir)
    const internal = store as unknown as {
      loadFreshState: () => Promise<PersistedState>
    }
    const loadFreshState = internal.loadFreshState.bind(store)
    let continueLoad!: () => void
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      continueLoad = resolve
    })
    internal.loadFreshState = async () => {
      markStarted()
      await blocked
      return loadFreshState()
    }

    const update = store.updateAfterRun(summary('1', true))
    await started
    expect(mode(await stat(join(dir, 'state.lock')))).toBe(0o600)
    continueLoad()
    await update

    await expect(stat(join(dir, 'state.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('recovers sufficiently old locks left by dead processes or invalid metadata', async () => {
    const old = new Date(Date.now() - 60_000)

    const deadProcessDir = await temporaryDirectory()
    const deadProcessLock = join(deadProcessDir, 'state.lock')
    await writeFile(deadProcessLock, JSON.stringify({
      token: 'abandoned',
      pid: 99_999_999,
      createdAt: old.toISOString(),
    }))
    await utimes(deadProcessLock, old, old)
    const recoveredDeadProcess = new StateStore(deadProcessDir, 100, {
      acquireTimeoutMs: 500,
      retryIntervalMs: 2,
      staleAfterMs: 10,
    })
    await recoveredDeadProcess.updateAfterRun(summary('1', true))
    await expect(recoveredDeadProcess.getState()).resolves.toMatchObject({ totalRuns: 1 })
    await expect(stat(deadProcessLock)).rejects.toMatchObject({ code: 'ENOENT' })

    const invalidMetadataDir = await temporaryDirectory()
    const invalidMetadataLock = join(invalidMetadataDir, 'state.lock')
    await writeFile(invalidMetadataLock, '{invalid')
    await utimes(invalidMetadataLock, old, old)
    const recoveredInvalidMetadata = new StateStore(invalidMetadataDir, 100, {
      acquireTimeoutMs: 500,
      retryIntervalMs: 2,
      staleAfterMs: 10,
    })
    await recoveredInvalidMetadata.updateAfterRun(summary('2', true))
    await expect(recoveredInvalidMetadata.getState()).resolves.toMatchObject({ totalRuns: 1 })
    await expect(stat(invalidMetadataLock)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('treats every structurally invalid lock record as invalid metadata', async () => {
    const dir = await temporaryDirectory()
    const lock = join(dir, 'state.lock')
    const store = new StateStore(dir)
    const internal = store as unknown as {
      readLockSnapshot: () => Promise<{ metadata: unknown }>
    }
    const invalidRecords = [
      null,
      {},
      { token: '', pid: 1, createdAt: new Date().toISOString() },
      { token: 'token', pid: 1.5, createdAt: new Date().toISOString() },
      { token: 'token', pid: 0, createdAt: new Date().toISOString() },
      { token: 'token', pid: 1, createdAt: 123 },
      { token: 'token', pid: 1, createdAt: 'not-a-date' },
    ]

    for (const record of invalidRecords) {
      await writeFile(lock, JSON.stringify(record))
      await expect(internal.readLockSnapshot()).resolves.toMatchObject({ metadata: null })
    }
  })

  it('does not recover fresh invalid lock metadata before the stale threshold', async () => {
    const dir = await temporaryDirectory()
    const lock = join(dir, 'state.lock')
    await writeFile(lock, '{invalid')
    const store = new StateStore(dir, 100, {
      acquireTimeoutMs: 20,
      retryIntervalMs: 2,
      staleAfterMs: 60_000,
    })

    await expect(store.updateAfterRun(summary('1', true))).rejects.toThrow('Timed out acquiring state lock')
    expect(await readFile(lock, 'utf-8')).toBe('{invalid')
    await expect(readFile(join(dir, 'state.json'), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('honors the acquisition deadline even when stale-lock recovery consumes it', async () => {
    const dir = await temporaryDirectory()
    const lock = join(dir, 'state.lock')
    await writeFile(lock, '{invalid')
    await utimes(lock, new Date(0), new Date(0))
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_001)
    const store = new StateStore(dir, 100, {
      acquireTimeoutMs: 1,
      retryIntervalMs: 1,
      staleAfterMs: 1,
    })

    await expect(store.updateAfterRun(summary('1', true))).rejects.toThrow('Timed out acquiring state lock')
    await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(dir, 'state.json'), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('times out on a live owner without overwriting canonical state', async () => {
    const dir = await temporaryDirectory()
    await new StateStore(dir).updateAfterRun(summary('1', true))
    const lock = join(dir, 'state.lock')
    const old = new Date(Date.now() - 60_000)
    await writeFile(lock, JSON.stringify({
      token: 'live-owner',
      pid: process.pid,
      createdAt: old.toISOString(),
    }), { mode: 0o600 })
    await utimes(lock, old, old)

    const contender = new StateStore(dir, 100, {
      acquireTimeoutMs: 25,
      retryIntervalMs: 2,
      staleAfterMs: 10,
    })
    await expect(contender.updateAfterRun(summary('2', false))).rejects.toThrow('Timed out acquiring state lock')

    expect(JSON.parse(await readFile(join(dir, 'state.json'), 'utf-8'))).toMatchObject({
      lastRunId: '1',
      totalRuns: 1,
    })
    expect(JSON.parse(await readFile(lock, 'utf-8'))).toMatchObject({ token: 'live-owner' })
  })

  it('treats process-inspection permission errors as a live lock owner', async () => {
    const dir = await temporaryDirectory()
    const lock = join(dir, 'state.lock')
    const old = new Date(Date.now() - 60_000)
    await writeFile(lock, JSON.stringify({
      token: 'protected-owner',
      pid: 42,
      createdAt: old.toISOString(),
    }))
    await utimes(lock, old, old)
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const error = new Error('not permitted') as NodeJS.ErrnoException
      error.code = 'EPERM'
      throw error
    })
    const store = new StateStore(dir, 100, {
      acquireTimeoutMs: 20,
      retryIntervalMs: 2,
      staleAfterMs: 10,
    })

    await expect(store.updateAfterRun(summary('1', true))).rejects.toThrow('Timed out acquiring state lock')
    expect(JSON.parse(await readFile(lock, 'utf-8'))).toMatchObject({ token: 'protected-owner' })
  })

  it('rejects lock directories and symbolic links without touching external targets', async () => {
    const directoryLockDir = await temporaryDirectory()
    await mkdir(join(directoryLockDir, 'state.lock'))
    await expect(new StateStore(directoryLockDir).getState()).rejects.toThrow('not a regular file')

    const symlinkLockDir = await temporaryDirectory()
    const external = join(await temporaryDirectory(), 'external-lock')
    await writeFile(external, 'external')
    await symlink(external, join(symlinkLockDir, 'state.lock'))
    await expect(new StateStore(symlinkLockDir).getState()).rejects.toBeDefined()
    expect(await readFile(external, 'utf-8')).toBe('external')
  })

  it('never releases a lock whose ownership token changed during an operation', async () => {
    const dir = await temporaryDirectory()
    const lock = join(dir, 'state.lock')
    const store = new StateStore(dir)
    const internal = store as unknown as { loadFreshState: () => Promise<PersistedState> }
    const loadFreshState = internal.loadFreshState.bind(store)
    internal.loadFreshState = async () => {
      await writeFile(lock, JSON.stringify({
        token: 'replacement-owner',
        pid: process.pid,
        createdAt: new Date().toISOString(),
      }))
      return loadFreshState()
    }

    await store.updateAfterRun(summary('1', true))

    expect(JSON.parse(await readFile(lock, 'utf-8'))).toMatchObject({ token: 'replacement-owner' })
    await unlink(lock)
  })

  it('handles missing, non-file, and changed lock identities without unsafe deletion', async () => {
    const dir = await temporaryDirectory()
    const lock = join(dir, 'state.lock')
    const store = new StateStore(dir)
    const internal = store as unknown as {
      recoverStaleLock: () => Promise<boolean>
      unlinkLockIfUnchanged: (expected: { dev: number, ino: number }) => Promise<boolean>
    }

    await expect(internal.recoverStaleLock()).resolves.toBe(true)
    await expect(internal.unlinkLockIfUnchanged({ dev: 0, ino: 0 })).resolves.toBe(true)

    await mkdir(lock)
    await expect(internal.unlinkLockIfUnchanged({ dev: 0, ino: 0 })).rejects.toThrow('not a regular file')
    await rm(lock, { recursive: true })

    await writeFile(lock, 'lock')
    await expect(internal.unlinkLockIfUnchanged({ dev: 0, ino: 0 })).resolves.toBe(false)
    expect(await readFile(lock, 'utf-8')).toBe('lock')
  })

  it('leaves a changed lock inode in place when release observes an ownership race', async () => {
    const dir = await temporaryDirectory()
    const lock = join(dir, 'state.lock')
    const store = new StateStore(dir)
    const internal = store as unknown as {
      unlinkLockIfUnchanged: (expected: { dev: number, ino: number }) => Promise<boolean>
    }
    internal.unlinkLockIfUnchanged = async () => false

    await store.updateAfterRun(summary('1', true))

    await expect(readFile(lock, 'utf-8')).resolves.toContain('"token"')
    await unlink(lock)
  })

  it('tolerates its lock disappearing immediately before release', async () => {
    const dir = await temporaryDirectory()
    const lock = join(dir, 'state.lock')
    const store = new StateStore(dir)
    const internal = store as unknown as { loadFreshState: () => Promise<PersistedState> }
    const loadFreshState = internal.loadFreshState.bind(store)
    internal.loadFreshState = async () => {
      const state = await loadFreshState()
      await unlink(lock)
      return state
    }

    await expect(store.updateAfterRun(summary('1', true))).resolves.toBeUndefined()
    await expect(store.getState()).resolves.toMatchObject({ totalRuns: 1 })
  })

  it('preserves the primary operation error when lock release also fails', async () => {
    const dir = await temporaryDirectory()
    const lock = join(dir, 'state.lock')
    const store = new StateStore(dir)
    const internal = store as unknown as { loadFreshState: () => Promise<PersistedState> }
    internal.loadFreshState = async () => {
      await unlink(lock)
      await mkdir(lock)
      throw new Error('primary operation failure')
    }

    await expect(store.updateAfterRun(summary('1', true))).rejects.toThrow('primary operation failure')
  })

  it('reports a release failure after an otherwise successful state write', async () => {
    const dir = await temporaryDirectory()
    const lock = join(dir, 'state.lock')
    const store = new StateStore(dir)
    const internal = store as unknown as { loadFreshState: () => Promise<PersistedState> }
    const loadFreshState = internal.loadFreshState.bind(store)
    internal.loadFreshState = async () => {
      const state = await loadFreshState()
      await unlink(lock)
      await mkdir(lock)
      return state
    }

    await expect(store.updateAfterRun(summary('1', true))).rejects.toThrow('not a regular file')
    expect(JSON.parse(await readFile(join(dir, 'state.json'), 'utf-8'))).toMatchObject({ totalRuns: 1 })
  })

  it('rejects invalid lock timing options', async () => {
    const dir = await temporaryDirectory()

    expect(() => new StateStore(dir, 100, { acquireTimeoutMs: 0 })).toThrow('acquireTimeoutMs')
    expect(() => new StateStore(dir, 100, { retryIntervalMs: 1.5 })).toThrow('retryIntervalMs')
    expect(() => new StateStore(dir, 100, { staleAfterMs: -1 })).toThrow('staleAfterMs')
  })

  it('repairs permissions on existing state directories and files', async () => {
    const dir = await temporaryDirectory()
    const path = join(dir, 'state.json')
    await writeFile(path, JSON.stringify({}), 'utf-8')
    await chmod(dir, 0o777)
    await chmod(path, 0o666)

    await new StateStore(dir).getState()

    expect(mode(await stat(dir))).toBe(0o700)
    expect(mode(await stat(path))).toBe(0o600)
  })

  it('does not expose mutable state or history references', async () => {
    const dir = await temporaryDirectory()
    const store = new StateStore(dir)
    const original = summary('1', true)
    await store.updateAfterRun(original)

    const state = await store.getState()
    state.lastRunId = 'mutated'
    state.history[0]!.results[0]!.message = 'mutated through state'
    const history = await store.getHistory()
    history[0]!.results[0]!.message = 'mutated through history'
    const loaded = await store.load()
    loaded.history[0]!.results[0]!.message = 'mutated through load'
    original.results[0]!.message = 'mutated through input'

    await expect(store.getState()).resolves.toMatchObject({
      lastRunId: '1',
      history: [{ results: [{ message: 'ok' }] }],
    })
    await expect(store.getHistory()).resolves.toMatchObject([
      { results: [{ message: 'ok' }] },
    ])
  })

  it('rejects invalid run summaries before they can corrupt in-memory state', async () => {
    const dir = await temporaryDirectory()
    const store = new StateStore(dir)
    const invalid = summary('1', true)
    invalid.results[0]!.durationMs = -1

    await expect(store.updateAfterRun(invalid)).rejects.toThrow()
    await expect(store.getState()).resolves.toEqual({
      lastRunId: null,
      lastRunAt: null,
      lastSuccess: null,
      totalRuns: 0,
      history: [],
    })
  })

  it('returns all history when the limit is absent or larger than history', async () => {
    const dir = await temporaryDirectory()
    const store = new StateStore(dir)
    await store.updateAfterRun(summary('1', true))

    await expect(store.getHistory()).resolves.toHaveLength(1)
    await expect(store.getHistory(20)).resolves.toHaveLength(1)
  })
})
