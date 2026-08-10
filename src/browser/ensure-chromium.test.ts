import { beforeEach, describe, expect, it, vi } from 'vitest'

import { resolveChromiumExecutable } from './ensure-chromium.js'

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  executablePath: vi.fn(),
}))

vi.mock('node:fs', () => ({ existsSync: mocks.existsSync }))
vi.mock('playwright', () => ({ chromium: { executablePath: mocks.executablePath } }))

describe('resolveChromiumExecutable', () => {
  beforeEach(() => {
    mocks.existsSync.mockReset()
    mocks.executablePath.mockReset().mockReturnValue('/playwright/chromium')
  })

  it('uses Playwright Chromium implicitly when the bundled executable exists', () => {
    mocks.existsSync.mockImplementation(path => path === '/playwright/chromium')
    expect(resolveChromiumExecutable()).toBeUndefined()
    expect(mocks.existsSync).toHaveBeenCalledTimes(1)
  })

  it('returns the first available supported system browser', () => {
    mocks.existsSync.mockImplementation(path => path === '/usr/bin/chromium')
    expect(resolveChromiumExecutable()).toBe('/usr/bin/chromium')
  })

  it('fails with actionable instructions when no browser exists', () => {
    mocks.existsSync.mockReturnValue(false)
    expect(() => resolveChromiumExecutable()).toThrow('pnpm exec playwright install chromium')
  })
})
