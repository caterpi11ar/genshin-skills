import type { RunResult } from '../tasks/task-runner.js'
import { describe, expect, it } from 'vitest'
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

  it('rejects a failed processor even when no error observer is registered', async () => {
    const queue = new TaskQueue()
    await expect(queue.enqueue(item('failed'), async () => {
      throw new Error('processor failed')
    })).rejects.toThrow('processor failed')
    expect(queue.getStatus()).toBe('idle')
  })
})
