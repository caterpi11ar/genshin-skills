import type { RunResult } from '../tasks/task-runner.js'
import type { QueueItem, QueueStatus } from './types.js'
import { EventEmitter } from 'node:events'
import { QueueError, TimeoutError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'

interface QueueEntry {
  item: QueueItem
  processor: () => Promise<RunResult>
  resolve: (result: RunResult) => void
  reject: (error: Error) => void
}

export interface QueueReceipt {
  status: 'started' | 'queued'
  completion: Promise<RunResult>
}

/**
 * Serial FIFO task queue. Replaces the boolean `isRunning` flag.
 * enqueue() returns a Promise that resolves when the item is processed.
 */
export class TaskQueue extends EventEmitter {
  private queue: QueueEntry[] = []
  private processing = false
  private accepting = true
  private closeReason: Error | null = null
  private status: QueueStatus = 'idle'
  private readonly maxDepth: number

  constructor(maxDepth: number = 10) {
    super()
    if (!Number.isInteger(maxDepth) || maxDepth < 1)
      throw new QueueError(`Queue maxDepth must be a positive integer, received ${maxDepth}`)
    this.maxDepth = maxDepth
  }

  enqueue(
    item: QueueItem,
    processor: () => Promise<RunResult>,
  ): Promise<RunResult> {
    try {
      return this.submit(item, processor).completion
    }
    catch (error) {
      return Promise.reject(error)
    }
  }

  /**
   * Atomically accept work and return before the processor completes.
   * Admission failures throw synchronously so transports can report whether
   * a request was actually accepted without waiting for the entire run.
   */
  submit(
    item: QueueItem,
    processor: () => Promise<RunResult>,
  ): QueueReceipt {
    if (!this.accepting) {
      throw new QueueError(
        `Queue is closed; run ${item.runId} was not accepted`,
        this.closeReason!,
      )
    }
    if (this.queue.length >= this.maxDepth) {
      throw new QueueError(
        `Queue is full (${this.queue.length}/${this.maxDepth}); run ${item.runId} was not enqueued`,
      )
    }
    const status = this.processing || this.queue.length > 0 ? 'queued' : 'started'
    const completion = new Promise<RunResult>((resolve, reject) => {
      this.queue.push({ item, processor, resolve, reject })
      logger.info(
        `Queue: enqueued run ${item.runId} (trigger=${item.trigger}), depth=${this.queue.length}`,
      )
      this.emitSafely('enqueue', item)
      void this.processNext()
    })
    return { status, completion }
  }

  getDepth(): number {
    return this.queue.length
  }

  getStatus(): QueueStatus {
    return this.status
  }

  isProcessing(): boolean {
    return this.processing
  }

  /** Stop accepting work and reject anything that has not started. */
  close(reason: Error = new QueueError('Queue was closed')): void {
    if (!this.accepting)
      return
    this.accepting = false
    this.closeReason = reason
    const waiting = this.queue.splice(0)
    for (const entry of waiting) {
      entry.reject(reason)
      if (this.listenerCount('error') > 0)
        this.emitSafely('error', entry.item, reason)
    }
    if (!this.processing)
      this.markIdle()
  }

  /** Wait for active work to finish, optionally with a hard deadline. */
  async drain(timeoutMs?: number): Promise<void> {
    if (this.queue.length === 0 && !this.processing)
      return
    this.status = 'draining'
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const onIdle = () => {
        if (timer)
          clearTimeout(timer)
        resolve()
      }
      this.once('idle', onIdle)
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.removeListener('idle', onIdle)
          reject(new TimeoutError('queue drain', timeoutMs))
        }, timeoutMs)
      }
    })
  }

  private async processNext(): Promise<void> {
    if (this.processing)
      return
    // processNext is only entered after submit has synchronously appended an
    // entry, or after a completed entry observed another queued item.
    const entry = this.queue.shift()!

    this.processing = true
    this.status = 'processing'
    this.emitSafely('processing', entry.item)

    try {
      const result = await entry.processor()
      entry.resolve(result)
      this.emitSafely('complete', entry.item, result)
    }
    catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      entry.reject(error)
      // EventEmitter treats an unhandled "error" event as an exception.
      // The queue Promise is already rejected, so only emit for observers.
      if (this.listenerCount('error') > 0)
        this.emitSafely('error', entry.item, error)
    }
    finally {
      this.processing = false
      if (this.queue.length > 0) {
        void this.processNext()
      }
      else {
        this.markIdle()
      }
    }
  }

  private markIdle(): void {
    this.status = 'idle'
    this.emitSafely('idle')
  }

  private emitSafely(event: string, ...args: unknown[]): void {
    try {
      this.emit(event, ...args)
    }
    catch (error) {
      try {
        logger.error(`Queue "${event}" listener failed`, error)
      }
      catch {
        // Observability failures must never wedge queue execution.
      }
    }
  }
}
