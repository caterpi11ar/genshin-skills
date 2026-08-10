import { afterEach, describe, expect, it, vi } from 'vitest'
import { delay, retry } from './delay.js'

describe('delay utilities', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves after the requested delay', async () => {
    vi.useFakeTimers()
    const done = vi.fn()
    const promise = delay(250).then(done)

    await vi.advanceTimersByTimeAsync(249)
    expect(done).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await promise
    expect(done).toHaveBeenCalledOnce()
  })

  it('removes its abort listener after a signalled delay resolves', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener')
    const promise = delay(25, controller.signal)

    await vi.advanceTimersByTimeAsync(25)
    await expect(promise).resolves.toBeUndefined()
    expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('cancels pending and already-aborted delays with the abort reason', async () => {
    vi.useFakeTimers()
    const pendingController = new AbortController()
    const pendingReason = new Error('cancel pending delay')
    const pending = delay(1000, pendingController.signal)
    pendingController.abort(pendingReason)
    await expect(pending).rejects.toBe(pendingReason)

    const stoppedController = new AbortController()
    const stoppedReason = new Error('already stopped')
    stoppedController.abort(stoppedReason)
    expect(() => delay(1000, stoppedController.signal)).toThrow(stoppedReason)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retries failures and reports each retry attempt', async () => {
    vi.useFakeTimers()
    const failure = new Error('temporary')
    const fn = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockResolvedValue('ok')
    const onRetry = vi.fn()

    const promise = retry(fn, { retries: 2, delayMs: 100, onRetry })
    await vi.runAllTimersAsync()

    await expect(promise).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, failure)
    expect(onRetry).toHaveBeenNthCalledWith(2, 2, failure)
  })

  it('stops immediately when shouldRetry rejects the error', async () => {
    const failure = new Error('fatal')
    const fn = vi.fn().mockRejectedValue(failure)

    await expect(retry(fn, {
      retries: 3,
      shouldRetry: () => false,
    })).rejects.toBe(failure)
    expect(fn).toHaveBeenCalledOnce()
  })

  it('throws the final error after exhausting retries', async () => {
    vi.useFakeTimers()
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('last'))
    const promise = retry(fn, { retries: 1, delayMs: 10 })
    const rejection = expect(promise).rejects.toThrow('last')
    await vi.runAllTimersAsync()

    await rejection
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
