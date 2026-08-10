import type { Stats } from 'node:fs'
import { lstat, readdir, unlink } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import { ensurePrivateDir, securePrivateFile, syncPrivateDirectory } from '../config/paths.js'

const ARTIFACT_DIRECTORIES = new Map([
  ['transcripts', '.jsonl'],
  ['screenshots', '.png'],
])

export interface ArtifactRetentionOptions {
  maxFiles: number
  maxBytes: number
}

export interface ArtifactRetentionResult {
  deleted: string[]
  retainedFiles: number
  retainedBytes: number
}

interface Artifact {
  directory: string
  path: string
  size: number
  mtimeMs: number
  dev: number
  ino: number
}

export function resolveArtifactPath(root: string, name: string): string {
  const resolvedRoot = resolve(root)
  const path = resolve(join(resolvedRoot, name))
  if (!path.startsWith(`${resolvedRoot}${sep}`))
    throw new Error(`Artifact path escapes its directory: ${name}`)
  return path
}

export function assertRegularArtifact(
  details: Pick<Stats, 'isSymbolicLink' | 'isFile'>,
  message: string,
): void {
  if (details.isSymbolicLink() || !details.isFile())
    throw new Error(message)
}

export function assertUnchangedArtifact(
  details: Pick<Stats, 'isSymbolicLink' | 'isFile' | 'dev' | 'ino'>,
  expected: Pick<Artifact, 'dev' | 'ino'>,
  message: string,
): void {
  assertRegularArtifact(details, message)
  if (details.dev !== expected.dev || details.ino !== expected.ino)
    throw new Error(message)
}

function validateLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative safe integer`)
}

export async function enforceArtifactRetention(
  directories: string | readonly string[],
  options: ArtifactRetentionOptions,
): Promise<ArtifactRetentionResult> {
  validateLimit(options.maxFiles, 'maxFiles')
  validateLimit(options.maxBytes, 'maxBytes')

  const requestedDirectories = typeof directories === 'string' ? [directories] : [...directories]
  if (requestedDirectories.length === 0)
    throw new Error('At least one artifact directory is required')

  const roots = requestedDirectories.map(directory => resolve(directory))
  if (new Set(roots).size !== roots.length)
    throw new Error('Artifact directories must be unique')

  const artifacts: Artifact[] = []
  for (const root of roots) {
    const expectedExtension = ARTIFACT_DIRECTORIES.get(basename(root))
    if (!expectedExtension)
      throw new Error('Artifact retention is restricted to transcripts and screenshots directories')

    let rootDetails
    try {
      rootDetails = await lstat(root)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        continue
      throw error
    }
    if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory())
      throw new Error('Artifact directory must be a real directory')
    await ensurePrivateDir(root)

    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isSymbolicLink())
        throw new Error(`Refusing artifact symlink: ${entry.name}`)
      if (!entry.isFile() || extname(entry.name) !== expectedExtension)
        continue

      const path = resolveArtifactPath(root, entry.name)
      await securePrivateFile(path)
      const details = await lstat(path)
      assertRegularArtifact(details, `Artifact changed while scanning: ${entry.name}`)
      artifacts.push({
        directory: root,
        path,
        size: details.size,
        mtimeMs: details.mtimeMs,
        dev: details.dev,
        ino: details.ino,
      })
    }
  }

  artifacts.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path))
  let retainedBytes = artifacts.reduce((total, artifact) => total + artifact.size, 0)
  let retainedFiles = artifacts.length
  const deleted: string[] = []
  const modifiedDirectories = new Set<string>()

  for (const artifact of artifacts) {
    if (retainedFiles <= options.maxFiles && retainedBytes <= options.maxBytes)
      break
    const current = await lstat(artifact.path)
    assertUnchangedArtifact(current, artifact, `Artifact changed before deletion: ${artifact.path}`)
    await unlink(artifact.path)
    deleted.push(artifact.path)
    modifiedDirectories.add(artifact.directory)
    retainedFiles--
    retainedBytes -= artifact.size
  }

  for (const directory of modifiedDirectories)
    await syncPrivateDirectory(directory)

  return { deleted, retainedFiles, retainedBytes }
}
