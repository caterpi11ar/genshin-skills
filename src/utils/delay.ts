import { logger } from './logger.js'

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export interface RetryOptions {
  retries: number
  delayMs?: number
  onRetry?: (attempt: number, error: unknown) => void
  shouldRetry?: (error: unknown) => boolean
}

export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const { retries, delayMs = 1000, onRetry, shouldRetry = () => true } = options
  let attempt = 0

  while (true) {
    try {
      return await fn()
    }
    catch (err) {
      if (attempt < retries && shouldRetry(err)) {
        logger.warn(
          `Attempt ${attempt + 1}/${retries + 1} failed, retrying in ${delayMs}ms`,
        )
        onRetry?.(attempt + 1, err)
        await delay(delayMs)
        attempt++
        continue
      }
      throw err
    }
  }
}
