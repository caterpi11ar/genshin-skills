import type { Dialog } from 'playwright'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appConfigSchema } from '../config/schema.js'
import { logger } from '../utils/logger.js'

import { SessionManager } from './session-manager.js'

const browserMocks = vi.hoisted(() => ({
  launch: vi.fn(),
  resolveExecutable: vi.fn(),
}))

vi.mock('playwright', () => ({
  chromium: { launch: browserMocks.launch },
}))

vi.mock('./ensure-chromium.js', () => ({
  resolveChromiumExecutable: browserMocks.resolveExecutable,
}))

function browserFixture() {
  const handlers = new Map<string, (value: unknown) => void>()
  const page = {
    goto: vi.fn(async () => {}),
    on: vi.fn((event: string, handler: (value: unknown) => void) => {
      handlers.set(event, handler)
    }),
  }
  const context = {
    newPage: vi.fn(async () => page),
  }
  const browser = {
    isConnected: vi.fn(() => true),
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => {}),
  }
  return { browser, context, page, handlers }
}

describe('sessionManager', () => {
  beforeEach(() => {
    browserMocks.launch.mockReset()
    browserMocks.resolveExecutable.mockReset()
    logger.mute()
  })

  afterEach(() => {
    vi.useRealTimers()
    logger.unmute()
  })

  it('guards page and context access before launch', () => {
    const session = new SessionManager(appConfigSchema.parse({}))
    expect(session.isActive).toBe(false)
    expect(() => session.getPage()).toThrow('No active session')
    expect(() => session.getContext()).toThrow('No active session')
  })

  it('closes an inactive session idempotently without starting browser cleanup', async () => {
    const session = new SessionManager(appConfigSchema.parse({}))

    await expect(session.close()).resolves.toBeUndefined()
    await expect(session.close()).resolves.toBeUndefined()

    expect(browserMocks.launch).not.toHaveBeenCalled()
    expect(session.isActive).toBe(false)
    expect(() => session.getPage()).toThrow('No active session')
    expect(() => session.getContext()).toThrow('No active session')
  })

  it('launches the configured page with viewport and a system executable fallback', async () => {
    const fixture = browserFixture()
    browserMocks.resolveExecutable.mockReturnValue('/browser/chrome')
    browserMocks.launch.mockResolvedValue(fixture.browser)
    const config = appConfigSchema.parse({
      browser: {
        startupUrl: 'https://example.test/cloud',
        headless: true,
        viewport: { width: 1600, height: 900 },
      },
    })
    const session = new SessionManager(config)

    const page = await session.launch()

    expect(browserMocks.launch).toHaveBeenCalledWith({
      headless: true,
      executablePath: '/browser/chrome',
    })
    expect(fixture.browser.newContext).toHaveBeenCalledWith({ viewport: { width: 1600, height: 900 } })
    expect(fixture.page.goto).toHaveBeenCalledWith('https://example.test/cloud')
    expect(page).toBe(fixture.page)
    expect(session.getPage()).toBe(fixture.page)
    expect(session.getContext()).toBe(fixture.context)
    expect(session.isActive).toBe(true)
  })

  it('omits executablePath when bundled Chromium is available and honors launch overrides', async () => {
    const fixture = browserFixture()
    browserMocks.resolveExecutable.mockReturnValue(undefined)
    browserMocks.launch.mockResolvedValue(fixture.browser)
    const session = new SessionManager(appConfigSchema.parse({}))

    await session.launch({ headless: false, viewport: { width: 800, height: 600 } })

    expect(browserMocks.launch).toHaveBeenCalledWith({ headless: false })
    expect(fixture.browser.newContext).toHaveBeenCalledWith({ viewport: { width: 800, height: 600 } })
  })

  it('rejects a second launch while the session is active', async () => {
    const fixture = browserFixture()
    browserMocks.launch.mockResolvedValue(fixture.browser)
    const session = new SessionManager(appConfigSchema.parse({}))
    await session.launch()

    await expect(session.launch()).rejects.toThrow('Session already active')
    expect(browserMocks.launch).toHaveBeenCalledOnce()
  })

  it('rejects a concurrent launch before a second browser can be created', async () => {
    const fixture = browserFixture()
    let finishLaunch!: (browser: typeof fixture.browser) => void
    browserMocks.launch.mockReturnValue(new Promise(resolve => finishLaunch = resolve))
    const session = new SessionManager(appConfigSchema.parse({}))

    const first = session.launch()
    const second = session.launch()

    await expect(second).rejects.toThrow('Session already active')
    expect(browserMocks.launch).toHaveBeenCalledOnce()
    finishLaunch(fixture.browser)
    await expect(first).resolves.toBe(fixture.page)
    await session.close()
  })

  it('relaunches by closing the old browser first', async () => {
    const first = browserFixture()
    const second = browserFixture()
    browserMocks.launch.mockResolvedValueOnce(first.browser).mockResolvedValueOnce(second.browser)
    const session = new SessionManager(appConfigSchema.parse({}))
    await session.launch()

    const page = await session.relaunch({ headless: false })

    expect(first.browser.close).toHaveBeenCalledOnce()
    expect(browserMocks.launch).toHaveBeenNthCalledWith(2, { headless: false })
    expect(page).toBe(second.page)
  })

  it('auto-dismisses browser dialogs after the configured delay', async () => {
    vi.useFakeTimers()
    const fixture = browserFixture()
    browserMocks.launch.mockResolvedValue(fixture.browser)
    const session = new SessionManager(appConfigSchema.parse({
      browser: { dialogAutoDismissMs: 250 },
    }))
    await session.launch()
    const dismiss = vi.fn(async () => {})
    const dialog = {
      type: () => 'alert',
      message: () => 'hello',
      dismiss,
    } as unknown as Dialog

    fixture.handlers.get('dialog')?.(dialog)
    await vi.advanceTimersByTimeAsync(249)
    expect(dismiss).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(dismiss).toHaveBeenCalledOnce()
  })

  it('clears every pending dialog timer when the session closes', async () => {
    vi.useFakeTimers()
    const fixture = browserFixture()
    browserMocks.launch.mockResolvedValue(fixture.browser)
    const session = new SessionManager(appConfigSchema.parse({
      browser: { dialogAutoDismissMs: 250 },
    }))
    await session.launch()
    const firstDismiss = vi.fn(async () => {})
    const secondDismiss = vi.fn(async () => {})
    fixture.handlers.get('dialog')?.({
      type: () => 'alert',
      message: () => 'first',
      dismiss: firstDismiss,
    } as unknown as Dialog)
    fixture.handlers.get('dialog')?.({
      type: () => 'confirm',
      message: () => 'second',
      dismiss: secondDismiss,
    } as unknown as Dialog)

    await session.close()
    await vi.advanceTimersByTimeAsync(250)

    expect(firstDismiss).not.toHaveBeenCalled()
    expect(secondDismiss).not.toHaveBeenCalled()
  })

  it('does not dismiss a dialog delivered by a stale page after close', async () => {
    vi.useFakeTimers()
    const fixture = browserFixture()
    browserMocks.launch.mockResolvedValue(fixture.browser)
    const session = new SessionManager(appConfigSchema.parse({
      browser: { dialogAutoDismissMs: 1 },
    }))
    await session.launch()
    const staleDialogHandler = fixture.handlers.get('dialog')
    await session.close()
    const dismiss = vi.fn(async () => {})

    staleDialogHandler?.({
      type: () => 'alert',
      message: () => 'stale',
      dismiss,
    } as unknown as Dialog)
    await vi.advanceTimersByTimeAsync(1)

    expect(dismiss).not.toHaveBeenCalled()
  })

  it('ignores dialog dismissal races', async () => {
    vi.useFakeTimers()
    const fixture = browserFixture()
    browserMocks.launch.mockResolvedValue(fixture.browser)
    const session = new SessionManager(appConfigSchema.parse({
      browser: { dialogAutoDismissMs: 1 },
    }))
    await session.launch()
    const dismiss = vi.fn(async () => {
      throw new Error('already handled')
    })
    fixture.handlers.get('dialog')?.({
      type: () => 'alert',
      message: () => 'hello',
      dismiss,
    } as unknown as Dialog)

    await vi.advanceTimersByTimeAsync(1)
    expect(dismiss).toHaveBeenCalledOnce()
  })

  it('preserves handles after close failure so cleanup can be retried', async () => {
    const fixture = browserFixture()
    const closeError = new Error('close failed')
    fixture.browser.close.mockRejectedValueOnce(closeError).mockResolvedValueOnce(undefined)
    browserMocks.launch.mockResolvedValue(fixture.browser)
    const session = new SessionManager(appConfigSchema.parse({}))
    await session.launch()

    await expect(session.close()).rejects.toMatchObject({
      name: 'SessionError',
      cause: closeError,
    })
    expect(session.getPage()).toBe(fixture.page)
    expect(session.getContext()).toBe(fixture.context)

    await expect(session.close()).resolves.toBeUndefined()
    expect(fixture.browser.close).toHaveBeenCalledTimes(2)
    expect(() => session.getPage()).toThrow('No active session')
  })

  it('deduplicates concurrent close calls', async () => {
    const fixture = browserFixture()
    let releaseClose!: () => void
    fixture.browser.close.mockImplementation(() => new Promise<void>(resolve => releaseClose = resolve))
    browserMocks.launch.mockResolvedValue(fixture.browser)
    const session = new SessionManager(appConfigSchema.parse({}))
    await session.launch()

    const first = session.close()
    const second = session.close()
    expect(second).toBe(first)
    await vi.waitFor(() => expect(fixture.browser.close).toHaveBeenCalledOnce())

    releaseClose()
    await Promise.all([first, second])
    expect(() => session.getPage()).toThrow('No active session')
  })

  it('bounds close time while preserving handles for a retry', async () => {
    vi.useFakeTimers()
    const fixture = browserFixture()
    fixture.browser.close.mockImplementation(() => new Promise<void>(() => {}))
    browserMocks.launch.mockResolvedValue(fixture.browser)
    const session = new SessionManager(appConfigSchema.parse({}), { closeTimeoutMs: 10 })
    await session.launch()

    const firstClose = session.close()
    const firstCloseRejection = expect(firstClose).rejects.toMatchObject({
      name: 'SessionError',
      cause: expect.objectContaining({ name: 'TimeoutError' }),
    })
    await vi.advanceTimersByTimeAsync(10)
    await firstCloseRejection
    expect(session.getPage()).toBe(fixture.page)

    fixture.browser.close.mockReset().mockResolvedValue(undefined)
    await session.close()
    expect(() => session.getPage()).toThrow('No active session')
  })

  it('cancels a pending browser launch, blocks overlap, and closes a late browser result', async () => {
    const fixture = browserFixture()
    const next = browserFixture()
    let finishLaunch!: (browser: typeof fixture.browser) => void
    browserMocks.launch
      .mockReturnValueOnce(new Promise(resolve => finishLaunch = resolve))
      .mockResolvedValueOnce(next.browser)
    const session = new SessionManager(appConfigSchema.parse({}))
    const controller = new AbortController()

    const launch = session.launch(undefined, controller.signal)
    controller.abort(new Error('shutdown'))
    await expect(launch).rejects.toMatchObject({ name: 'CancellationError' })
    await expect(session.launch()).rejects.toThrow('Session already active')
    expect(browserMocks.launch).toHaveBeenCalledOnce()

    finishLaunch(fixture.browser)
    await vi.waitFor(() => expect(fixture.browser.close).toHaveBeenCalledOnce())
    expect(() => session.getPage()).toThrow('No active session')

    await expect(session.launch()).resolves.toBe(next.page)
    expect(browserMocks.launch).toHaveBeenCalledTimes(2)
    await session.close()
  })

  it('cancels before context creation and closes the partially launched browser', async () => {
    const fixture = browserFixture()
    const controller = new AbortController()
    const reason = new Error('shutdown before context creation')
    fixture.browser.newContext.mockImplementation(async () => {
      controller.abort(reason)
      return fixture.context
    })
    browserMocks.launch.mockResolvedValue(fixture.browser)
    const session = new SessionManager(appConfigSchema.parse({}))

    await expect(session.launch(undefined, controller.signal)).rejects.toMatchObject({
      name: 'CancellationError',
      cause: reason,
    })

    expect(fixture.browser.close).toHaveBeenCalledOnce()
    expect(session.isActive).toBe(false)
  })

  it('does not relaunch when cancellation arrives while closing the old browser', async () => {
    const fixture = browserFixture()
    const controller = new AbortController()
    const reason = new Error('shutdown during relaunch')
    fixture.browser.close.mockImplementation(async () => {
      controller.abort(reason)
    })
    browserMocks.launch.mockResolvedValue(fixture.browser)
    const session = new SessionManager(appConfigSchema.parse({}))
    await session.launch()

    await expect(session.relaunch(undefined, controller.signal)).rejects.toMatchObject({
      name: 'CancellationError',
      cause: reason,
    })

    expect(browserMocks.launch).toHaveBeenCalledOnce()
    expect(fixture.browser.close).toHaveBeenCalledOnce()
  })

  it('deduplicates background and explicit cleanup of a late browser', async () => {
    const fixture = browserFixture()
    let finishLaunch!: (browser: typeof fixture.browser) => void
    let releaseClose!: () => void
    browserMocks.launch.mockReturnValue(new Promise(resolve => finishLaunch = resolve))
    fixture.browser.close.mockImplementation(() => new Promise<void>((resolve) => {
      releaseClose = resolve
    }))
    const session = new SessionManager(appConfigSchema.parse({}))
    const controller = new AbortController()

    const launch = session.launch(undefined, controller.signal)
    controller.abort(new Error('shutdown'))
    await expect(launch).rejects.toMatchObject({ name: 'CancellationError' })
    finishLaunch(fixture.browser)
    await vi.waitFor(() => expect(fixture.browser.close).toHaveBeenCalledOnce())

    const explicitCleanup = session.close()
    expect(fixture.browser.close).toHaveBeenCalledOnce()
    releaseClose()
    await explicitCleanup
    expect(fixture.browser.close).toHaveBeenCalledOnce()
  })

  it('preserves a partial launch error and retains handles when cleanup fails', async () => {
    const fixture = browserFixture()
    const contextError = new Error('context creation failed')
    const closeError = new Error('partial close failed')
    fixture.browser.newContext.mockRejectedValue(contextError)
    fixture.browser.close.mockRejectedValueOnce(closeError).mockResolvedValueOnce(undefined)
    browserMocks.launch.mockResolvedValue(fixture.browser)
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const session = new SessionManager(appConfigSchema.parse({}))

    await expect(session.launch()).rejects.toBe(contextError)

    expect(warning).toHaveBeenCalledWith(
      'Could not clean up a partially launched browser session',
      expect.objectContaining({ name: 'SessionError', cause: closeError }),
    )
    expect(session.isActive).toBe(true)
    await session.close()
    expect(session.isActive).toBe(false)
  })

  it('reports failure when a browser returned after cancellation cannot close', async () => {
    const fixture = browserFixture()
    let finishLaunch!: (browser: typeof fixture.browser) => void
    fixture.browser.close.mockRejectedValue(new Error('late close failed'))
    browserMocks.launch.mockReturnValue(new Promise(resolve => finishLaunch = resolve))
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const session = new SessionManager(appConfigSchema.parse({}))
    const controller = new AbortController()

    const launch = session.launch(undefined, controller.signal)
    controller.abort(new Error('shutdown'))
    await expect(launch).rejects.toMatchObject({ name: 'CancellationError' })
    finishLaunch(fixture.browser)

    await vi.waitFor(() => expect(warning).toHaveBeenCalledWith(
      'Could not close a browser returned after launch cancellation',
      expect.objectContaining({ name: 'SessionError' }),
    ))
    await expect(session.launch()).rejects.toThrow('Session already active')
    fixture.browser.close.mockResolvedValue(undefined)
    await session.close()
    expect(fixture.browser.close).toHaveBeenCalledTimes(2)
  })

  it('attempts every browser cleanup and reports multiple close failures together', async () => {
    const active = browserFixture()
    const detached = browserFixture()
    active.browser.close.mockRejectedValueOnce(new Error('active close failed')).mockResolvedValue(undefined)
    detached.browser.close.mockRejectedValueOnce(new Error('detached close failed')).mockResolvedValue(undefined)
    browserMocks.launch.mockResolvedValue(active.browser)
    const session = new SessionManager(appConfigSchema.parse({}))
    await session.launch()
    const internals = session as unknown as { detachedBrowsers: Set<typeof detached.browser> }
    internals.detachedBrowsers.add(detached.browser)

    await expect(session.close()).rejects.toMatchObject({
      name: 'SessionError',
      cause: expect.objectContaining({ name: 'AggregateError' }),
    })
    expect(active.browser.close).toHaveBeenCalledOnce()
    expect(detached.browser.close).toHaveBeenCalledOnce()

    await session.close()
    expect(active.browser.close).toHaveBeenCalledTimes(2)
    expect(detached.browser.close).toHaveBeenCalledTimes(2)
  })

  it('bounds close while a cancelled launch is unresolved and keeps later launches isolated', async () => {
    vi.useFakeTimers()
    const fixture = browserFixture()
    const next = browserFixture()
    let finishLaunch!: (browser: typeof fixture.browser) => void
    browserMocks.launch
      .mockReturnValueOnce(new Promise(resolve => finishLaunch = resolve))
      .mockResolvedValueOnce(next.browser)
    const session = new SessionManager(appConfigSchema.parse({}), { closeTimeoutMs: 10 })

    const launch = session.launch()
    const launchRejection = expect(launch).rejects.toMatchObject({
      name: 'CancellationError',
      code: 'CANCELLED',
    })
    const close = session.close()

    await launchRejection
    await expect(session.launch()).rejects.toThrow('Session already active')
    const closeRejection = expect(close).rejects.toMatchObject({
      name: 'SessionError',
      cause: expect.objectContaining({ name: 'TimeoutError' }),
    })
    await vi.advanceTimersByTimeAsync(10)
    await closeRejection
    await expect(session.launch()).rejects.toThrow('Session already active')
    expect(browserMocks.launch).toHaveBeenCalledOnce()

    finishLaunch(fixture.browser)
    await vi.waitFor(() => expect(fixture.browser.close).toHaveBeenCalledOnce())
    expect(() => session.getPage()).toThrow('No active session')

    await expect(session.launch()).resolves.toBe(next.page)
    expect(browserMocks.launch).toHaveBeenCalledTimes(2)
    await session.close()
  })

  it('normalizes a pre-cancelled launch without starting browser I/O', async () => {
    const controller = new AbortController()
    const reason = new Error('already stopping')
    controller.abort(reason)
    const session = new SessionManager(appConfigSchema.parse({}))

    await expect(session.launch(undefined, controller.signal)).rejects.toMatchObject({
      name: 'CancellationError',
      code: 'CANCELLED',
      cause: reason,
    })
    expect(browserMocks.resolveExecutable).not.toHaveBeenCalled()
    expect(browserMocks.launch).not.toHaveBeenCalled()
  })
})
