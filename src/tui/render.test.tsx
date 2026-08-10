import type { Gateway } from '../gateway/gateway.js'
import { render } from 'ink'
import { describe, expect, it, vi } from 'vitest'
import { logger } from '../utils/logger.js'
import { Dashboard } from './Dashboard.js'
import { renderDashboard } from './render.js'

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>()
  return { ...actual, render: vi.fn() }
})

describe('dashboard renderer', () => {
  it('mutes plain logs and mounts the dashboard', () => {
    const mute = vi.spyOn(logger, 'mute').mockImplementation(() => {})
    const gateway = {} as Gateway

    renderDashboard(gateway)

    expect(mute).toHaveBeenCalledOnce()
    expect(render).toHaveBeenCalledOnce()
    const element = vi.mocked(render).mock.calls[0]?.[0]
    expect(element).toMatchObject({
      type: Dashboard,
      props: { gateway },
    })
  })

  it('restores logging when dashboard startup fails', () => {
    const startupError = new Error('dashboard failed')
    vi.mocked(render).mockImplementation(() => {
      throw startupError
    })
    const unmute = vi.spyOn(logger, 'unmute').mockImplementation(() => {})

    expect(() => renderDashboard({} as Gateway)).toThrow(startupError)

    expect(unmute).toHaveBeenCalledOnce()
  })
})
