import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const DIR_NAME = '.giclaw'

export const PRIVATE_DIR_MODE = 0o700
export const PRIVATE_FILE_MODE = 0o600

export interface StatePaths {
  stateDir: string
  configPath: string
  cookiePath: string
  dataDir: string
  transcriptsDir: string
  screenshotDir: string
  skillsDir: string
  builtinSkillsDir: string
}

function resolve(): StatePaths {
  const home = homedir()
  const stateDir = join(home, DIR_NAME)
  const dataDir = join(stateDir, 'data')
  // dist/config/ → package root
  const packageRoot = resolvePath(__dirname, '..', '..')

  return {
    stateDir,
    configPath: join(stateDir, 'config.json'),
    cookiePath: join(stateDir, 'cookies.json'),
    dataDir,
    transcriptsDir: join(dataDir, 'transcripts'),
    screenshotDir: join(dataDir, 'screenshots'),
    skillsDir: join(stateDir, 'skills'),
    builtinSkillsDir: join(packageRoot, 'skills'),
  }
}

// Module-level constant — resolved once on first import
export const PATHS: StatePaths = resolve()

// --- Async initializers ---

export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIR_MODE })
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  try {
    await handle.chmod(PRIVATE_DIR_MODE)
  }
  finally {
    await handle.close()
  }
}

export async function securePrivateFile(path: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return false
    throw error
  }

  try {
    const details = await handle.stat()
    if (!details.isFile())
      throw new Error(`Private file path is not a regular file: ${path}`)
    await handle.chmod(PRIVATE_FILE_MODE)
    return true
  }
  finally {
    await handle.close()
  }
}

export async function syncPrivateDirectory(directory: string): Promise<void> {
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  try {
    await handle.sync()
  }
  finally {
    await handle.close()
  }
}

export async function atomicWritePrivateFile(
  path: string,
  data: string | Uint8Array,
): Promise<void> {
  const directory = dirname(path)
  await ensurePrivateDir(directory)
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${randomUUID()}.tmp`,
  )
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    )
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporaryPath, path)
    await syncPrivateDirectory(directory)
  }
  catch (error) {
    await handle?.close()
    await rm(temporaryPath, { force: true })
    throw error
  }
}

export async function appendPrivateFile(path: string, data: string): Promise<void> {
  await ensurePrivateDir(dirname(path))
  await securePrivateFile(path)
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
    PRIVATE_FILE_MODE,
  )
  try {
    await handle.chmod(PRIVATE_FILE_MODE)
    await handle.writeFile(data)
    await handle.sync()
  }
  finally {
    await handle.close()
  }
}

async function securePrivateTree(directory: string, secureFiles: boolean): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(`Private state tree contains a symbolic link: ${path}`)
    }
    else if (entry.isDirectory()) {
      await ensurePrivateDir(path)
      await securePrivateTree(path, secureFiles)
    }
    else if (secureFiles) {
      await securePrivateFile(path)
    }
  }
}

export async function ensureStateDir(): Promise<void> {
  const dirs = [PATHS.stateDir, PATHS.dataDir, PATHS.transcriptsDir, PATHS.screenshotDir, PATHS.skillsDir]
  for (const dir of dirs) {
    await ensurePrivateDir(dir)
  }

  await securePrivateTree(PATHS.stateDir, false)
  for (const path of [
    PATHS.configPath,
    PATHS.cookiePath,
    join(PATHS.dataDir, 'state.json'),
    join(PATHS.dataDir, 'state.json.bak'),
    join(PATHS.dataDir, 'state.json.tmp'),
  ]) {
    await securePrivateFile(path)
  }
  await securePrivateTree(PATHS.transcriptsDir, true)
  await securePrivateTree(PATHS.screenshotDir, true)
}

const DEFAULT_CONFIG = {
  locale: 'zh',
  model: {
    name: '',
    baseUrl: '',
    apiKey: '',
  },
  browser: {},
  tasks: {},
  schedule: {},
}

export async function initStateDir(): Promise<{ created: string[] }> {
  await ensureStateDir()
  const created: string[] = []

  if (!(await securePrivateFile(PATHS.configPath))) {
    await atomicWritePrivateFile(PATHS.configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`)
    created.push(PATHS.configPath)
  }

  return { created }
}
