import { beforeEach, describe, expect, it, vi } from 'vitest'

import { Scheduler } from './scheduler.js'

const mocks = vi.hoisted(() => ({ schedule: vi.fn() }))
vi.mock('node-cron', () => ({ default: { schedule: mocks.schedule } }))

describe('scheduler', () => {
  beforeEach(() => {
    mocks.schedule.mockReset()
  })

  it('starts once with the configured cron expression and timezone', () => {
    const stop = vi.fn()
    mocks.schedule.mockReturnValue({ stop })
    const onTick = vi.fn()
    const scheduler = new Scheduler({
      cronExpr: '0 6 * * *',
      timezone: 'Asia/Shanghai',
      onTick,
    })

    scheduler.start()
    scheduler.start()

    expect(mocks.schedule).toHaveBeenCalledOnce()
    expect(mocks.schedule).toHaveBeenCalledWith('0 6 * * *', onTick, { timezone: 'Asia/Shanghai' })
    expect(scheduler.getCronExpr()).toBe('0 6 * * *')
    expect(scheduler.getTimezone()).toBe('Asia/Shanghai')
  })

  it('stops an active job once and can be started again', async () => {
    const firstStop = vi.fn()
    const secondStop = vi.fn()
    mocks.schedule.mockReturnValueOnce({ stop: firstStop }).mockReturnValueOnce({ stop: secondStop })
    const scheduler = new Scheduler({ cronExpr: '* * * * *', timezone: 'UTC', onTick: vi.fn() })

    await scheduler.stop()
    scheduler.start()
    await scheduler.stop()
    await scheduler.stop()
    scheduler.start()

    expect(firstStop).toHaveBeenCalledOnce()
    expect(secondStop).not.toHaveBeenCalled()
    expect(mocks.schedule).toHaveBeenCalledTimes(2)
  })

  it('deduplicates asynchronous stops and retains a failed job for retry', async () => {
    let rejectStop: ((error: Error) => void) | undefined
    const stop = vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectStop = reject
    }))
    mocks.schedule.mockReturnValue({ stop })
    const scheduler = new Scheduler({ cronExpr: '* * * * *', timezone: 'UTC', onTick: vi.fn() })
    scheduler.start()

    const first = scheduler.stop()
    const duplicate = scheduler.stop()
    expect(first).toBe(duplicate)
    await Promise.resolve()
    rejectStop?.(new Error('stop failed'))
    await expect(first).rejects.toThrow('stop failed')

    stop.mockResolvedValueOnce(undefined)
    await expect(scheduler.stop()).resolves.toBeUndefined()
    scheduler.start()
    expect(mocks.schedule).toHaveBeenCalledTimes(2)
  })
})
