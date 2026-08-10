import type { ProgressEvent } from './progress.js'
import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

const SENSITIVE_KEY_SOURCE = 'password|passphrase|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|cookie|authorization'
const SENSITIVE_KEYS = new RegExp(SENSITIVE_KEY_SOURCE, 'i')
const SENSITIVE_KEY_VALUE = new RegExp(
  `((?:${SENSITIVE_KEY_SOURCE})\\s*[:=]\\s*)(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|Bearer\\s+[^\\s,;&}]+|\\[REDACTED\\]|[^\\s,;&}\\]]+)`,
  'gi',
)
const BEARER_TOKEN = /\bBearer\s+[^\s,;"']+/gi
const BASIC_AUTH = /\bBasic\s+[\w+/=-]+/gi
const URL_USERINFO = /(https?:\/\/)[^\s/@]+@/gi
const LONG_SK_TOKEN = /\bsk-[\w-]{12,}\b/g
const REDACTED = '[REDACTED]'
const CIRCULAR = '[Circular]'
const UNSERIALIZABLE = '[Unserializable]'
export const MAX_PUBLIC_TEXT_CHARS = 4_096
const MAX_LOG_TEXT_CHARS = 16_384
const MAX_LOG_OUTPUT_BYTES = 64 * 1024
const MAX_LOG_DEPTH = 16
const MAX_LOG_NODES = 1_536
const MAX_LOG_ARRAY_ITEMS = 1_024
const MAX_LOG_OBJECT_FIELDS = 1_024
const MAX_LOG_CONTAINER_ITEMS = 256
const MAX_LOG_CONTAINER_FIELDS = 256
const TRUNCATED = '…[truncated]'
const VALUE_TRUNCATED = '[Truncated]'
const OMIT_VALUE = Symbol('omit-value')

interface SanitizeBudget {
  remainingOutputBytes: number
  remainingNodes: number
  remainingArrayItems: number
  remainingObjectFields: number
}

export function sanitizeSensitiveString(value: string): string {
  return value
    .replace(SENSITIVE_KEY_VALUE, `$1${REDACTED}`)
    .replace(BEARER_TOKEN, `Bearer ${REDACTED}`)
    .replace(BASIC_AUTH, `Basic ${REDACTED}`)
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(LONG_SK_TOKEN, REDACTED)
}

export function sanitizeBoundedText(
  value: string,
  maxChars: number = MAX_PUBLIC_TEXT_CHARS,
): string {
  if (maxChars <= 0)
    return ''

  // Redaction expressions should never scan an attacker-controlled multi-MB
  // string merely to retain a few KiB. The extra window lets a credential that
  // crosses the visible boundary be replaced before the result is truncated.
  const scanLimit = Math.max(maxChars * 4, maxChars + 1_024)
  const sourceWasTruncated = value.length > scanLimit
  const sanitized = sanitizeSensitiveString(sourceWasTruncated ? value.slice(0, scanLimit) : value)
  if (!sourceWasTruncated && sanitized.length <= maxChars)
    return sanitized
  if (maxChars <= TRUNCATED.length)
    return TRUNCATED.slice(0, maxChars)
  return `${sanitized.slice(0, maxChars - TRUNCATED.length)}${TRUNCATED}`
}

function createSanitizeBudget(): SanitizeBudget {
  return {
    remainingOutputBytes: MAX_LOG_OUTPUT_BYTES,
    remainingNodes: MAX_LOG_NODES,
    remainingArrayItems: MAX_LOG_ARRAY_ITEMS,
    remainingObjectFields: MAX_LOG_OBJECT_FIELDS,
  }
}

function reserveOutput(budget: SanitizeBudget, bytes: number): boolean {
  if (bytes > budget.remainingOutputBytes)
    return false
  budget.remainingOutputBytes -= bytes
  return true
}

function jsonByteLength(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function sanitizeStringWithinBudget(
  value: string,
  maxChars: number,
  budget: SanitizeBudget,
): string | typeof OMIT_VALUE {
  const sanitized = sanitizeBoundedText(value, maxChars)
  const fullBytes = jsonByteLength(sanitized)
  if (reserveOutput(budget, fullBytes))
    return sanitized

  if (jsonByteLength(VALUE_TRUNCATED) > budget.remainingOutputBytes)
    return OMIT_VALUE

  // The marker itself was proven to fit above, so only positive prefix lengths
  // need to participate in the search.
  let low = 1
  let high = Math.min(sanitized.length, maxChars)
  let candidate = VALUE_TRUNCATED
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const next = `${sanitized.slice(0, middle)}${TRUNCATED}`
    if (jsonByteLength(next) <= budget.remainingOutputBytes) {
      candidate = next
      low = middle + 1
    }
    else {
      high = middle - 1
    }
  }
  reserveOutput(budget, jsonByteLength(candidate))
  return candidate
}

function sanitizedMarker(marker: string, budget: SanitizeBudget): unknown | typeof OMIT_VALUE {
  return sanitizeStringWithinBudget(marker, 256, budget)
}

function reservePrimitive<T>(
  value: T,
  serializedBytes: number,
  budget: SanitizeBudget,
): T | typeof OMIT_VALUE {
  if (!reserveOutput(budget, serializedBytes))
    return OMIT_VALUE
  return value
}

function defineSanitizedProperty(
  target: Record<string, unknown>,
  property: string,
  value: unknown,
): void {
  // Assignment to __proto__ on an ordinary object invokes Object.prototype's
  // legacy setter. Defining a data property preserves JSON compatibility
  // without letting attacker-controlled log fields mutate the result's shape.
  Object.defineProperty(target, property, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  })
}

function sanitizeValue(
  value: unknown,
  key: string | undefined,
  ancestors: Set<object>,
  budget: SanitizeBudget,
  depth = 0,
): unknown | typeof OMIT_VALUE {
  if (key !== undefined && SENSITIVE_KEYS.test(key)) {
    return sanitizedMarker(REDACTED, budget)
  }

  if (depth > MAX_LOG_DEPTH)
    return sanitizedMarker(VALUE_TRUNCATED, budget)
  if (budget.remainingNodes <= 0)
    return sanitizedMarker(VALUE_TRUNCATED, budget)
  budget.remainingNodes--

  if (typeof value === 'string')
    return sanitizeStringWithinBudget(value, MAX_LOG_TEXT_CHARS, budget)

  if (typeof value === 'bigint')
    return sanitizeStringWithinBudget(value.toString(), MAX_LOG_TEXT_CHARS, budget)

  if (typeof value === 'number') {
    const serialized = JSON.stringify(value) as string
    return reservePrimitive(value, Buffer.byteLength(serialized, 'utf8'), budget)
  }

  if (typeof value === 'boolean')
    return reservePrimitive(value, value ? 4 : 5, budget)

  if (value === null)
    return reservePrimitive(null, 4, budget)

  if (value === undefined)
    return reservePrimitive(undefined, 4, budget)

  if (typeof value === 'symbol' || typeof value === 'function')
    return sanitizedMarker(UNSERIALIZABLE, budget)

  if (ancestors.has(value))
    return sanitizedMarker(CIRCULAR, budget)

  if (!reserveOutput(budget, 2))
    return OMIT_VALUE

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const sanitized: unknown[] = []
      let truncated = false
      for (let index = 0; index < value.length; index++) {
        if (index >= MAX_LOG_CONTAINER_ITEMS || budget.remainingArrayItems <= 0) {
          truncated = true
          break
        }
        const beforeItem = budget.remainingOutputBytes
        if (sanitized.length > 0 && !reserveOutput(budget, 1)) {
          truncated = true
          break
        }
        budget.remainingArrayItems--
        const item = sanitizeValue(value[index], undefined, ancestors, budget, depth + 1)
        if (item === OMIT_VALUE) {
          budget.remainingOutputBytes = beforeItem
          truncated = true
          break
        }
        sanitized.push(item)
      }

      if (truncated) {
        const beforeMarker = budget.remainingOutputBytes
        if (sanitized.length > 0 && !reserveOutput(budget, 1))
          return sanitized
        const marker = sanitizedMarker(VALUE_TRUNCATED, budget)
        if (marker === OMIT_VALUE)
          budget.remainingOutputBytes = beforeMarker
        else
          sanitized.push(marker)
      }
      return sanitized
    }

    const sanitized: Record<string, unknown> = {}
    const seenKeys = new Set<string>()
    let inspectedFields = 0
    let outputFields = 0
    let truncated = false

    const appendField = (property: string, nestedValue: unknown): boolean => {
      if (inspectedFields >= MAX_LOG_CONTAINER_FIELDS || budget.remainingObjectFields <= 0) {
        truncated = true
        return false
      }
      inspectedFields++
      budget.remainingObjectFields--

      const safeProperty = sanitizeBoundedText(property, 256)
      const beforeField = budget.remainingOutputBytes
      const punctuationBytes = (outputFields > 0 ? 1 : 0) + jsonByteLength(safeProperty) + 1
      if (!reserveOutput(budget, punctuationBytes)) {
        truncated = true
        return false
      }
      const nested = sanitizeValue(nestedValue, property, ancestors, budget, depth + 1)
      if (nested === OMIT_VALUE) {
        budget.remainingOutputBytes = beforeField
        truncated = true
        return false
      }
      defineSanitizedProperty(sanitized, safeProperty, nested)
      seenKeys.add(property)
      outputFields++
      return true
    }

    if (value instanceof Error) {
      if (!appendField('name', value.name)
        || !appendField('message', value.message)
        || !appendField('stack', value.stack)) {
        return sanitized
      }
      if ('cause' in value && !appendField('cause', value.cause))
        return sanitized
    }

    for (const property in value as Record<string, unknown>) {
      if (!Object.hasOwn(value, property) || seenKeys.has(property))
        continue
      if (inspectedFields >= MAX_LOG_CONTAINER_FIELDS || budget.remainingObjectFields <= 0) {
        truncated = true
        break
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, property)
      const nestedValue = descriptor && 'value' in descriptor
        ? descriptor.value
        : UNSERIALIZABLE
      if (!appendField(property, nestedValue))
        break
    }

    if (truncated && !Object.hasOwn(sanitized, VALUE_TRUNCATED)) {
      const beforeMarker = budget.remainingOutputBytes
      const punctuationBytes = (outputFields > 0 ? 1 : 0) + jsonByteLength(VALUE_TRUNCATED) + 1
      if (reserveOutput(budget, punctuationBytes) && reserveOutput(budget, 4))
        defineSanitizedProperty(sanitized, VALUE_TRUNCATED, true)
      else
        budget.remainingOutputBytes = beforeMarker
    }
    return sanitized
  }
  finally {
    ancestors.delete(value)
  }
}

function sanitizeArgs(args: unknown[]): unknown[] {
  try {
    const sanitized = sanitizeValue(args, undefined, new Set(), createSanitizeBudget())
    // A fresh budget always has room for the root array brackets.
    return sanitized as unknown[]
  }
  catch {
    return [UNSERIALIZABLE]
  }
}

export function sanitizeSensitiveData(value: unknown): unknown {
  try {
    return sanitizeValue(value, undefined, new Set(), createSanitizeBudget())
  }
  catch {
    return UNSERIALIZABLE
  }
}

export interface LogEntry {
  timestamp: string
  level: LogLevel
  message: string
  args: unknown[]
}

class Logger extends EventEmitter {
  private level: LogLevel
  private muted = false

  constructor() {
    super()
    this.level = 'info'
  }

  setLevel(level: LogLevel): void {
    this.level = level
  }

  mute(): void {
    this.muted = true
  }

  unmute(): void {
    this.muted = false
  }

  private log(level: LogLevel, message: string, ...args: unknown[]): void {
    if (LEVELS[level] < LEVELS[this.level])
      return
    const timestamp = new Date().toISOString()
    const sanitizedMessage = sanitizeBoundedText(message, MAX_LOG_TEXT_CHARS)
    const sanitized = sanitizeArgs(args)

    if (!this.muted) {
      const prefix = `[${timestamp}] [${level.toUpperCase()}]`
      try {
        if (sanitized.length > 0) {
          console.error(prefix, sanitizedMessage, ...sanitized)
        }
        else {
          console.error(prefix, sanitizedMessage)
        }
      }
      catch {
        // A broken output stream must not alter the automation result.
      }
    }

    // Emit for WebSocket / TUI subscribers
    const entry: LogEntry = { timestamp, level, message: sanitizedMessage, args: sanitized }
    this.emitSafely('log', entry)
  }

  debug(message: string, ...args: unknown[]): void {
    this.log('debug', message, ...args)
  }

  info(message: string, ...args: unknown[]): void {
    this.log('info', message, ...args)
  }

  warn(message: string, ...args: unknown[]): void {
    this.log('warn', message, ...args)
  }

  error(message: string, ...args: unknown[]): void {
    this.log('error', message, ...args)
  }

  emitProgress(event: ProgressEvent): void {
    this.emitSafely('progress', event)
  }

  private emitSafely(event: string, ...args: unknown[]): void {
    // EventEmitter stops at the first throwing listener. Invoke the raw
    // listeners independently so one failed WebSocket/TUI observer neither
    // interrupts core work nor prevents healthy observers from receiving it.
    for (const listener of this.rawListeners(event)) {
      try {
        Reflect.apply(listener, this, args)
      }
      catch {
        // Logging cannot safely log its own observer failure.
      }
    }
  }
}

export const logger = new Logger()
