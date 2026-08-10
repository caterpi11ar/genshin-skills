import { rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const distDir = resolve(projectRoot, 'dist')

if (dirname(distDir) !== projectRoot)
  throw new Error(`Refusing to clean unexpected build path: ${distDir}`)

await rm(distDir, { recursive: true, force: true })
