import type { Browser, BrowserContext, Dialog, Page } from 'playwright'
import type { AppConfig } from '../config/schema.js'
import { chromium } from 'playwright'
import { cancellationError, SessionError, TimeoutError, toError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'
import { resolveChromiumExecutable } from './ensure-chromium.js'

export interface SessionOptions {
  headless?: boolean
  viewport?: { width: number, height: number }
}

export interface SessionManagerOptions {
  closeTimeoutMs?: number
}

const DEFAULT_CLOSE_TIMEOUT_MS = 5_000

function raceWithSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  operationName: string,
): Promise<T> {
  if (signal.aborted)
    return Promise.reject(cancellationError(operationName, signal.reason))

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancellationError(operationName, signal.reason))
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}

export class SessionManager {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private page_: Page | null = null
  private launchPromise: Promise<Page> | null = null
  private launchController: AbortController | null = null
  private readonly detachedBrowsers = new Set<Browser>()
  private readonly detachedClosePromises = new Map<Browser, Promise<void>>()
  private readonly lateLaunchCleanups = new Set<Promise<void>>()
  private closePromise: Promise<void> | null = null
  private closing = false
  private readonly dialogTimers = new Set<ReturnType<typeof setTimeout>>()
  private readonly closeTimeoutMs: number
  private readonly config: AppConfig

  constructor(config: AppConfig, options: SessionManagerOptions = {}) {
    this.config = config
    this.closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS
  }

  get isActive(): boolean {
    return this.browser !== null && this.browser.isConnected()
  }

  getPage(): Page {
    if (!this.page_) {
      throw new SessionError('No active session — call launch() first')
    }
    return this.page_
  }

  getContext(): BrowserContext {
    if (!this.context) {
      throw new SessionError('No active session — call launch() first')
    }
    return this.context
  }

  launch(options?: SessionOptions, externalSignal?: AbortSignal): Promise<Page> {
    if (
      this.browser
      || this.launchPromise
      || this.closePromise
      || this.closing
      || this.detachedBrowsers.size > 0
      || this.lateLaunchCleanups.size > 0
    ) {
      return Promise.reject(new SessionError('Session already active — call close() first'))
    }

    const controller = new AbortController()
    const signal = externalSignal
      ? AbortSignal.any([externalSignal, controller.signal])
      : controller.signal
    this.launchController = controller

    const operation = this.launchCurrent(options, signal)
    const tracked: Promise<Page> = operation.finally(() => {
      if (this.launchPromise === tracked) {
        this.launchPromise = null
        this.launchController = null
      }
    })
    this.launchPromise = tracked
    return tracked
  }

  private async launchCurrent(options: SessionOptions | undefined, signal: AbortSignal): Promise<Page> {
    if (signal.aborted)
      throw cancellationError('browser launch', signal.reason)

    const headless = options?.headless ?? this.config.browser.headless
    const viewport = options?.viewport ?? this.config.browser.viewport

    logger.info(`Launching browser (headless: ${headless})`)

    const executablePath = resolveChromiumExecutable()
    const launchOperation = chromium.launch({
      headless,
      ...(executablePath ? { executablePath } : {}),
    })
    let browser: Browser
    try {
      browser = await raceWithSignal(launchOperation, signal, 'browser launch')
    }
    catch (error) {
      if (signal?.aborted) {
        this.trackLateLaunchCleanup(launchOperation)
      }
      throw error
    }

    this.browser = browser
    try {
      this.context = await raceWithSignal(browser.newContext({ viewport }), signal, 'browser context creation')
      this.page_ = await raceWithSignal(this.context.newPage(), signal, 'browser page creation')
      await raceWithSignal(this.page_.goto(this.config.browser.startupUrl), signal, 'browser navigation')
    }
    catch (error) {
      if (!this.closing) {
        try {
          await this.closeBrowser(browser)
        }
        catch (closeError) {
          logger.warn('Could not clean up a partially launched browser session', closeError)
        }
      }
      throw error
    }

    this.setupDialogHandler()

    logger.info('Browser session launched')
    return this.page_
  }

  /**
   * Close current session and relaunch with new options.
   * Used for headless ↔ visible switching during login.
   */
  async relaunch(options?: SessionOptions, signal?: AbortSignal): Promise<Page> {
    await this.close()
    if (signal?.aborted)
      throw cancellationError('browser relaunch', signal.reason)
    return this.launch(options, signal)
  }

  close(): Promise<void> {
    if (this.closePromise)
      return this.closePromise

    this.closing = true
    this.closePromise = this.closeCurrent().finally(() => {
      this.closePromise = null
      this.closing = false
    })
    return this.closePromise
  }

  private async closeCurrent(): Promise<void> {
    const pendingLaunch = this.launchPromise
    this.launchController?.abort(cancellationError('browser session close'))
    if (pendingLaunch)
      await pendingLaunch.catch(() => {})

    for (const timer of this.dialogTimers)
      clearTimeout(timer)
    this.dialogTimers.clear()

    const browser = this.browser
    const lateLaunchCleanups = [...this.lateLaunchCleanups]
    const detached = [...this.detachedBrowsers]
    if (!browser && detached.length === 0 && lateLaunchCleanups.length === 0) {
      this.context = null
      this.page_ = null
      return
    }

    const operations = new Set<Promise<void>>(lateLaunchCleanups)
    for (const item of detached)
      operations.add(this.closeDetachedBrowser(item))
    if (browser)
      operations.add(this.closeBrowser(browser))

    const results = await this.settleCloseOperations([...operations])
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason)
    if (failures.length === 1)
      throw failures[0]
    if (failures.length > 1) {
      throw new SessionError(
        'Could not close all browser sessions',
        new AggregateError(failures, 'Multiple browser sessions failed to close'),
      )
    }
  }

  private trackLateLaunchCleanup(launchOperation: Promise<Browser>): void {
    const cleanup = launchOperation.then(
      async (lateBrowser) => {
        this.detachedBrowsers.add(lateBrowser)
        await this.closeDetachedBrowser(lateBrowser)
      },
      () => {},
    )
    this.lateLaunchCleanups.add(cleanup)
    void cleanup.finally(() => {
      this.lateLaunchCleanups.delete(cleanup)
    }).catch(() => {})
    void cleanup.catch((closeError) => {
      logger.warn('Could not close a browser returned after launch cancellation', closeError)
    })
  }

  private async settleCloseOperations(
    operations: Promise<void>[],
  ): Promise<PromiseSettledResult<void>[]> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        reject,
        this.closeTimeoutMs,
        new SessionError(
          'Could not close browser session',
          new TimeoutError('browser session cleanup', this.closeTimeoutMs),
        ),
      )
    })
    try {
      return await Promise.race([Promise.allSettled(operations), deadline])
    }
    finally {
      if (timer)
        clearTimeout(timer)
    }
  }

  private closeDetachedBrowser(browser: Browser): Promise<void> {
    const pending = this.detachedClosePromises.get(browser)
    if (pending)
      return pending

    const close = this.closeBrowser(browser)
      .then(() => {
        this.detachedBrowsers.delete(browser)
      })
      .finally(() => {
        this.detachedClosePromises.delete(browser)
      })
    this.detachedClosePromises.set(browser, close)
    return close
  }

  private async closeBrowser(browser: Browser): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const closeOperation = Promise.resolve().then(() => browser.close())
    const timedClose = new Promise<never>((_, reject) => {
      timer = setTimeout(
        reject,
        this.closeTimeoutMs,
        new TimeoutError('browser session close', this.closeTimeoutMs),
      )
    })

    // If a timed-out browser close eventually succeeds, reflect the real
    // closed state while still allowing callers to retry immediately.
    void closeOperation.then(() => this.clearIfCurrent(browser), () => {})

    try {
      await Promise.race([closeOperation, timedClose])
      this.clearIfCurrent(browser)
      logger.info('Browser session closed')
    }
    catch (error) {
      throw new SessionError('Could not close browser session', toError(error))
    }
    finally {
      if (timer)
        clearTimeout(timer)
    }
  }

  private clearIfCurrent(browser: Browser): void {
    if (this.browser !== browser)
      return
    this.browser = null
    this.context = null
    this.page_ = null
  }

  private setupDialogHandler(): void {
    // launch() installs the handler only after navigation has completed and
    // close() waits for the in-flight launch before clearing these handles.
    const page = this.page_!
    const handleDialog = (dialog: Dialog) => {
      logger.info(
        `Dialog detected: ${dialog.type()} - "${dialog.message()}"`,
      )
      const timer = setTimeout(async () => {
        this.dialogTimers.delete(timer)
        if (this.page_ !== page)
          return
        try {
          await dialog.dismiss()
          logger.info('Dialog auto-dismissed')
        }
        catch {
          // Dialog may have been handled already
        }
      }, this.config.browser.dialogAutoDismissMs)
      this.dialogTimers.add(timer)
    }

    page.on('dialog', handleDialog)
  }
}
