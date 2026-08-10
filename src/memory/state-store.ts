import type { Stats } from 'node:fs'
import type { PersistedState, RunSummary } from './types.js'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import {
  atomicWritePrivateFile,
  ensurePrivateDir,
  PRIVATE_FILE_MODE,
  securePrivateFile,
  syncPrivateDirectory,
} from '../config/paths.js'
import { delay } from '../utils/delay.js'
import { logger, sanitizeSensitiveData } from '../utils/logger.js'
import { persistedStateSchema, runSummarySchema } from './types.js'

const DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS = 5_000
const DEFAULT_LOCK_RETRY_INTERVAL_MS = 50
const DEFAULT_LOCK_STALE_AFTER_MS = 30_000

export interface StateLockOptions {
  acquireTimeoutMs?: number
  retryIntervalMs?: number
  staleAfterMs?: number
}

interface ResolvedStateLockOptions {
  acquireTimeoutMs: number
  retryIntervalMs: number
  staleAfterMs: number
}

interface StateLockMetadata {
  token: string
  pid: number
  createdAt: string
}

interface LockSnapshot {
  details: Stats
  metadata: StateLockMetadata | null
}

function defaultState(): PersistedState {
  return {
    lastRunId: null,
    lastRunAt: null,
    lastSuccess: null,
    totalRuns: 0,
    history: [],
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code
}

function validatePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive safe integer`)
  return value
}

function resolveLockOptions(options: StateLockOptions): ResolvedStateLockOptions {
  return {
    acquireTimeoutMs: validatePositiveInteger(
      options.acquireTimeoutMs ?? DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS,
      'acquireTimeoutMs',
    ),
    retryIntervalMs: validatePositiveInteger(
      options.retryIntervalMs ?? DEFAULT_LOCK_RETRY_INTERVAL_MS,
      'retryIntervalMs',
    ),
    staleAfterMs: validatePositiveInteger(
      options.staleAfterMs ?? DEFAULT_LOCK_STALE_AFTER_MS,
      'staleAfterMs',
    ),
  }
}

function parseLockMetadata(raw: string): StateLockMetadata | null {
  try {
    const value = JSON.parse(raw) as Partial<StateLockMetadata>
    if (
      typeof value.token !== 'string'
      || value.token.length === 0
      || !Number.isSafeInteger(value.pid)
      || value.pid! <= 0
      || typeof value.createdAt !== 'string'
      || !Number.isFinite(Date.parse(value.createdAt))
    ) {
      return null
    }
    return value as StateLockMetadata
  }
  catch {
    return null
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    return !isErrno(error, 'ESRCH')
  }
}

export class StateStore {
  private state: PersistedState | null = null
  private readonly stateFile: string
  private readonly temporaryFile: string
  private readonly backupFile: string
  private readonly lockFile: string
  private readonly dataDir: string
  private readonly maxHistory: number
  private readonly lockOptions: ResolvedStateLockOptions
  private writeTail: Promise<void> = Promise.resolve()

  constructor(dataDir: string, maxHistory: number = 100, lockOptions: StateLockOptions = {}) {
    this.dataDir = dataDir
    this.stateFile = join(dataDir, 'state.json')
    this.temporaryFile = `${this.stateFile}.tmp`
    this.backupFile = `${this.stateFile}.bak`
    this.lockFile = join(dataDir, 'state.lock')
    this.maxHistory = maxHistory
    this.lockOptions = resolveLockOptions(lockOptions)
  }

  private async loadState(): Promise<PersistedState> {
    if (this.state)
      return this.state

    const loaded = await this.withStateLock(() => this.loadFreshState())
    this.state = loaded
    return loaded
  }

  private async loadFreshState(): Promise<PersistedState> {
    await ensurePrivateDir(this.dataDir)
    const candidates = [this.stateFile, this.temporaryFile, this.backupFile]
    for (const candidate of candidates) {
      try {
        await securePrivateFile(candidate)
      }
      catch (error) {
        logger.warn(`Could not secure state candidate ${candidate}`, error)
      }
    }
    for (const candidate of candidates) {
      const recovered = await this.readCandidate(candidate)
      if (recovered) {
        if (candidate !== this.stateFile) {
          await atomicWritePrivateFile(this.stateFile, this.serialize(recovered))
          logger.warn(`Recovered state from ${candidate}`)
        }
        return recovered
      }
    }

    return defaultState()
  }

  private async readCandidate(path: string): Promise<PersistedState | null> {
    let parsed: unknown
    let state: PersistedState
    try {
      if (!(await securePrivateFile(path)))
        return null
      const raw = await readFile(path, 'utf-8')
      parsed = JSON.parse(raw) as unknown
      state = persistedStateSchema.parse(sanitizeSensitiveData(parsed))
    }
    catch (error) {
      logger.warn(`Ignoring invalid state candidate ${path}`, error)
      return null
    }

    if (JSON.stringify(parsed) !== JSON.stringify(state)) {
      try {
        await atomicWritePrivateFile(path, this.serialize(state))
      }
      catch (error) {
        // The candidate is already validated and safe to use. A best-effort
        // repair failure must not turn readable history into apparent loss.
        logger.warn(`Could not repair state candidate ${path}`, error)
      }
    }
    return state
  }

  private serialize(state: PersistedState): string {
    const validated = persistedStateSchema.parse(sanitizeSensitiveData(state))
    return `${JSON.stringify(validated, null, 2)}\n`
  }

  async load(): Promise<PersistedState> {
    return clone(await this.loadState())
  }

  async save(): Promise<void> {
    return this.enqueueWrite(async () => {
      if (!this.state)
        return
      await this.withStateLock(async () => {
        const state = await this.loadFreshState()
        await this.persist(state)
        this.state = state
      })
    })
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(operation)
    this.writeTail = result.then(() => undefined, () => undefined)
    return result
  }

  private async readLockSnapshot(): Promise<LockSnapshot> {
    const handle = await open(this.lockFile, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const details = await handle.stat()
      if (!details.isFile())
        throw new Error(`State lock is not a regular file: ${this.lockFile}`)
      const raw = await handle.readFile({ encoding: 'utf-8' })
      return { details, metadata: parseLockMetadata(raw) }
    }
    finally {
      await handle.close()
    }
  }

  private async unlinkLockIfUnchanged(expected: Pick<Stats, 'dev' | 'ino'>): Promise<boolean> {
    let current: Stats
    try {
      current = await lstat(this.lockFile)
    }
    catch (error) {
      if (isErrno(error, 'ENOENT'))
        return true
      throw error
    }
    if (current.isSymbolicLink() || !current.isFile())
      throw new Error(`State lock is not a regular file: ${this.lockFile}`)
    if (current.dev !== expected.dev || current.ino !== expected.ino)
      return false

    try {
      await unlink(this.lockFile)
    }
    catch (error) {
      if (!isErrno(error, 'ENOENT'))
        throw error
    }
    await syncPrivateDirectory(this.dataDir)
    return true
  }

  private async recoverStaleLock(): Promise<boolean> {
    let snapshot: LockSnapshot
    try {
      snapshot = await this.readLockSnapshot()
    }
    catch (error) {
      if (isErrno(error, 'ENOENT'))
        return true
      throw error
    }

    if (Date.now() - snapshot.details.mtimeMs < this.lockOptions.staleAfterMs)
      return false
    if (snapshot.metadata && isProcessAlive(snapshot.metadata.pid))
      return false

    const removed = await this.unlinkLockIfUnchanged(snapshot.details)
    if (removed)
      logger.warn(`Recovered stale state lock ${this.lockFile}`)
    return true
  }

  private async releaseStateLock(token: string): Promise<void> {
    let snapshot: LockSnapshot
    try {
      snapshot = await this.readLockSnapshot()
    }
    catch (error) {
      if (isErrno(error, 'ENOENT'))
        return
      throw error
    }
    if (snapshot.metadata?.token !== token) {
      logger.warn(`Refusing to release state lock owned by another process: ${this.lockFile}`)
      return
    }
    if (!(await this.unlinkLockIfUnchanged(snapshot.details)))
      logger.warn(`State lock changed before release: ${this.lockFile}`)
  }

  private async acquireStateLock(): Promise<() => Promise<void>> {
    await ensurePrivateDir(this.dataDir)
    const deadline = Date.now() + this.lockOptions.acquireTimeoutMs
    const token = randomUUID()

    while (true) {
      let handle: Awaited<ReturnType<typeof open>> | undefined
      let createdDetails: Stats | undefined
      try {
        handle = await open(
          this.lockFile,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          PRIVATE_FILE_MODE,
        )
        createdDetails = await handle.stat()
        const metadata: StateLockMetadata = {
          token,
          pid: process.pid,
          createdAt: new Date().toISOString(),
        }
        await handle.writeFile(`${JSON.stringify(metadata)}\n`)
        await handle.chmod(PRIVATE_FILE_MODE)
        await handle.sync()
        await handle.close()
        handle = undefined
        await syncPrivateDirectory(this.dataDir)
        return () => this.releaseStateLock(token)
      }
      catch (error) {
        await handle?.close()
        if (createdDetails)
          await this.unlinkLockIfUnchanged(createdDetails)

        if (!isErrno(error, 'EEXIST'))
          throw error
        if (await this.recoverStaleLock()) {
          if (Date.now() >= deadline)
            throw new Error(`Timed out acquiring state lock: ${this.lockFile}`)
          continue
        }
        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0)
          throw new Error(`Timed out acquiring state lock: ${this.lockFile}`)
        await delay(Math.min(this.lockOptions.retryIntervalMs, remainingMs))
      }
    }
  }

  private async withStateLock<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquireStateLock()
    let failed = false
    let failure: unknown
    let result!: T
    try {
      result = await operation()
    }
    catch (error) {
      failed = true
      failure = error
    }
    try {
      await release()
    }
    catch (error) {
      if (!failed)
        throw error
      logger.warn(`Could not release state lock ${this.lockFile}`, error)
    }
    if (failed)
      throw failure
    return result
  }

  private async persist(state: PersistedState): Promise<void> {
    await ensurePrivateDir(this.dataDir)
    await atomicWritePrivateFile(this.temporaryFile, this.serialize(state))
    const temporaryRaw = await readFile(this.temporaryFile, 'utf-8')
    persistedStateSchema.parse(JSON.parse(temporaryRaw))

    const canonicalState = await this.readCandidate(this.stateFile)
    if (canonicalState)
      await atomicWritePrivateFile(this.backupFile, this.serialize(canonicalState))

    await rename(this.temporaryFile, this.stateFile)
    await syncPrivateDirectory(this.dataDir)
    await securePrivateFile(this.stateFile)
  }

  async updateAfterRun(summary: RunSummary): Promise<void> {
    const validatedSummary = runSummarySchema.parse(sanitizeSensitiveData(summary))
    return this.enqueueWrite(async () => {
      await this.withStateLock(async () => {
        const state = clone(await this.loadFreshState())
        state.lastRunId = validatedSummary.runId
        state.lastRunAt = validatedSummary.completedAt
        state.lastSuccess = validatedSummary.results.every(r => r.success)
        state.totalRuns++
        state.history.push(validatedSummary)
        if (state.history.length > this.maxHistory) {
          state.history = state.history.slice(-this.maxHistory)
        }
        await this.persist(state)
        this.state = state
      })
    })
  }

  async getHistory(limit?: number): Promise<RunSummary[]> {
    const state = await this.loadState()
    const history = state.history
    if (limit && limit < history.length) {
      return clone(history.slice(-limit))
    }
    return clone(history)
  }

  async getState(): Promise<PersistedState> {
    return clone(await this.loadState())
  }
}
