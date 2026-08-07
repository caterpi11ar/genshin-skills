import { describe, expect, it, vi } from 'vitest'
import { createStreamingOpenAIClient } from './streaming-openai-client.js'

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
            tool_calls: [{ index: 0, id: 'call-1', function: { name: 'act', arguments: '{"x":' } }],
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
    const wrapped = asTestClient(createStreamingOpenAIClient({
      chat: { completions: { create } },
    }))

    const result = await wrapped.chat.completions.create(
      { model: 'gpt-5.6-terra', messages: [], stream: false },
      { signal: 'test-signal' },
    )

    expect(create).toHaveBeenCalledWith(
      { model: 'gpt-5.6-terra', messages: [], stream: true },
      { signal: 'test-signal', stream: true },
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
})
