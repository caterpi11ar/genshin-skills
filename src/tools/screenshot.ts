import type { Page } from 'playwright'
import { join } from 'node:path'
import { atomicWritePrivateFile } from '../config/paths.js'
import { logger } from '../utils/logger.js'

/**
 * Capture a screenshot from the page and return the base64-encoded PNG.
 */
export async function captureScreenshot(page: Page): Promise<string> {
  const buffer = await page.screenshot()
  return buffer.toString('base64')
}

/**
 * Capture a screenshot and save it to disk. Returns the file path.
 */
export async function saveScreenshot(
  page: Page,
  dir: string,
  label: string,
): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const safeLabel = label.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'screenshot'
  const path = join(dir, `${safeLabel}-${ts}.png`)
  const buffer = await page.screenshot()
  await atomicWritePrivateFile(path, buffer)
  logger.info(`Screenshot saved: ${path}`)
  return path
}
