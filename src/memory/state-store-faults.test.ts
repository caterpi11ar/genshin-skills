import type { Mode, PathLike } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { constants } from 'node:fs'
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logger } from '../utils/logger.js'

const faults = vi.hoisted(() => ({
  failLockWrite: false,
  lstatErrorCode: null as string | null,
  unlinkErrorCode: null as string | null,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const actualOpen = actual.open as (
    path: PathLike,
    flags: string | number,
    mode?: Mode,
  ) => Promise<FileHandle>

  return {
    ...actual,
    open: async (path: PathLike, flags: string | number, mode?: Mode) => {
      const handle = await actualOpen(path, flags, mode)
      const isExclusiveLockCreate = faults.failLockWrite
        && String(path).endsWith('/state.lock')
        && typeof flags === 'number'
        && (flags & constants.O_EXCL) !== 0
      if (!isExclusiveLockCreate)
        return handle

      return new Proxy(handle, {
        get(target, property) {
          if (property === 'writeFile') {
            return async () => {
              const error = new Error('injected lock write failure') as NodeJS.ErrnoException
              error.code = 'EIO'
              throw error
            }
          }
          const value = Reflect.get(target, property)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
    lstat: async (path: PathLike, options?: Parameters<typeof actual.lstat>[1]) => {
      if (faults.lstatErrorCode && String(path).endsWith('/state.lock')) {
        const error = new Error('injected lstat failure') as NodeJS.ErrnoException
        error.code = faults.lstatErrorCode
        throw error
      }
      return actual.lstat(path, options)
    },
    unlink: async (path: PathLike) => {
      if (faults.unlinkErrorCode) {
        const error = new Error('injected unlink failure') as NodeJS.ErrnoException
        error.code = faults.unlinkErrorCode
        throw error
      }
      return actual.unlink(path)
    },
  }
})

const { StateStore } = await import('./state-store.js')

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'giclaw-state-fault-'))
  temporaryDirectories.push(directory)
  return directory
}

beforeEach(() => {
  faults.failLockWrite = false
  faults.lstatErrorCode = null
  faults.unlinkErrorCode = null
  logger.mute()
})

afterEach(async () => {
  faults.failLockWrite = false
  faults.lstatErrorCode = null
  faults.unlinkErrorCode = null
  logger.unmute()
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('state store fault handling', () => {
  it('cleans up an exclusively created lock if writing its metadata fails', async () => {
    const directory = await temporaryDirectory()
    const lock = join(directory, 'state.lock')
    faults.failLockWrite = true
    const store = new StateStore(directory)

    await expect(store.updateAfterRun({
      runId: 'fault',
      trigger: 'manual',
      startedAt: '2026-08-07T00:00:00Z',
      completedAt: '2026-08-07T00:00:01Z',
      results: [{ taskId: 'task', success: true, message: 'ok', durationMs: 1 }],
    })).rejects.toMatchObject({ code: 'EIO' })

    await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(directory, 'state.json'), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('handles an unlink race reported as missing and propagates other unlink errors', async () => {
    const directory = await temporaryDirectory()
    const lock = join(directory, 'state.lock')
    const store = new StateStore(directory)
    const internal = store as unknown as {
      unlinkLockIfUnchanged: (expected: { dev: number, ino: number }) => Promise<boolean>
    }
    await writeFile(lock, 'lock')
    const details = await stat(lock)

    faults.unlinkErrorCode = 'ENOENT'
    await expect(internal.unlinkLockIfUnchanged(details)).resolves.toBe(true)
    faults.unlinkErrorCode = 'EACCES'
    await expect(internal.unlinkLockIfUnchanged(details)).rejects.toMatchObject({ code: 'EACCES' })

    faults.unlinkErrorCode = null
    await unlink(lock)
  })

  it('propagates non-missing lock inspection errors', async () => {
    const directory = await temporaryDirectory()
    const lock = join(directory, 'state.lock')
    const store = new StateStore(directory)
    const internal = store as unknown as {
      unlinkLockIfUnchanged: (expected: { dev: number, ino: number }) => Promise<boolean>
    }
    await writeFile(lock, 'lock')
    const details = await stat(lock)
    faults.lstatErrorCode = 'EACCES'

    await expect(internal.unlinkLockIfUnchanged(details)).rejects.toMatchObject({ code: 'EACCES' })
  })
})
