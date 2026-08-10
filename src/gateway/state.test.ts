import { describe, expect, it, vi } from 'vitest'
import { GatewayState } from './state.js'

describe('gatewayState', () => {
  it('starts idle and returns defensive snapshot copies', () => {
    const state = new GatewayState()
    const first = state.getSnapshot()
    expect(first).toMatchObject({
      running: false,
      currentRunId: null,
      queueDepth: 0,
      phase: 'idle',
    })

    first.running = true
    expect(state.getSnapshot().running).toBe(false)
  })

  it('merges updates and emits the complete new snapshot', () => {
    const state = new GatewayState()
    const onChange = vi.fn()
    state.on('change', onChange)

    state.update({ running: true, currentTask: 'mail', currentStep: 2 })

    expect(state.getSnapshot()).toMatchObject({ running: true, currentTask: 'mail', currentStep: 2 })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      running: true,
      currentTask: 'mail',
      currentStep: 2,
      phase: 'idle',
    }))
  })

  it('redacts credentials before action and reason enter observable state', () => {
    const state = new GatewayState()
    const onChange = vi.fn()
    state.on('change', onChange)

    state.update({
      currentAction: 'POST authorization=Bearer action-secret',
      currentReason: 'apiKey=reason-secret sk-123456789012',
    })

    const snapshot = state.getSnapshot()
    expect(snapshot.currentAction).toBe('POST authorization=[REDACTED]')
    expect(snapshot.currentReason).toBe('apiKey=[REDACTED] [REDACTED]')
    expect(JSON.stringify(onChange.mock.calls)).not.toMatch(/action-secret|reason-secret|sk-123/)
  })

  it('supports typed runtime events', () => {
    const state = new GatewayState()
    const onStart = vi.fn()
    state.on('run:start', onStart)
    state.emit('run:start', 'run-1', 'manual')
    expect(onStart).toHaveBeenCalledWith('run-1', 'manual')
  })

  it('redacts errors before notifying runtime observers', () => {
    const state = new GatewayState()
    const onError = vi.fn()
    const original = new Error('Bearer observer-secret apiKey=query-secret sk-123456789012')
    state.on('run:error', onError)

    state.emit('run:error', 'run-1', original)

    const observed = onError.mock.calls[0]?.[1] as Error
    expect(observed).not.toBe(original)
    expect(observed.message).toBe('Bearer [REDACTED] apiKey=[REDACTED] [REDACTED]')
    expect(observed.stack).not.toMatch(/observer-secret|query-secret|sk-123/)
    expect(original.message).toContain('observer-secret')
  })

  it('isolates throwing runtime observers and continues notifying listeners', () => {
    const state = new GatewayState()
    const healthyChange = vi.fn()
    const healthyStart = vi.fn()
    state.on('change', () => {
      throw new Error('broken change observer')
    })
    state.on('change', healthyChange)
    state.on('run:start', () => {
      throw new Error('broken run observer')
    })
    state.on('run:start', healthyStart)

    expect(() => state.update({ running: true })).not.toThrow()
    expect(() => state.emit('run:start', 'run-1', 'manual')).not.toThrow()
    expect(healthyChange).toHaveBeenCalledWith(expect.objectContaining({ running: true }))
    expect(healthyStart).toHaveBeenCalledWith('run-1', 'manual')
  })
})
