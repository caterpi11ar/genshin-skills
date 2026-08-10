import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const cacheDirectory = mkdtempSync(join(tmpdir(), 'giclaw-package-check-'))

try {
  const output = execFileSync(
    npmCommand,
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    {
      encoding: 'utf8',
      env: { ...process.env, npm_config_cache: cacheDirectory },
      maxBuffer: 16 * 1024 * 1024,
    },
  )
  const reports = JSON.parse(output)
  if (!Array.isArray(reports) || reports.length !== 1 || !Array.isArray(reports[0]?.files))
    throw new Error('npm returned an unexpected package manifest')

  const files = reports[0].files
  const paths = new Set(files.map(file => file.path))
  const violations = []
  const allowedRootFiles = new Set(['README.md', 'package.json'])
  const runtimeSegments = new Set([
    '.giclaw',
    'data',
    'midscene_run',
    'screenshots',
    'transcripts',
  ])

  for (const file of files) {
    const filePath = String(file.path).replaceAll('\\', '/')
    const segments = filePath.toLowerCase().split('/')
    const allowed = allowedRootFiles.has(filePath)
      || filePath.startsWith('dist/')
      || filePath.startsWith('skills/')
    if (!allowed)
      violations.push(`${filePath}: unexpected package path`)
    if (segments.some(segment => runtimeSegments.has(segment)))
      violations.push(`${filePath}: runtime data path`)
    if (/(?:^|\/)(?:config|cookies?|session|storage-state|auth-state)(?:[._-].*)?\.json$/i.test(filePath))
      violations.push(`${filePath}: private configuration or session file`)
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(filePath) || segments.includes('__tests__'))
      violations.push(`${filePath}: test artifact`)
  }

  for (const required of [
    'dist/cli.js',
    'dist/web/public/index.html',
    'dist/web/public/app.js',
    'dist/web/public/app.css',
    'skills/welkin-moon/SKILL.md',
    'skills/claim-mail/SKILL.md',
    'skills/battle-pass-claim/SKILL.md',
    'skills/claim-achievements/SKILL.md',
    'skills/claim-event-rewards/SKILL.md',
  ]) {
    if (!paths.has(required))
      violations.push(`${required}: required package file is missing`)
  }

  const cli = files.find(file => file.path === 'dist/cli.js')
  if (!cli || (Number(cli.mode) & 0o111) === 0)
    violations.push('dist/cli.js: package executable bit is missing')

  if (violations.length > 0)
    throw new Error(`Package smoke check failed:\n${violations.join('\n')}`)

  console.log(`Package smoke check passed (${files.length} files).`)
}
finally {
  rmSync(cacheDirectory, { recursive: true, force: true })
}
