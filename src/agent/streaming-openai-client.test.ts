import { describe, expect, it, vi } from 'vitest'
import {
  createAbortableOpenAIClient,
  createStreamingOpenAIClient,
} from './streaming-openai-client.js'

interface TestClient {
  chat: {
    completions: {
      create: (request: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>
    }
  }
}

function asTestClient(value: unknown): TestClient {
  return value as TestClient
}

describe('streaming OpenAI client', () => {
  it('injects task cancellation into regular model requests without forcing streaming', async () => {
    const create = vi.fn(async () => ({ choices: [] }))
    const controller = new AbortController()
    const wrapped = asTestClient(createAbortableOpenAIClient({
      chat: { completions: { create } },
    }, controller.signal))

    const request = {
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'describe the button' }],
      response_format: { type: 'json_object' },
      stream: false,
    }
    await wrapped.chat.completions.create(request, { signal: 'upstream-signal', timeout: 1000 })

    expect(create).toHaveBeenCalledWith(request, {
      signal: controller.signal,
      timeout: 1000,
    })
    expect(request.messages).toEqual([{ role: 'user', content: 'describe the button' }])
  })

  it('rejects invalid clients and request values', async () => {
    expect(() => createStreamingOpenAIClient({})).toThrow('chat.completions.create')

    const wrapped = asTestClient(createStreamingOpenAIClient({
      chat: { completions: { create: vi.fn() } },
    }))
    await expect(wrapped.chat.completions.create(null as unknown as Record<string, unknown>))
      .rejects
      .toThrow('request object')
  })

  it('forces streaming and aggregates text, reasoning, and usage', async () => {
    const create = vi.fn(async () => (async function* () {
      yield {
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        created: 123,
        model: 'gpt-5.6-terra',
        choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '先分析' } }],
      }
      yield {
        id: 'chatcmpl-test',
        choices: [{
          index: 0,
          delta: {
            content: '{"actions":',
            tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'act', arguments: '{"x":' } }],
          },
        }],
      }
      yield {
        id: 'chatcmpl-test',
        choices: [{
          index: 0,
          delta: {
            content: '[]}',
            tool_calls: [{ index: 0, function: { arguments: '1}' } }],
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      }
    })())
    const controller = new AbortController()
    const wrapped = asTestClient(createStreamingOpenAIClient({
      chat: { completions: { create } },
    }, controller.signal))

    const result = await wrapped.chat.completions.create(
      { model: 'gpt-5.6-terra', messages: [], stream: false },
      { signal: 'test-signal' },
    )

    expect(create).toHaveBeenCalledWith(
      { model: 'gpt-5.6-terra', messages: [], stream: true },
      { signal: controller.signal, stream: true },
    )
    expect(result).toMatchObject({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 123,
      model: 'gpt-5.6-terra',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: '{"actions":[]}',
          reasoning_content: '先分析',
          tool_calls: [{
            index: 0,
            id: 'call-1',
            type: 'function',
            function: { name: 'act', arguments: '{"x":1}' },
          }],
        },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    })
  })

  it('passes an existing streaming request through unchanged', async () => {
    const stream = (async function* () {})()
    const create = vi.fn(async () => stream)
    const wrapped = asTestClient(createStreamingOpenAIClient({
      chat: { completions: { create } },
    }))
    const request = { model: 'gpt-5.6-sol', stream: true }
    const options = { stream: true }

    await expect(wrapped.chat.completions.create(request, options)).resolves.toBe(stream)
    expect(create).toHaveBeenCalledWith(request, options)
  })

  it('injects task cancellation into pre-streamed requests', async () => {
    const stream = (async function* () {})()
    const create = vi.fn(async () => stream)
    const controller = new AbortController()
    const wrapped = asTestClient(createStreamingOpenAIClient({
      chat: { completions: { create } },
    }, controller.signal))
    const request = { model: 'gpt-5.6-sol', stream: true }

    await wrapped.chat.completions.create(request)
    expect(create).toHaveBeenCalledWith(request, { signal: controller.signal })
  })

  it('adds a JSON instruction when json_object mode requires one', async () => {
    const stream = (async function* () {
      yield {
        id: 'chatcmpl-json',
        choices: [{ index: 0, delta: { content: '{"x":1}' }, finish_reason: 'stop' }],
      }
    })()
    const create = vi.fn(async () => stream)
    const wrapped = asTestClient(createStreamingOpenAIClient({
      chat: { completions: { create } },
    }))

    await wrapped.chat.completions.create({
      model: 'gpt-5.6-sol',
      messages: [
        { role: 'system', content: 'Use the JSON schema provided.' },
        { role: 'user', content: '找到邮件按钮' },
      ],
      response_format: { type: 'json_object' },
      stream: false,
    })

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      stream: true,
      messages: [
        { role: 'system', content: 'Use the JSON schema provided.' },
        { role: 'user', content: '找到邮件按钮\n\nReturn the response as a valid JSON object.' },
      ],
    }), { stream: true })
  })

  it('does not mistake JSON-looking image data for a textual JSON instruction', async () => {
    const stream = (async function* () {
      yield {
        id: 'chatcmpl-image-json',
        choices: [{ index: 0, delta: { content: '{"x":1}' }, finish_reason: 'stop' }],
      }
    })()
    const create = vi.fn(async () => stream)
    const wrapped = asTestClient(createStreamingOpenAIClient({
      chat: { completions: { create } },
    }))

    await wrapped.chat.completions.create({
      model: 'gpt-5.6-sol',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '找到邮件按钮' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,json' } },
        ],
      }],
      response_format: { type: 'json_object' },
      stream: false,
    })

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '找到邮件按钮' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,json' } },
          { type: 'text', text: 'Return the response as a valid JSON object.' },
        ],
      }],
    }), { stream: true })
  })

  it('rejects a stream that never returns a choice', async () => {
    const create = vi.fn(async () => (async function* () {
      yield { id: 'chatcmpl-empty', choices: [], usage: { total_tokens: 1 } }
    })())
    const wrapped = asTestClient(createStreamingOpenAIClient({
      chat: { completions: { create } },
    }))

    await expect(wrapped.chat.completions.create({ model: 'test', stream: false }))
      .rejects
      .toThrow('without choices')
  })

  it('rejects empty and non-async stream responses', async () => {
    const empty = asTestClient(createStreamingOpenAIClient({
      chat: { completions: { create: vi.fn(async () => (async function* () {})()) } },
    }))
    await expect(empty.chat.completions.create({ model: 'test' }))
      .rejects
      .toThrow('without response chunks')

    const invalid = asTestClient(createStreamingOpenAIClient({
      chat: { completions: { create: vi.fn(async () => ({ choices: [] })) } },
    }))
    await expect(invalid.chat.completions.create({ model: 'test' }))
      .rejects
      .toThrow('async chat completion stream')
  })

  it('rejects tool-call indices that could create an unbounded sparse array', async () => {
    const create = vi.fn(async () => (async function* () {
      yield {
        id: 'unsafe-tool-index',
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 4_294_967_294, function: { name: 'act', arguments: '{}' } }] },
        }],
      }
    })())
    const wrapped = asTestClient(createStreamingOpenAIClient({ chat: { completions: { create } } }))

    await expect(wrapped.chat.completions.create({ model: 'test' }))
      .rejects
      .toThrow('Invalid streaming tool call index')
  })

  it.each([-1, 1.5])('rejects malformed streaming tool-call index %s', async (index) => {
    const create = vi.fn(async () => (async function* () {
      yield {
        id: 'malformed-tool-index',
        choices: [{ index: 0, delta: { tool_calls: [{ index, function: { name: 'act' } }] } }],
      }
    })())
    const wrapped = asTestClient(createStreamingOpenAIClient({ chat: { completions: { create } } }))

    await expect(wrapped.chat.completions.create({ model: 'test' }))
      .rejects
      .toThrow('Invalid streaming tool call index')
  })

  it('rejects an oversized accumulated streaming response', async () => {
    const create = vi.fn(async () => (async function* () {
      yield {
        id: 'oversized',
        choices: [{ index: 0, delta: { content: 'x'.repeat(1024 * 1024 + 1) } }],
      }
    })())
    const wrapped = asTestClient(createStreamingOpenAIClient({ chat: { completions: { create } } }))

    await expect(wrapped.chat.completions.create({ model: 'test' }))
      .rejects
      .toThrow('character text limit')
  })

  it('applies the response budget to arbitrary nested delta fields', async () => {
    const create = vi.fn(async () => (async function* () {
      yield {
        id: 'oversized-audio',
        choices: [{
          index: 0,
          delta: { audio: { data: 'x'.repeat(2 * 1024 * 1024) } },
        }],
      }
    })())
    const wrapped = asTestClient(createStreamingOpenAIClient({ chat: { completions: { create } } }))

    await expect(wrapped.chat.completions.create({ model: 'test' }))
      .rejects
      .toThrow('character text limit')
  })

  it('bounds nested logprobs, usage, metadata, and binary values', async () => {
    const cases = [
      {
        id: 'large-logprobs',
        choices: [{ index: 0, delta: { content: 'x' }, logprobs: { values: Array.from({ length: 4_097 }).fill(1) } }],
      },
      {
        id: 'large-usage',
        usage: { details: { values: Array.from({ length: 4_097 }).fill(1) } },
        choices: [{ index: 0, delta: { content: 'x' } }],
      },
      {
        id: new Uint8Array(200_000),
        choices: [{ index: 0, delta: { content: 'x' } }],
      },
    ]

    for (const chunk of cases) {
      const create = vi.fn(async () => (async function* () {
        yield chunk
      })())
      const wrapped = asTestClient(createStreamingOpenAIClient({ chat: { completions: { create } } }))
      await expect(wrapped.chat.completions.create({ model: 'test' })).rejects.toThrow(/limit|more than/)
    }
  })

  it('rejects excessive nesting and prototype-pollution keys in streamed values', async () => {
    let nested: Record<string, unknown> = { value: 'leaf' }
    for (let index = 0; index < 34; index++)
      nested = { nested }

    const dangerous = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>
    for (const value of [nested, dangerous]) {
      const create = vi.fn(async () => (async function* () {
        yield { id: 'unsafe', choices: [{ index: 0, delta: { metadata: value } }] }
      })())
      const wrapped = asTestClient(createStreamingOpenAIClient({ chat: { completions: { create } } }))
      await expect(wrapped.chat.completions.create({ model: 'test' })).rejects.toThrow(/nesting|forbidden object key/)
    }
  })

  it('clones bounded JSON primitives and binary values without retaining their backing buffers', async () => {
    const sourceBuffer = new Uint8Array([1, 2, 3])
    const sourceArrayBuffer = new Uint8Array([4, 5]).buffer
    const create = vi.fn(async () => (async function* () {
      yield {
        id: 'bounded-values',
        choices: [{
          index: 0,
          delta: {
            metadata: {
              yes: true,
              no: false,
              empty: null,
              notFinite: Number.NaN,
              missing: undefined,
              emptyList: [],
              list: [1, 'x', null],
              buffer: sourceBuffer,
              arrayBuffer: sourceArrayBuffer,
            },
            ignored: null,
          },
          finish_reason: false,
        }],
      }
    })())
    const wrapped = asTestClient(createStreamingOpenAIClient({ chat: { completions: { create } } }))

    const result = await wrapped.chat.completions.create({ model: 'test' }) as {
      choices: Array<{ message: { metadata: Record<string, unknown> } }>
    }
    const metadata = result.choices[0]!.message.metadata
    expect(metadata).toMatchObject({
      yes: true,
      no: false,
      empty: null,
      emptyList: [],
      list: [1, 'x', null],
    })
    expect(metadata.buffer).toEqual(new Uint8Array([1, 2, 3]))
    expect(metadata.buffer).not.toBe(sourceBuffer)
    expect(metadata.arrayBuffer).toEqual(new Uint8Array([4, 5]).buffer)
    expect(metadata.arrayBuffer).not.toBe(sourceArrayBuffer)
  })

  it('ignores a proxy key that is not an own field when stream metadata is cloned', async () => {
    let inheritedDescriptorReads = 0
    const metadata = new Proxy({ safe: true }, {
      ownKeys: target => [...Reflect.ownKeys(target), 'inheritedLike'],
      getOwnPropertyDescriptor: (target, property) => {
        if (property !== 'inheritedLike')
          return Reflect.getOwnPropertyDescriptor(target, property)
        inheritedDescriptorReads++
        return inheritedDescriptorReads === 1
          ? { configurable: true, enumerable: true, value: 'must-not-copy', writable: true }
          : undefined
      },
    })
    const create = vi.fn(async () => (async function* () {
      yield {
        id: 'prototype-pollution',
        choices: [{ index: 0, delta: { metadata }, finish_reason: 'stop' }],
      }
    })())
    const wrapped = asTestClient(createStreamingOpenAIClient({ chat: { completions: { create } } }))

    const result = await wrapped.chat.completions.create({ model: 'test' }) as {
      choices: Array<{ message: { metadata: Record<string, unknown> } }>
    }
    expect(result.choices[0]!.message.metadata).toEqual({ safe: true })
    expect(Object.hasOwn(result.choices[0]!.message.metadata, 'inheritedLike')).toBe(false)
  })

  it('enforces cumulative array-item and object-field budgets across chunks', async () => {
    const arrayClient = asTestClient(createStreamingOpenAIClient({
      chat: {
        completions: {
          create: vi.fn(async () => (async function* () {
            for (let index = 0; index < 5; index++) {
              yield {
                id: 'array-budget',
                choices: [{
                  index: 0,
                  delta: { metadata: Array.from({ length: 4_096 }) },
                }],
              }
            }
          })()),
        },
      },
    }))
    await expect(arrayClient.chat.completions.create({ model: 'test' }))
      .rejects
      .toThrow('16384-array-item limit')

    const objectClient = asTestClient(createStreamingOpenAIClient({
      chat: {
        completions: {
          create: vi.fn(async () => (async function* () {
            for (let chunk = 0; chunk < 17; chunk++) {
              yield {
                id: 'object-budget',
                choices: [{
                  index: 0,
                  delta: {
                    metadata: Object.fromEntries(
                      Array.from({ length: 1_024 }, (_, index) => [`field${index}`, undefined]),
                    ),
                  },
                }],
              }
            }
          })()),
        },
      },
    }))
    await expect(objectClient.chat.completions.create({ model: 'test' }))
      .rejects
      .toThrow('16384-object-field limit')
  })

  it('enforces the cumulative node budget across many small chunks', async () => {
    const create = vi.fn(async () => (async function* () {
      for (let index = 0; index < 9_000; index++) {
        yield {
          id: 'node-budget',
          choices: [{ index: 0, delta: { content: '' } }],
        }
      }
    })())
    const wrapped = asTestClient(createStreamingOpenAIClient({ chat: { completions: { create } } }))

    await expect(wrapped.chat.completions.create({ model: 'test' }))
      .rejects
      .toThrow('8192-node limit')
  })

  it.each([
    ['circular value', () => {
      const value: Record<string, unknown> = {}
      value.self = value
      return value
    }, /circular value/],
    ['symbol value', () => ({ value: Symbol('unsafe') }), /non-JSON symbol/],
    ['non-JSON object', () => ({ value: new Date(0) }), /non-JSON object/],
    ['accessor property', () => Object.defineProperty({}, 'value', { enumerable: true, get: () => 1 }), /accessor property/],
    ['oversized array', () => ({ value: Array.from({ length: 4_097 }).fill(null) }), /more than 4096 items/],
    ['oversized object', () => Object.fromEntries(Array.from({ length: 1_025 }, (_, index) => [`field${index}`, null])), /more than 1024 fields/],
    ['oversized binary', () => ({ value: new ArrayBuffer(1024 * 1024 + 1) }), /binary limit/],
  ])('rejects a streamed %s', async (_name, createValue, expected) => {
    const create = vi.fn(async () => (async function* () {
      yield { id: 'invalid-value', choices: [{ index: 0, delta: { metadata: createValue() } }] }
    })())
    const wrapped = asTestClient(createStreamingOpenAIClient({ chat: { completions: { create } } }))

    await expect(wrapped.chat.completions.create({ model: 'test' })).rejects.toThrow(expected)
  })

  it('rejects choice indices that could grow aggregation without bound', async () => {
    const create = vi.fn(async () => (async function* () {
      yield {
        id: 'unsafe-choice-index',
        choices: [{ index: 1_000_000_000, delta: { content: 'x' } }],
      }
    })())
    const wrapped = asTestClient(createStreamingOpenAIClient({ chat: { completions: { create } } }))

    await expect(wrapped.chat.completions.create({ model: 'test' }))
      .rejects
      .toThrow('Invalid streaming choice index')
  })

  it('cancels aggregation even when the upstream iterator ignores the signal', async () => {
    const next = vi.fn(() => new Promise<IteratorResult<unknown>>(() => {}))
    const close = vi.fn(async () => ({ done: true, value: undefined }))
    const stream = {
      [Symbol.asyncIterator]: () => ({ next, return: close }),
    }
    const create = vi.fn(async () => stream)
    const controller = new AbortController()
    const reason = new Error('task timeout')
    const wrapped = asTestClient(createStreamingOpenAIClient({
      chat: { completions: { create } },
    }, controller.signal))

    const pending = wrapped.chat.completions.create({ model: 'test' })
    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce())
    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
    expect(close).toHaveBeenCalledOnce()
  })

  it('aggregates multiple choices, refusal text, logprobs, and response metadata', async () => {
    const create = vi.fn(async () => (async function* () {
      yield null
      yield {
        id: 'multi',
        model: 'served-model',
        system_fingerprint: 'fp-1',
        service_tier: 'priority',
        choices: [
          { index: 1, delta: { role: 'assistant', content: 'second' } },
          { index: 0, delta: { role: 'assistant', refusal: 'cannot ' } },
        ],
      }
      yield {
        choices: [
          { index: 0, delta: { refusal: 'comply' }, finish_reason: 'content_filter', logprobs: { token: 1 } },
          { index: 1, delta: { content: ' choice' }, finish_reason: 'stop' },
        ],
      }
    })())
    const wrapped = asTestClient(createStreamingOpenAIClient({ chat: { completions: { create } } }))

    const result = await wrapped.chat.completions.create({ model: 'requested' }) as Record<string, unknown>
    expect(result).toMatchObject({
      id: 'multi',
      model: 'served-model',
      system_fingerprint: 'fp-1',
      service_tier: 'priority',
      choices: [
        {
          index: 1,
          message: { role: 'assistant', content: 'second choice' },
          finish_reason: 'stop',
        },
        {
          index: 0,
          message: { role: 'assistant', refusal: 'cannot comply' },
          finish_reason: 'content_filter',
          logprobs: { token: 1 },
        },
      ],
    })
  })

  it('adds a standalone user JSON instruction when no user message exists', async () => {
    const create = vi.fn(async () => (async function* () {
      yield { id: 'json', choices: [{ delta: { content: '{}' }, finish_reason: 'stop' }] }
    })())
    const wrapped = asTestClient(createStreamingOpenAIClient({ chat: { completions: { create } } }))

    await wrapped.chat.completions.create({
      model: 'test',
      messages: [{ role: 'system', content: 'follow schema' }],
      response_format: { type: 'json_object' },
    })

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      messages: [
        { role: 'system', content: 'follow schema' },
        { role: 'user', content: 'Return the response as a valid JSON object.' },
      ],
    }), { stream: true })
  })

  it('does not duplicate an existing textual JSON instruction or mutate the request', async () => {
    const create = vi.fn(async () => (async function* () {
      yield { id: 'json', choices: [{ delta: { content: '{}' }, finish_reason: 'stop' }] }
    })())
    const wrapped = asTestClient(createStreamingOpenAIClient({ chat: { completions: { create } } }))
    const request = {
      model: 'test',
      messages: [{ role: 'user', content: 'Return JSON please' }],
      response_format: { type: 'json_object' },
      stream: false,
    }

    await wrapped.chat.completions.create(request)

    expect(request.messages).toEqual([{ role: 'user', content: 'Return JSON please' }])
    expect(request.stream).toBe(false)
    expect(create).toHaveBeenCalledWith({ ...request, stream: true }, { stream: true })
  })

  it('preserves non-create client properties through the proxy', () => {
    const list = vi.fn()
    const client = {
      marker: 'client',
      chat: {
        marker: 'chat',
        completions: { marker: 'completions', create: vi.fn(), list },
      },
    }
    const wrapped = createStreamingOpenAIClient(client) as typeof client

    expect(wrapped.marker).toBe('client')
    expect(wrapped.chat.marker).toBe('chat')
    expect(wrapped.chat.completions.marker).toBe('completions')
    expect(wrapped.chat.completions.list).toBe(list)
  })

  it('tolerates malformed optional stream fields and fills response defaults', async () => {
    const create = vi.fn(async () => (async function* () {
      yield { choices: 'not-an-array' }
      yield {
        choices: [
          null,
          {
            delta: {
              content: '',
              refusal: 42,
              tool_calls: 'not-an-array',
            },
          },
          {
            index: 1,
            delta: {
              tool_calls: [
                null,
                { function: { name: 'act', arguments: '{"x":1}' } },
              ],
            },
            finish_reason: 'stop',
          },
        ],
      }
    })())
    const wrapped = asTestClient(createStreamingOpenAIClient({ chat: { completions: { create } } }))

    const result = await wrapped.chat.completions.create({
      model: 'fallback-model',
      messages: [{ role: 'user', content: { unexpected: true } }],
      response_format: { type: 'json_object' },
    }) as Record<string, unknown>

    expect(result).toMatchObject({
      id: expect.stringMatching(/^chatcmpl-aggregated-/),
      created: expect.any(Number),
      model: 'fallback-model',
      choices: expect.arrayContaining([
        expect.objectContaining({ index: 0 }),
        expect.objectContaining({
          index: 1,
          message: expect.objectContaining({
            tool_calls: [expect.objectContaining({
              function: { name: 'act', arguments: '{"x":1}' },
            })],
          }),
        }),
      ]),
    })
  })

  it('rejects chunks containing too many choices or tool calls', async () => {
    const tooManyChoices = asTestClient(createStreamingOpenAIClient({
      chat: {
        completions: {
          create: vi.fn(async () => (async function* () {
            yield { id: 'many-choices', choices: Array.from({ length: 17 }).fill(null) }
          })()),
        },
      },
    }))
    await expect(tooManyChoices.chat.completions.create({ model: 'test' }))
      .rejects
      .toThrow('16-choice limit')

    const tooManyTools = asTestClient(createStreamingOpenAIClient({
      chat: {
        completions: {
          create: vi.fn(async () => (async function* () {
            yield {
              id: 'many-tools',
              choices: [{
                index: 0,
                delta: { tool_calls: Array.from({ length: 129 }).fill(null) },
              }],
            }
          })()),
        },
      },
    }))
    await expect(tooManyTools.chat.completions.create({ model: 'test' }))
      .rejects
      .toThrow('128-tool-call limit')
  })

  it('bounds empty stream chunks and handles iterators without a return method', async () => {
    let chunks = 0
    const stream = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false, value: chunks++ === 0 ? { id: 'empty-chunks' } : {} }),
      }),
    }
    const wrapped = asTestClient(createStreamingOpenAIClient({
      chat: { completions: { create: vi.fn(async () => stream) } },
    }))

    await expect(wrapped.chat.completions.create({ model: 'test' }))
      .rejects
      .toThrow('100000-chunk limit')
    expect(chunks).toBe(100_001)
  })

  it('uses a safe cancellation error when a signal has no reason', async () => {
    let abortListener: (() => void) | undefined
    const signal = {
      reason: undefined,
      throwIfAborted: vi.fn(),
      addEventListener: vi.fn((_event: string, listener: () => void) => {
        abortListener = listener
      }),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal
    const stream = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<unknown>>(() => {}),
      }),
    }
    const wrapped = asTestClient(createStreamingOpenAIClient({
      chat: { completions: { create: vi.fn(async () => stream) } },
    }, signal))

    const pending = wrapped.chat.completions.create({ model: 'test' })
    await vi.waitFor(() => expect(signal.addEventListener).toHaveBeenCalledOnce())
    abortListener?.()

    await expect(pending).rejects.toThrow('Streaming chat completion was cancelled')
  })
})
