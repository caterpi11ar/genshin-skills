import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

describe('published CLI entry', () => {
  it('builds an executable with a working help command', { timeout: 30_000 }, async () => {
    const projectDir = process.cwd()
    const cliPath = join(projectDir, 'dist', 'cli.js')

    await execFileAsync('pnpm', ['build'], { cwd: projectDir })

    expect(await readFile(cliPath, 'utf8')).toMatch(/^#!\/usr\/bin\/env node\n/)
    await expect(access(cliPath, constants.X_OK)).resolves.toBeUndefined()
    const { stdout } = await execFileAsync(cliPath, ['--help'], {
      cwd: projectDir,
      encoding: 'utf8',
    })
    expect(stdout).toContain('Usage: giclaw [options] [command]')
    expect(stdout).toContain('AI agent for Genshin Impact cloud gaming')

    const builtFiles = await readdir(join(projectDir, 'dist'), { recursive: true })
    expect(builtFiles.some(file => /\.test\.[cm]?js(?:\.map)?$/.test(file))).toBe(false)

    const npmCache = await mkdtemp(join(tmpdir(), 'giclaw-npm-cache-'))
    const { stdout: packJson } = await execFileAsync(
      'npm',
      ['pack', '--dry-run', '--json', '--cache', npmCache],
      { cwd: projectDir, encoding: 'utf8' },
    ).finally(async () => rm(npmCache, { recursive: true, force: true }))
    const [{ files }] = JSON.parse(packJson) as [{ files: Array<{ path: string }> }]
    const packageFiles = files.map(file => file.path)
    expect(packageFiles).not.toContain('config.json')
    expect(packageFiles.some(file => file.startsWith('data/'))).toBe(false)
    expect(packageFiles.some(file => file.endsWith('cookies.json'))).toBe(false)
    expect(packageFiles.some(file => /\.test\.[cm]?js(?:\.map)?$/.test(file))).toBe(false)
  })
})
