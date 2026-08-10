import type { Cookie } from './cookie-store.js'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deleteCookies, loadCookies, saveCookies } from './cookie-store.js'

describe('cookie store', () => {
  const cleanupDirs: string[] = []
  const mode = (value: { mode: number }) => value.mode & 0o777

  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })

  it('returns null for a missing cookie file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'giclaw-cookies-'))
    cleanupDirs.push(dir)
    await expect(loadCookies(join(dir, 'missing.json'))).resolves.toBeNull()
  })

  it('round-trips Playwright-compatible cookies', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'giclaw-cookies-'))
    cleanupDirs.push(dir)
    const path = join(dir, 'cookies.json')
    const cookies = [{
      name: 'session',
      value: 'secret',
      domain: '.example.test',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax' as const,
    }]

    await saveCookies(path, cookies)

    await expect(loadCookies(path)).resolves.toEqual(cookies)
    expect(JSON.parse(await readFile(path, 'utf-8'))).toEqual(cookies)
    expect(mode(await stat(path))).toBe(0o600)
    expect(mode(await stat(dir))).toBe(0o700)

    await chmod(path, 0o666)
    await expect(loadCookies(path)).resolves.toEqual(cookies)
    expect(mode(await stat(path))).toBe(0o600)
  })

  it('treats malformed cookie JSON as unavailable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'giclaw-cookies-'))
    cleanupDirs.push(dir)
    const path = join(dir, 'cookies.json')
    await writeFile(path, '{bad', 'utf-8')

    await expect(loadCookies(path)).resolves.toBeNull()

    await writeFile(path, JSON.stringify({ name: 'not-an-array' }), 'utf-8')
    await expect(loadCookies(path)).resolves.toBeNull()
  })

  it('rejects invalid cookies without overwriting a valid cookie file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'giclaw-cookies-'))
    cleanupDirs.push(dir)
    const path = join(dir, 'cookies.json')
    const valid = [{ name: 'session', value: 'safe' }]
    await saveCookies(path, valid)

    await expect(saveCookies(path, [{ name: 'missing-value' } as Cookie])).rejects.toThrow()

    await expect(loadCookies(path)).resolves.toEqual(valid)
  })

  it('deletes existing files and ignores missing files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'giclaw-cookies-'))
    cleanupDirs.push(dir)
    const path = join(dir, 'cookies.json')
    await writeFile(path, '[]', 'utf-8')

    await expect(deleteCookies(path)).resolves.toBeUndefined()
    await expect(loadCookies(path)).resolves.toBeNull()
    await expect(deleteCookies(path)).resolves.toBeUndefined()
  })

  it('propagates deletion errors other than a missing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'giclaw-cookie-directory-'))
    cleanupDirs.push(dir)

    await expect(deleteCookies(dir)).rejects.toBeDefined()
  })
})
