import { Buffer } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logger, sanitizeBoundedText, sanitizeSensitiveData, sanitizeSensitiveString } from './logger.js'

describe('logger', () => {
  beforeEach(() => {
    logger.setLevel('debug')
    logger.unmute()
  })

  afterEach(() => {
    logger.removeAllListeners('log')
    logger.removeAllListeners('progress')
    logger.setLevel('info')
    logger.unmute()
    vi.restoreAllMocks()
  })

  it('filters messages below the configured level', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onLog = vi.fn()
    logger.on('log', onLog)
    logger.setLevel('warn')

    logger.debug('debug')
    logger.info('info')
    logger.warn('warn')

    expect(consoleError).toHaveBeenCalledOnce()
    expect(onLog).toHaveBeenCalledOnce()
    expect(onLog).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn', message: 'warn' }))
  })

  it('recursively redacts sensitive fields before output and events', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onLog = vi.fn()
    logger.on('log', onLog)

    logger.info('configured', {
      apiKey: 'secret-key',
      authorization: 'Bearer secret',
      cookie: 'session',
      model: 'safe-model',
      nested: {
        password: 'password',
        values: [{ accessToken: 'token' }, 'safe'],
      },
    })

    const expected = {
      apiKey: '[REDACTED]',
      authorization: '[REDACTED]',
      cookie: '[REDACTED]',
      model: 'safe-model',
      nested: {
        password: '[REDACTED]',
        values: [{ accessToken: '[REDACTED]' }, 'safe'],
      },
    }
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('[INFO]'),
      'configured',
      expected,
    )
    expect(onLog).toHaveBeenCalledWith(expect.objectContaining({ args: [expected] }))
  })

  it('preserves useful Error details and sanitizes its cause and properties', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const onLog = vi.fn()
    logger.on('log', onLog)
    const cause = Object.assign(new Error('root failure'), { apiKey: 'cause-key' })
    const error = Object.assign(new Error('request failed', { cause }), {
      authorization: 'Bearer credential',
      context: { cookie: 'session-cookie' },
    })

    logger.error('failed', error)

    const [entry] = onLog.mock.calls[0] as [{ args: unknown[] }]
    expect(entry.args[0]).toEqual(expect.objectContaining({
      name: 'Error',
      message: 'request failed',
      stack: expect.stringContaining('Error: request failed'),
      authorization: '[REDACTED]',
      context: { cookie: '[REDACTED]' },
      cause: expect.objectContaining({
        name: 'Error',
        message: 'root failure',
        stack: expect.stringContaining('Error: root failure'),
        apiKey: '[REDACTED]',
      }),
    }))
  })

  it('redacts credentials embedded in messages, URLs, and Error chains', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const onLog = vi.fn()
    logger.on('log', onLog)
    const secret = 'sk-123456789012'
    const cause = new Error(`authorization=Bearer cause-token ${secret}`)
    const error = new Error('request failed: api_key=query-secret', { cause })

    logger.error(
      `POST https://example.test/v1?token=url-secret&safe=1 Bearer header-token ${secret}`,
      error,
    )

    const [entry] = onLog.mock.calls[0] as [{ message: string, args: Array<Record<string, unknown>> }]
    expect(entry.message).not.toMatch(/url-secret|header-token|sk-123/)
    expect(entry.message).toContain('token=[REDACTED]')
    expect(entry.args[0]!.message).toBe('request failed: api_key=[REDACTED]')
    expect(entry.args[0]!.stack).not.toContain('query-secret')
    const sanitizedCause = entry.args[0]!.cause as { message: string, stack: string }
    expect(sanitizedCause.message).not.toMatch(/cause-token|sk-123/)
    expect(sanitizedCause.message).toContain('authorization=[REDACTED]')
    expect(sanitizedCause.stack).not.toContain('cause-token')
  })

  it('redacts Basic authorization values and URL user information', () => {
    const value = sanitizeSensitiveString(
      'Basic dXNlcjpwYXNzd29yZA== https://user:password@example.test/path',
    )

    expect(value).toBe('Basic [REDACTED] https://[REDACTED]@example.test/path')
    expect(value).not.toMatch(/dXNlcj|user|password/)
  })

  it('exports a persistence-safe sanitizer', () => {
    expect(sanitizeSensitiveString('password="two words" Bearer abc sk-123456789012')).toBe(
      'password=[REDACTED] Bearer [REDACTED] [REDACTED]',
    )
    expect(sanitizeSensitiveData({ nested: ['apiKey=visible-secret'] })).toEqual({
      nested: ['apiKey=[REDACTED]'],
    })
  })

  it('bounds public text after redaction, including very small limits', () => {
    const bounded = sanitizeBoundedText(
      `Bearer direct-secret ${'x'.repeat(5_000)}`,
    )

    expect(bounded).toHaveLength(4_096)
    expect(bounded).not.toContain('direct-secret')
    expect(bounded).toMatch(/…\[truncated\]$/)
    expect(sanitizeBoundedText('oversized', 3)).toBe('…[t')
    expect(sanitizeBoundedText('oversized', 0)).toBe('')
    expect(sanitizeBoundedText('x'.repeat(20_000))).toHaveLength(4_096)
  })

  it('keeps redaction idempotent across multiple trust boundaries', () => {
    const once = sanitizeSensitiveString(
      'authorization=Bearer secret apiKey=query-secret sk-123456789012',
    )

    expect(sanitizeSensitiveString(once)).toBe(once)
    expect(sanitizeSensitiveString(sanitizeSensitiveString(once))).toBe(once)
  })

  it('replaces circular references without throwing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const onLog = vi.fn()
    logger.on('log', onLog)
    const circular: Record<string, unknown> = { label: 'safe' }
    circular.self = circular
    circular.items = [circular, 123n]

    expect(() => logger.info('circular', circular)).not.toThrow()
    expect(onLog).toHaveBeenCalledWith(expect.objectContaining({
      args: [{ label: 'safe', self: '[Circular]', items: ['[Circular]', '123'] }],
    }))
    expect(() => JSON.stringify(onLog.mock.calls[0]![0])).not.toThrow()
  })

  it('truncates huge containers without copying every item or field', () => {
    const hugeArray = Array.from({ length: 100_001 }, (_, index) => index)
    const hugeObject = Object.fromEntries(
      Array.from({ length: 10_000 }, (_, index) => [`field${index}`, index]),
    )

    const sanitizedArray = sanitizeSensitiveData({ items: hugeArray }) as {
      items: unknown[]
    }
    const sanitizedObject = sanitizeSensitiveData(hugeObject) as Record<string, unknown>

    expect(sanitizedArray.items).toHaveLength(257)
    expect(sanitizedArray.items.at(-1)).toBe('[Truncated]')
    expect(Object.keys(sanitizedObject).length).toBeLessThanOrEqual(257)
    expect(sanitizedObject['[Truncated]']).toBe(true)
  })

  it('enforces a cumulative serialized-output budget across nested values', () => {
    const value = {
      items: Array.from({ length: 256 }).fill('x'.repeat(16_000)),
    }

    const sanitized = sanitizeSensitiveData(value)
    const serialized = JSON.stringify(sanitized)

    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(64 * 1024)
    expect(serialized).toContain('truncated')
  })

  it('bounds recursion depth and safely handles accessor failures', () => {
    const root: Record<string, unknown> = {}
    let cursor = root
    for (let index = 0; index < 100; index++) {
      const nested: Record<string, unknown> = {}
      cursor.nested = nested
      cursor = nested
    }
    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => {
        throw new Error('must not execute')
      },
    })

    expect(JSON.stringify(sanitizeSensitiveData(root))).toContain('[Truncated]')
    expect(sanitizeSensitiveData(accessor)).toEqual({ value: '[Unserializable]' })
  })

  it('preserves hostile field names without prototype mutation', () => {
    const hostile = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}',
    ) as Record<string, unknown>

    const sanitized = sanitizeSensitiveData(hostile) as Record<string, unknown>

    expect(Object.getPrototypeOf(sanitized)).toBe(Object.prototype)
    expect(Object.hasOwn(sanitized, '__proto__')).toBe(true)
    expect(Object.hasOwn(sanitized, 'constructor')).toBe(true)
    expect(JSON.parse(JSON.stringify(sanitized))).toEqual(hostile)
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })

  it('does not let an unserializable argument break logging', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const onLog = vi.fn()
    logger.on('log', onLog)
    const throwingProxy = new Proxy({}, {
      ownKeys: () => {
        throw new Error('cannot inspect')
      },
    })

    expect(() => logger.warn('unserializable', throwingProxy)).not.toThrow()
    expect(onLog).toHaveBeenCalledWith(expect.objectContaining({
      args: ['[Unserializable]'],
    }))
    expect(sanitizeSensitiveData(throwingProxy)).toBe('[Unserializable]')
  })

  it('handles Error values without a stack', () => {
    const error = new Error('failure')
    error.stack = undefined

    expect(sanitizeSensitiveData(error)).toMatchObject({
      name: 'Error',
      message: 'failure',
      stack: undefined,
    })
  })

  it('preserves primitive and array log arguments', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const onLog = vi.fn()
    logger.on('log', onLog)

    logger.info('values', 'text', 42, Number.NaN, true, false, null, undefined, 1n, ['array'])

    expect(onLog).toHaveBeenCalledWith(expect.objectContaining({
      args: ['text', 42, Number.NaN, true, false, null, undefined, '1', ['array']],
    }))
  })

  it('replaces unsupported symbol and function values', () => {
    const sanitized = sanitizeSensitiveData({
      symbol: Symbol('unsafe'),
      function: () => 'unsafe',
    })

    expect(sanitized).toEqual({
      symbol: '[Unserializable]',
      function: '[Unserializable]',
    })
  })

  it('stops safely when a later array value cannot fit the remaining output budget', () => {
    const value = [
      'x'.repeat(16_384),
      'x'.repeat(16_384),
      'x'.repeat(16_384),
      'x'.repeat(16_361),
      'never-copied',
    ]

    const sanitized = sanitizeSensitiveData(value)

    expect(Buffer.byteLength(JSON.stringify(sanitized), 'utf8')).toBeLessThanOrEqual(64 * 1024)
    expect(sanitized).not.toContain('never-copied')
  })

  it('stops when the remaining output cannot fit a primitive or container', () => {
    const prefix = [
      'x'.repeat(16_384),
      'x'.repeat(16_384),
      'x'.repeat(16_384),
    ]
    const primitiveResult = sanitizeSensitiveData([
      ...prefix,
      'x'.repeat(16_365),
      123_456_789,
    ])
    const containerResult = sanitizeSensitiveData([
      ...prefix,
      'x'.repeat(16_369),
      {},
    ])

    expect(Buffer.byteLength(JSON.stringify(primitiveResult), 'utf8')).toBeLessThanOrEqual(64 * 1024)
    expect(Buffer.byteLength(JSON.stringify(containerResult), 'utf8')).toBeLessThanOrEqual(64 * 1024)
    expect(JSON.stringify(primitiveResult)).not.toContain('123456789')
    expect(containerResult).toHaveLength(4)
  })

  it('stops safely at object punctuation, child-value, and truncation-marker boundaries', () => {
    const longKey = 'k'.repeat(256)
    for (let tailLength = 15_000; tailLength <= 16_384; tailLength += 8) {
      const sanitized = sanitizeSensitiveData({
        a: 'x'.repeat(16_384),
        b: 'x'.repeat(16_384),
        c: 'x'.repeat(16_384),
        d: 'x'.repeat(tailLength),
        e: 'not-retained',
        [longKey]: 'not-retained',
      })
      expect(Buffer.byteLength(JSON.stringify(sanitized), 'utf8')).toBeLessThanOrEqual(64 * 1024)
    }
  })

  it('stops Error expansion when the shared object-field budget is exhausted', () => {
    const fields = (count: number) => Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`field${index}`, undefined]),
    )
    const value = {
      first: fields(256),
      second: fields(256),
      third: fields(256),
      fourth: fields(249),
      error: new Error('not retained'),
    }

    expect(() => sanitizeSensitiveData(value)).not.toThrow()
  })

  it('bounds the combined node count across mixed object and array containers', () => {
    const fields = (prefix: string) => Object.fromEntries(
      Array.from({ length: 256 }, (_, index) => [`${prefix}${index}`, undefined]),
    )
    const value = {
      first: fields('a'),
      second: fields('b'),
      third: fields('c'),
      fourth: Array.from({ length: 256 }),
      fifth: Array.from({ length: 256 }),
      sixth: Array.from({ length: 256 }),
    }

    expect(JSON.stringify(sanitizeSensitiveData(value))).toContain('[Truncated]')
  })

  it('handles inherited fields and an exhausted field budget without copying either', () => {
    const inherited = Object.assign(Object.create({ inherited: 'must-not-copy' }), { own: 'safe' })
    expect(sanitizeSensitiveData(inherited)).toEqual({ own: 'safe' })

    const redactedFields = (offset: number) => Object.fromEntries(
      Array.from({ length: 256 }, (_, index) => [`token${offset + index}`, 'secret-value']),
    )
    const sanitized = sanitizeSensitiveData([
      redactedFields(0),
      redactedFields(256),
      redactedFields(512),
      redactedFields(768),
      { final: 'must-not-copy' },
    ]) as Array<Record<string, unknown>>

    expect(sanitized.at(-1)).toEqual({ '[Truncated]': true })
    expect(JSON.stringify(sanitized)).not.toContain('must-not-copy')
  })

  it('stops before an Error cause when only its standard fields fit', () => {
    const fields = (count: number) => Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`token${index}`, 'secret-value']),
    )
    const error = new Error('outer', { cause: new Error('must not inspect') })
    const value = {
      first: fields(256),
      second: fields(256),
      third: fields(256),
      fourth: fields(248),
      error,
    }

    const sanitized = sanitizeSensitiveData(value) as Record<string, unknown>
    expect(JSON.stringify(sanitized)).not.toContain('must not inspect')
  })

  it('still emits structured log entries while console output is muted', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onLog = vi.fn()
    logger.on('log', onLog)
    logger.mute()

    logger.error('hidden', new Error('failure'))

    expect(consoleError).not.toHaveBeenCalled()
    expect(onLog).toHaveBeenCalledWith(expect.objectContaining({ level: 'error', message: 'hidden' }))
  })

  it('isolates console and log subscriber failures from healthy observers', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('output unavailable')
    })
    const healthy = vi.fn()
    logger.on('log', () => {
      throw new Error('broken observer')
    })
    logger.on('log', healthy)

    expect(() => logger.info('still running')).not.toThrow()
    expect(healthy).toHaveBeenCalledWith(expect.objectContaining({ message: 'still running' }))
  })

  it('forwards progress events', () => {
    const onProgress = vi.fn()
    logger.on('progress', onProgress)
    const event = {
      phase: 'running' as const,
      taskIndex: 1,
      taskTotal: 2,
      taskId: 'mail',
      step: 3,
      elapsed: 100,
      action: 'aiTap',
      reason: 'button',
      timestamp: '2026-08-07T00:00:00.000Z',
    }

    logger.emitProgress(event)
    expect(onProgress).toHaveBeenCalledWith(event)
  })

  it('isolates progress subscriber failures from healthy observers', () => {
    const healthy = vi.fn()
    logger.on('progress', () => {
      throw new Error('broken observer')
    })
    logger.on('progress', healthy)
    const event = {
      phase: 'running' as const,
      taskIndex: 1,
      taskTotal: 1,
      taskId: 'mail',
      step: 1,
      elapsed: 10,
      action: 'aiTap',
      reason: 'button',
      timestamp: '2026-08-07T00:00:00.000Z',
    }

    expect(() => logger.emitProgress(event)).not.toThrow()
    expect(healthy).toHaveBeenCalledWith(event)
  })
})
