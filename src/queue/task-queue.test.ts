import type { RunResult } from '../tasks/task-runner.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { logger } from '../utils/logger.js'
import { TaskQueue } from './task-queue.js'

function result(): RunResult {
  const now = new Date()
  return { results: [], startedAt: now, completedAt: now }
}

function item(id: string) {
  return {
    runId: id,
    trigger: 'api' as const,
    enqueuedAt: new Date(),
  }
}

describe('taskQueue', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([0, -1, 1.5, Number.NaN])('rejects invalid maxDepth %s', (maxDepth) => {
    expect(() => new TaskQueue(maxDepth)).toThrow('positive integer')
  })

  it('enforces maxDepth for waiting runs', async () => {
    const queue = new TaskQueue(1)
    let releaseFirst: (() => void) | undefined
    const first = queue.enqueue(item('first'), () => new Promise<RunResult>((resolve) => {
      releaseFirst = () => resolve(result())
    }))
    const second = queue.enqueue(item('second'), async () => result())

    await expect(queue.enqueue(item('third'), async () => result()))
      .rejects
      .toThrow('Queue is full')

    releaseFirst?.()
    await first
    await second
    expect(queue.getDepth()).toBe(0)
  })

  it('returns an atomic admission receipt without waiting for completion', async () => {
    const queue = new TaskQueue(1)
    let releaseFirst!: () => void
    const first = queue.submit(item('first'), () => new Promise<RunResult>((resolve) => {
      releaseFirst = () => resolve(result())
    }))
    const second = queue.submit(item('second'), async () => result())

    expect(first.status).toBe('started')
    expect(second.status).toBe('queued')
    expect(() => queue.submit(item('third'), async () => result())).toThrow('Queue is full')

    releaseFirst()
    await expect(first.completion).resolves.toMatchObject({ results: [] })
    await expect(second.completion).resolves.toMatchObject({ results: [] })
  })

  it('throws an admission receipt synchronously after close', () => {
    const queue = new TaskQueue()
    queue.close()

    expect(() => queue.submit(item('late'), async () => result())).toThrow('Queue is closed')
  })

  it('rejects a failed processor even when no error observer is registered', async () => {
    const queue = new TaskQueue()
    await expect(queue.enqueue(item('failed'), async () => {
      throw new Error('processor failed')
    })).rejects.toThrow('processor failed')
    expect(queue.getStatus()).toBe('idle')
  })

  it('normalizes non-Error processor failures', async () => {
    const queue = new TaskQueue()

    await expect(queue.enqueue(item('failed-string'), async () => new Promise((_, reject) => {
      // eslint-disable-next-line prefer-promise-reject-errors
      reject('plain failure')
    })))
      .rejects
      .toThrow('plain failure')
  })

  it('processes runs serially in FIFO order', async () => {
    const queue = new TaskQueue(3)
    const order: string[] = []
    let releaseFirst: (() => void) | undefined

    const first = queue.enqueue(item('first'), async () => {
      order.push('first:start')
      await new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      order.push('first:end')
      return result()
    })
    const second = queue.enqueue(item('second'), async () => {
      order.push('second')
      return result()
    })
    const third = queue.enqueue(item('third'), async () => {
      order.push('third')
      return result()
    })

    await vi.waitFor(() => expect(order).toEqual(['first:start']))
    expect(queue.isProcessing()).toBe(true)
    expect(queue.getDepth()).toBe(2)
    releaseFirst?.()
    await Promise.all([first, second, third])

    expect(order).toEqual(['first:start', 'first:end', 'second', 'third'])
    expect(queue.getStatus()).toBe('idle')
    expect(queue.isProcessing()).toBe(false)
  })

  it('emits lifecycle events and keeps processing after a failure', async () => {
    const queue = new TaskQueue()
    const events: string[] = []
    queue.on('enqueue', queued => events.push(`enqueue:${queued.runId}`))
    queue.on('processing', queued => events.push(`processing:${queued.runId}`))
    queue.on('complete', queued => events.push(`complete:${queued.runId}`))
    queue.on('error', (queued, error) => events.push(`error:${queued.runId}:${error.message}`))

    const failed = queue.enqueue(item('failed'), async () => {
      throw new Error('boom')
    })
    const next = queue.enqueue(item('next'), async () => result())

    await expect(failed).rejects.toThrow('boom')
    await expect(next).resolves.toMatchObject({ results: [] })
    expect(events).toEqual([
      'enqueue:failed',
      'processing:failed',
      'enqueue:next',
      'error:failed:boom',
      'processing:next',
      'complete:next',
    ])
  })

  it('does not let lifecycle listener failures wedge or alter queue work', async () => {
    const queue = new TaskQueue()
    const observerError = new Error('observer failed')
    for (const event of ['enqueue', 'processing', 'complete', 'idle'])
      queue.on(event, () => { throw observerError })

    await expect(queue.enqueue(item('safe'), async () => result()))
      .resolves
      .toMatchObject({ results: [] })
    expect(queue.isProcessing()).toBe(false)
    expect(queue.getStatus()).toBe('idle')
  })

  it('preserves processor failures when an error observer also throws', async () => {
    const queue = new TaskQueue()
    const processorError = new Error('processor failed')
    queue.on('error', () => {
      throw new Error('observer failed')
    })

    await expect(queue.enqueue(item('failed-observer'), async () => {
      throw processorError
    })).rejects.toBe(processorError)
    expect(queue.isProcessing()).toBe(false)
  })

  it('keeps processing when observer-error logging also throws', async () => {
    const queue = new TaskQueue()
    queue.on('processing', () => {
      throw new Error('observer failed')
    })
    vi.spyOn(logger, 'error').mockImplementation(() => {
      throw new Error('logger failed')
    })

    await expect(queue.enqueue(item('safe'), async () => result()))
      .resolves
      .toMatchObject({ results: [] })
    expect(queue.isProcessing()).toBe(false)
  })

  it('drains all active and waiting work before resolving', async () => {
    vi.useFakeTimers()
    const queue = new TaskQueue()
    let release: (() => void) | undefined
    const active = queue.enqueue(item('active'), () => new Promise<RunResult>((resolve) => {
      release = () => resolve(result())
    }))
    const waiting = queue.enqueue(item('waiting'), async () => result())

    const drained = vi.fn()
    const drainPromise = queue.drain().then(drained)
    await vi.advanceTimersByTimeAsync(100)
    expect(queue.getStatus()).toBe('draining')
    expect(drained).not.toHaveBeenCalled()

    release?.()
    await active
    await waiting
    await vi.advanceTimersByTimeAsync(100)
    await drainPromise
    expect(drained).toHaveBeenCalledOnce()
    expect(queue.getStatus()).toBe('idle')
  })

  it('drains immediately when already idle', async () => {
    const queue = new TaskQueue()
    await expect(queue.drain()).resolves.toBeUndefined()
    expect(queue.getStatus()).toBe('idle')
  })

  it('stops intake, rejects waiting work, and lets only active work finish', async () => {
    const queue = new TaskQueue()
    let releaseActive!: () => void
    const active = queue.enqueue(item('active'), () => new Promise<RunResult>((resolve) => {
      releaseActive = () => resolve(result())
    }))
    const waitingProcessor = vi.fn(async () => result())
    const waiting = queue.enqueue(item('waiting'), waitingProcessor)
    const shutdown = new Error('gateway stopping')
    const closeEvents: Array<[string, Error]> = []
    queue.on('error', (queued, error) => closeEvents.push([queued.runId, error]))
    const waitingRejection = expect(waiting).rejects.toBe(shutdown)

    queue.close(shutdown)
    queue.close(new Error('must not replace the original close reason'))

    await waitingRejection
    expect(closeEvents).toEqual([['waiting', shutdown]])
    await expect(queue.enqueue(item('late'), async () => result()))
      .rejects
      .toMatchObject({
        name: 'QueueError',
        message: expect.stringContaining('Queue is closed'),
        cause: shutdown,
      })
    expect(waitingProcessor).not.toHaveBeenCalled()
    releaseActive()
    await active
    await expect(queue.drain()).resolves.toBeUndefined()
  })

  it('bounds drain time for a non-cooperative active processor', async () => {
    vi.useFakeTimers()
    const queue = new TaskQueue()
    void queue.enqueue(item('stuck'), () => new Promise<RunResult>(() => {}))
    await Promise.resolve()

    const drain = queue.drain(25)
    const drainRejection = expect(drain).rejects.toMatchObject({
      name: 'TimeoutError',
      message: expect.stringContaining('queue drain'),
    })
    await vi.advanceTimersByTimeAsync(25)

    await drainRejection
    expect(queue.isProcessing()).toBe(true)
  })
})
