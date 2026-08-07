import { existsSync } from 'node:fs'
import { chromium } from 'playwright'

const SYSTEM_CHROMIUM_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

/**
 * Return an explicit system browser path only when Playwright's bundled
 * Chromium is unavailable. This check never downloads or installs software.
 */
export function resolveChromiumExecutable(): string | undefined {
  const bundledPath = chromium.executablePath()
  if (existsSync(bundledPath))
    return undefined

  const systemPath = SYSTEM_CHROMIUM_PATHS.find(existsSync)
  if (systemPath)
    return systemPath

  throw new Error(
    'No compatible Chromium browser found. Install Google Chrome or run `pnpm exec playwright install chromium` explicitly.',
  )
}
