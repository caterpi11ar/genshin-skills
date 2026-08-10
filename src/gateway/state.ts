import type { GatewayEvents, GatewaySnapshot } from './types.js'
import { EventEmitter } from 'node:events'
import { sanitizeBoundedText } from '../utils/logger.js'

function sanitizeNullableText(value: string | null): string | null {
  return value === null ? null : sanitizeBoundedText(value)
}

function sanitizeObserverError(error: Error): Error {
  const sanitized = new Error(sanitizeBoundedText(error.message))
  sanitized.name = sanitizeBoundedText(error.name, 256)
  return sanitized
}

/**
 * Observable runtime state. Emits "change" whenever state updates.
 * TUI and Web subscribe to this instead of importing daemon module-level vars.
 */
export class GatewayState extends EventEmitter {
  private snapshot: GatewaySnapshot = {
    running: false,
    currentRunId: null,
    currentTask: null,
    queueDepth: 0,
    lastRunAt: null,
    lastSuccess: null,
    phase: 'idle',
    taskIndex: 0,
    taskTotal: 0,
    currentStep: 0,
    elapsed: 0,
    currentAction: null,
    currentReason: null,
  }

  getSnapshot(): GatewaySnapshot {
    return { ...this.snapshot }
  }

  update(partial: Partial<GatewaySnapshot>): void {
    const sanitized = { ...partial }
    if (sanitized.currentAction !== undefined)
      sanitized.currentAction = sanitizeNullableText(sanitized.currentAction)
    if (sanitized.currentReason !== undefined)
      sanitized.currentReason = sanitizeNullableText(sanitized.currentReason)
    Object.assign(this.snapshot, sanitized)
    this.emit('change', this.getSnapshot())
  }

  // Typed event helpers (for consumers)
  override on<K extends keyof GatewayEvents>(
    event: K,
    listener: GatewayEvents[K],
  ): this
  override on(event: string, listener: (...args: unknown[]) => void): this
  override on(event: string, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener)
  }

  override emit<K extends keyof GatewayEvents>(
    event: K,
    ...args: Parameters<GatewayEvents[K]>
  ): boolean
  override emit(event: string, ...args: unknown[]): boolean
  override emit(event: string, ...args: unknown[]): boolean {
    const sanitizedArgs = event === 'run:error' && args[1] instanceof Error
      ? [args[0], sanitizeObserverError(args[1])]
      : args
    const listeners = this.rawListeners(event)
    for (const listener of listeners) {
      try {
        Reflect.apply(listener, this, sanitizedArgs)
      }
      catch {
        // Runtime observers are informational and must not alter a run.
      }
    }
    return listeners.length > 0
  }
}
