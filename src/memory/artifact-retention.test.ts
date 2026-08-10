import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertRegularArtifact,
  assertUnchangedArtifact,
  enforceArtifactRetention,
  resolveArtifactPath,
} from './artifact-retention.js'

const cleanupDirectories: string[] = []
const mode = (value: { mode: number }) => value.mode & 0o777

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'giclaw-retention-'))
  cleanupDirectories.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(cleanupDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('artifact retention', () => {
  it('deletes oldest dedicated artifacts until file and byte limits are satisfied', async () => {
    const root = await temporaryRoot()
    const directory = join(root, 'transcripts')
    await mkdir(directory)
    const paths = ['a.jsonl', 'b.jsonl', 'c.jsonl'].map(name => join(directory, name))
    for (const [index, path] of paths.entries()) {
      await writeFile(path, '1234', { mode: 0o666 })
      await chmod(path, 0o666)
      const modifiedAt = index < 2 ? 1 : 3
      await utimes(path, modifiedAt, modifiedAt)
    }
    await writeFile(join(directory, 'keep.txt'), 'unmanaged')

    await expect(enforceArtifactRetention(directory, { maxFiles: 2, maxBytes: 8 })).resolves.toEqual({
      deleted: [paths[0]],
      retainedFiles: 2,
      retainedBytes: 8,
    })
    await expect(readFile(paths[0]!, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(directory, 'keep.txt'), 'utf-8')).toBe('unmanaged')
    expect(mode(await stat(directory))).toBe(0o700)
    expect(mode(await stat(paths[1]!))).toBe(0o600)
    expect(mode(await stat(paths[2]!))).toBe(0o600)
  })

  it('enforces one combined limit across transcript and screenshot directories', async () => {
    const root = await temporaryRoot()
    const transcripts = join(root, 'transcripts')
    const screenshots = join(root, 'screenshots')
    await mkdir(transcripts)
    await mkdir(screenshots)
    const oldestScreenshot = join(screenshots, 'old.png')
    const middleTranscript = join(transcripts, 'middle.jsonl')
    const newestScreenshot = join(screenshots, 'new.png')
    for (const [index, path] of [oldestScreenshot, middleTranscript, newestScreenshot].entries()) {
      await writeFile(path, '1234')
      await utimes(path, index + 1, index + 1)
    }

    await expect(enforceArtifactRetention(
      [transcripts, screenshots],
      { maxFiles: 2, maxBytes: 8 },
    )).resolves.toEqual({
      deleted: [oldestScreenshot],
      retainedFiles: 2,
      retainedBytes: 8,
    })
    await expect(readFile(oldestScreenshot, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(middleTranscript, 'utf-8')).resolves.toBe('1234')
    await expect(readFile(newestScreenshot, 'utf-8')).resolves.toBe('1234')
  })

  it('supports missing dedicated directories and validates limits and directory scope', async () => {
    const root = await temporaryRoot()
    await expect(enforceArtifactRetention(join(root, 'screenshots'), { maxFiles: 1, maxBytes: 1 })).resolves.toEqual({
      deleted: [],
      retainedFiles: 0,
      retainedBytes: 0,
    })
    await expect(enforceArtifactRetention(join(root, 'other'), { maxFiles: 1, maxBytes: 1 })).rejects.toThrow('restricted')
    await expect(enforceArtifactRetention([], { maxFiles: 1, maxBytes: 1 })).rejects.toThrow('At least one')
    await expect(enforceArtifactRetention([join(root, 'screenshots'), join(root, 'screenshots')], { maxFiles: 1, maxBytes: 1 })).rejects.toThrow('unique')
    await expect(enforceArtifactRetention(join(root, 'screenshots'), { maxFiles: -1, maxBytes: 1 })).rejects.toThrow('maxFiles')
    await expect(enforceArtifactRetention(join(root, 'screenshots'), { maxFiles: 1, maxBytes: 1.5 })).rejects.toThrow('maxBytes')

    const parentFile = join(root, 'parent-file')
    await writeFile(parentFile, 'file')
    await expect(enforceArtifactRetention(join(parentFile, 'screenshots'), { maxFiles: 1, maxBytes: 1 })).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('rejects symlink directories and entries without touching their targets', async () => {
    const root = await temporaryRoot()
    const outside = join(root, 'outside.txt')
    await writeFile(outside, 'outside')
    const realDirectory = join(root, 'real-transcripts')
    await mkdir(realDirectory)
    const linkedDirectory = join(root, 'transcripts')
    await symlink(realDirectory, linkedDirectory)
    await expect(enforceArtifactRetention(linkedDirectory, { maxFiles: 0, maxBytes: 0 })).rejects.toThrow('real directory')
    await rm(linkedDirectory)

    await mkdir(linkedDirectory)
    await symlink(outside, join(linkedDirectory, 'escape.jsonl'))
    await expect(enforceArtifactRetention(linkedDirectory, { maxFiles: 0, maxBytes: 0 })).rejects.toThrow('symlink')
    expect(await readFile(outside, 'utf-8')).toBe('outside')
  })

  it('enforces boundary, regular-file, and identity invariants', () => {
    expect(resolveArtifactPath('/safe/transcripts', 'run.jsonl')).toBe('/safe/transcripts/run.jsonl')
    expect(() => resolveArtifactPath('/safe/transcripts', '../escape.jsonl')).toThrow('escapes')

    const regular = { isSymbolicLink: () => false, isFile: () => true, dev: 1, ino: 2 }
    expect(() => assertRegularArtifact(regular, 'changed')).not.toThrow()
    expect(() => assertRegularArtifact({ ...regular, isSymbolicLink: () => true }, 'changed')).toThrow('changed')
    expect(() => assertRegularArtifact({ ...regular, isFile: () => false }, 'changed')).toThrow('changed')
    expect(() => assertUnchangedArtifact(regular, { dev: 1, ino: 2 }, 'changed')).not.toThrow()
    expect(() => assertUnchangedArtifact({ ...regular, dev: 3 }, { dev: 1, ino: 2 }, 'changed')).toThrow('changed')
    expect(() => assertUnchangedArtifact({ ...regular, ino: 3 }, { dev: 1, ino: 2 }, 'changed')).toThrow('changed')
  })
})
