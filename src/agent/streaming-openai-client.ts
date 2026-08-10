import { Buffer } from 'node:buffer'

type UnknownRecord = Record<string, unknown>

interface ChatCompletionsLike {
  create: (...args: unknown[]) => Promise<unknown>
}

interface OpenAIClientLike {
  chat: {
    completions: ChatCompletionsLike
  }
}

interface ClientWrapOptions {
  signal: AbortSignal
  forceStreaming: boolean
}

interface AggregatedChoice {
  index: number
  message: UnknownRecord
  finishReason: unknown
  logprobs: unknown
}

interface StreamBudget {
  remainingTextChars: number
  remainingSerializedBytes: number
  remainingBinaryBytes: number
  remainingNodes: number
  remainingArrayItems: number
  remainingObjectFields: number
}

const MAX_STREAM_TEXT_CHARS = 1024 * 1024
const MAX_STREAM_SERIALIZED_BYTES = 2 * 1024 * 1024
const MAX_STREAM_BINARY_BYTES = 1024 * 1024
const MAX_STREAM_NODES = 8_192
const MAX_STREAM_ARRAY_ITEMS = 16_384
const MAX_STREAM_OBJECT_FIELDS = 16_384
const MAX_STREAM_CONTAINER_ITEMS = 4_096
const MAX_STREAM_CONTAINER_FIELDS = 1_024
const MAX_STREAM_DEPTH = 32
const MAX_STREAM_TOOL_CALLS = 128
const MAX_STREAM_CHOICES = 16
const MAX_STREAM_CHUNKS = 100_000
const DANGEROUS_STREAM_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertOpenAIClient(value: unknown): asserts value is OpenAIClientLike {
  if (
    !isRecord(value)
    || !isRecord(value.chat)
    || !isRecord(value.chat.completions)
    || typeof value.chat.completions.create !== 'function'
  ) {
    throw new TypeError('Expected an OpenAI-compatible client with chat.completions.create()')
  }
}

function consumeSerializedBytes(budget: StreamBudget, bytes: number): void {
  if (bytes > budget.remainingSerializedBytes)
    throw new Error(`Streaming chat completion exceeded the ${MAX_STREAM_SERIALIZED_BYTES}-byte JSON limit`)
  budget.remainingSerializedBytes -= bytes
}

function consumeNode(budget: StreamBudget): void {
  if (budget.remainingNodes <= 0)
    throw new Error(`Streaming chat completion exceeded the ${MAX_STREAM_NODES}-node limit`)
  budget.remainingNodes--
}

function consumeText(budget: StreamBudget, value: string): void {
  if (value.length > budget.remainingTextChars)
    throw new Error(`Streaming chat completion exceeded the ${MAX_STREAM_TEXT_CHARS}-character text limit`)
  budget.remainingTextChars -= value.length
}

function consumeString(budget: StreamBudget, value: string): void {
  consumeNode(budget)
  consumeText(budget, value)
  consumeSerializedBytes(budget, Buffer.byteLength(JSON.stringify(value), 'utf8'))
}

function consumeArrayItem(budget: StreamBudget): void {
  if (budget.remainingArrayItems <= 0)
    throw new Error(`Streaming chat completion exceeded the ${MAX_STREAM_ARRAY_ITEMS}-array-item limit`)
  budget.remainingArrayItems--
}

function consumeObjectField(budget: StreamBudget, key: string): void {
  if (DANGEROUS_STREAM_KEYS.has(key))
    throw new Error(`Streaming chat completion contains a forbidden object key: ${key}`)
  if (budget.remainingObjectFields <= 0)
    throw new Error(`Streaming chat completion exceeded the ${MAX_STREAM_OBJECT_FIELDS}-object-field limit`)
  budget.remainingObjectFields--
  consumeSerializedBytes(budget, Buffer.byteLength(JSON.stringify(key), 'utf8') + 1)
}

function cloneStreamValue(
  value: unknown,
  budget: StreamBudget,
  depth = 0,
  ancestors = new Set<object>(),
): unknown {
  if (depth > MAX_STREAM_DEPTH)
    throw new Error(`Streaming chat completion exceeded the ${MAX_STREAM_DEPTH}-level nesting limit`)

  if (typeof value === 'string') {
    consumeString(budget, value)
    return value
  }
  if (value === null) {
    consumeNode(budget)
    consumeSerializedBytes(budget, 4)
    return null
  }
  if (typeof value === 'boolean') {
    consumeNode(budget)
    consumeSerializedBytes(budget, value ? 4 : 5)
    return value
  }
  if (typeof value === 'number') {
    consumeNode(budget)
    // JSON.stringify always returns a string for a number, including NaN and
    // infinities (which become "null").
    const serialized = JSON.stringify(value) as string
    consumeSerializedBytes(budget, Buffer.byteLength(serialized, 'utf8'))
    return value
  }
  if (value === undefined)
    return undefined
  if (typeof value !== 'object')
    throw new TypeError(`Streaming chat completion contains a non-JSON ${typeof value} value`)

  if (ancestors.has(value))
    throw new TypeError('Streaming chat completion contains a circular value')

  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const byteLength = value instanceof ArrayBuffer ? value.byteLength : value.byteLength
    consumeNode(budget)
    if (byteLength > budget.remainingBinaryBytes)
      throw new Error(`Streaming chat completion exceeded the ${MAX_STREAM_BINARY_BYTES}-byte binary limit`)
    budget.remainingBinaryBytes -= byteLength
    // Typed-array JSON uses decimal property names and values. This conservative
    // bound prevents a small binary view from expanding past the response cap.
    consumeSerializedBytes(budget, Math.max(2, byteLength * 16 + 2))
    if (value instanceof ArrayBuffer)
      return value.slice(0)
    return Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value))
    throw new TypeError('Streaming chat completion contains a non-JSON object')

  consumeNode(budget)
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_STREAM_CONTAINER_ITEMS)
        throw new Error(`Streaming chat completion contains an array with more than ${MAX_STREAM_CONTAINER_ITEMS} items`)
      consumeSerializedBytes(budget, 2 + Math.max(0, value.length - 1))
      const cloned: unknown[] = []
      for (const item of value) {
        consumeArrayItem(budget)
        cloned.push(cloneStreamValue(item, budget, depth + 1, ancestors))
      }
      return cloned
    }

    const cloned: UnknownRecord = {}
    let fieldCount = 0
    for (const key in value as UnknownRecord) {
      if (!Object.hasOwn(value, key))
        continue
      if (++fieldCount > MAX_STREAM_CONTAINER_FIELDS) {
        throw new Error(
          `Streaming chat completion contains an object with more than ${MAX_STREAM_CONTAINER_FIELDS} fields`,
        )
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor))
        throw new TypeError('Streaming chat completion contains an accessor property')
      consumeObjectField(budget, key)
      cloned[key] = cloneStreamValue(descriptor.value, budget, depth + 1, ancestors)
    }
    consumeSerializedBytes(budget, 2 + Math.max(0, fieldCount - 1))
    return cloned
  }
  finally {
    ancestors.delete(value)
  }
}

function appendString(target: UnknownRecord, key: string, value: unknown, budget: StreamBudget): void {
  if (typeof value !== 'string') {
    if (value !== undefined)
      cloneStreamValue(value, budget)
    return
  }
  consumeString(budget, value)
  if (value.length === 0)
    return
  target[key] = `${typeof target[key] === 'string' ? target[key] : ''}${value}`
}

function mergeToolCalls(target: UnknownRecord, value: unknown, budget: StreamBudget): void {
  if (!Array.isArray(value)) {
    if (value !== undefined)
      cloneStreamValue(value, budget)
    return
  }
  if (value.length > MAX_STREAM_TOOL_CALLS)
    throw new Error(`Streaming chat completion exceeded the ${MAX_STREAM_TOOL_CALLS}-tool-call limit`)

  const toolCalls = Array.isArray(target.tool_calls)
    ? target.tool_calls as UnknownRecord[]
    : []

  for (const item of value) {
    consumeArrayItem(budget)
    if (!isRecord(item)) {
      cloneStreamValue(item, budget)
      continue
    }

    const rawIndex = item.index === undefined ? toolCalls.length : item.index
    if (!Number.isSafeInteger(rawIndex) || (rawIndex as number) < 0 || (rawIndex as number) >= MAX_STREAM_TOOL_CALLS)
      throw new Error(`Invalid streaming tool call index: ${String(rawIndex)}`)
    const index = rawIndex as number
    const current = isRecord(toolCalls[index]) ? toolCalls[index] : {}
    const safeItem = cloneStreamValue(item, budget) as UnknownRecord
    const next: UnknownRecord = { ...current, ...safeItem }

    if (isRecord(safeItem.function)) {
      const currentFunction = isRecord(current.function) ? current.function : {}
      const nextFunction = { ...currentFunction, ...safeItem.function }
      if (typeof safeItem.function.arguments === 'string') {
        nextFunction.arguments = `${
          typeof currentFunction.arguments === 'string' ? currentFunction.arguments : ''
        }${safeItem.function.arguments}`
      }
      next.function = nextFunction
    }

    toolCalls[index] = next
  }

  target.tool_calls = toolCalls
}

async function nextWithAbort(
  iterator: AsyncIterator<unknown>,
  signal?: AbortSignal,
): Promise<IteratorResult<unknown>> {
  if (!signal)
    return iterator.next()

  signal.throwIfAborted()
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('Streaming chat completion was cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([iterator.next(), aborted])
  }
  finally {
    if (onAbort)
      signal.removeEventListener('abort', onAbort)
  }
}

function closeIterator(iterator: AsyncIterator<unknown>): void {
  if (typeof iterator.return !== 'function')
    return
  // A non-cooperative upstream may also ignore iterator.return(). Do not let
  // stream cleanup defeat prompt task cancellation, but always observe a late
  // rejection so it cannot become an unhandled promise.
  void Promise.resolve(iterator.return()).catch(() => {})
}

function mergeDelta(target: UnknownRecord, delta: UnknownRecord, budget: StreamBudget): void {
  for (const [key, value] of Object.entries(delta)) {
    consumeObjectField(budget, key)
    if (key === 'tool_calls') {
      mergeToolCalls(target, value, budget)
    }
    else if (key === 'content' || key === 'reasoning_content' || key === 'refusal') {
      appendString(target, key, value, budget)
    }
    else if (value !== undefined && value !== null) {
      target[key] = cloneStreamValue(value, budget)
    }
    else if (value === null) {
      cloneStreamValue(value, budget)
    }
  }
}

function userContentContainsJson(value: unknown): boolean {
  if (typeof value === 'string')
    return /json/i.test(value)

  if (!Array.isArray(value))
    return false

  return value.some((part) => {
    if (!isRecord(part) || part.type !== 'text')
      return false
    return typeof part.text === 'string' && /json/i.test(part.text)
  })
}

function ensureJsonInstruction(request: UnknownRecord): UnknownRecord {
  if (
    !isRecord(request.response_format)
    || request.response_format.type !== 'json_object'
    || !Array.isArray(request.messages)
  ) {
    return request
  }

  const containsJson = request.messages.some(message =>
    isRecord(message)
    && message.role === 'user'
    && userContentContainsJson(message.content),
  )
  if (containsJson)
    return request

  const messages = [...request.messages]
  let userMessageIndex = -1
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (isRecord(message) && message.role === 'user') {
      userMessageIndex = index
      break
    }
  }

  const jsonInstruction = 'Return the response as a valid JSON object.'
  if (userMessageIndex >= 0 && isRecord(messages[userMessageIndex])) {
    const userMessage = messages[userMessageIndex]
    if (typeof userMessage.content === 'string') {
      messages[userMessageIndex] = {
        ...userMessage,
        content: `${userMessage.content}\n\n${jsonInstruction}`,
      }
    }
    else if (Array.isArray(userMessage.content)) {
      messages[userMessageIndex] = {
        ...userMessage,
        content: [...userMessage.content, { type: 'text', text: jsonInstruction }],
      }
    }
  }
  else {
    messages.push({ role: 'user', content: jsonInstruction })
  }

  return {
    ...request,
    messages,
  }
}

async function aggregateChatCompletionStream(
  stream: unknown,
  request: UnknownRecord,
  signal?: AbortSignal,
): Promise<UnknownRecord> {
  if (
    stream === null
    || typeof stream !== 'object'
    || !(Symbol.asyncIterator in stream)
  ) {
    throw new TypeError('OpenAI-compatible endpoint did not return an async chat completion stream')
  }

  const choices = new Map<number, AggregatedChoice>()
  const budget: StreamBudget = {
    remainingTextChars: MAX_STREAM_TEXT_CHARS,
    remainingSerializedBytes: MAX_STREAM_SERIALIZED_BYTES,
    remainingBinaryBytes: MAX_STREAM_BINARY_BYTES,
    remainingNodes: MAX_STREAM_NODES,
    remainingArrayItems: MAX_STREAM_ARRAY_ITEMS,
    remainingObjectFields: MAX_STREAM_OBJECT_FIELDS,
  }
  let responseMetadata: UnknownRecord | undefined
  let usage: unknown
  let chunkCount = 0
  const iterator = (stream as AsyncIterable<unknown>)[Symbol.asyncIterator]()

  try {
    while (true) {
      const next = await nextWithAbort(iterator, signal)
      if (next.done)
        break
      if (++chunkCount > MAX_STREAM_CHUNKS)
        throw new Error(`Streaming chat completion exceeded the ${MAX_STREAM_CHUNKS}-chunk limit`)
      const rawChunk = next.value
      if (!isRecord(rawChunk))
        continue

      if (!responseMetadata) {
        responseMetadata = {}
        for (const key of ['id', 'created', 'model', 'system_fingerprint', 'service_tier']) {
          if (rawChunk[key] === undefined)
            continue
          consumeObjectField(budget, key)
          responseMetadata[key] = cloneStreamValue(rawChunk[key], budget)
        }
      }
      if (rawChunk.usage !== undefined && rawChunk.usage !== null) {
        consumeObjectField(budget, 'usage')
        usage = cloneStreamValue(rawChunk.usage, budget)
      }

      if (!Array.isArray(rawChunk.choices))
        continue
      if (rawChunk.choices.length > MAX_STREAM_CHOICES)
        throw new Error(`Streaming chat completion exceeded the ${MAX_STREAM_CHOICES}-choice limit`)

      for (const rawChoice of rawChunk.choices) {
        if (!isRecord(rawChoice))
          continue

        const rawIndex = rawChoice.index === undefined ? 0 : rawChoice.index
        if (!Number.isSafeInteger(rawIndex) || (rawIndex as number) < 0 || (rawIndex as number) >= MAX_STREAM_CHOICES)
          throw new Error(`Invalid streaming choice index: ${String(rawIndex)}`)
        const index = rawIndex as number
        const choice = choices.get(index) ?? {
          index,
          message: { role: 'assistant', content: '' },
          finishReason: null,
          logprobs: null,
        }

        if (isRecord(rawChoice.delta))
          mergeDelta(choice.message, rawChoice.delta, budget)
        if (rawChoice.finish_reason !== undefined && rawChoice.finish_reason !== null) {
          consumeObjectField(budget, 'finish_reason')
          choice.finishReason = cloneStreamValue(rawChoice.finish_reason, budget)
        }
        if (rawChoice.logprobs !== undefined) {
          consumeObjectField(budget, 'logprobs')
          choice.logprobs = cloneStreamValue(rawChoice.logprobs, budget)
        }
        choices.set(index, choice)
      }
    }
  }
  catch (error) {
    closeIterator(iterator)
    throw error
  }

  if (!responseMetadata)
    throw new Error('Streaming chat completion ended without response chunks')
  if (choices.size === 0)
    throw new Error('Streaming chat completion ended without choices')

  const response: UnknownRecord = {
    id: responseMetadata.id ?? `chatcmpl-aggregated-${Date.now()}`,
    object: 'chat.completion',
    created: responseMetadata.created ?? Math.floor(Date.now() / 1000),
    model: responseMetadata.model ?? request.model,
    choices: Array.from(choices.values(), choice => ({
      index: choice.index,
      message: choice.message,
      finish_reason: choice.finishReason,
      logprobs: choice.logprobs,
    })),
  }

  if (usage !== undefined)
    response.usage = usage
  if (responseMetadata.system_fingerprint !== undefined)
    response.system_fingerprint = responseMetadata.system_fingerprint
  if (responseMetadata.service_tier !== undefined)
    response.service_tier = responseMetadata.service_tier

  return response
}

/**
 * Wrap an OpenAI-compatible client so non-streaming Chat Completions calls are
 * sent upstream with stream=true and aggregated back into a normal completion.
 * Existing streaming calls are passed through unchanged.
 */
function wrapOpenAIClient(client: unknown, wrapOptions: Partial<ClientWrapOptions>): unknown {
  assertOpenAIClient(client)

  const originalCompletions = client.chat.completions
  const originalCreate = originalCompletions.create.bind(originalCompletions)
  const completions = new Proxy(originalCompletions, {
    get(target, property, receiver) {
      if (property !== 'create')
        return Reflect.get(target, property, receiver)

      return async (request: unknown, requestOptions?: unknown): Promise<unknown> => {
        if (!isRecord(request))
          throw new TypeError('Expected a Chat Completions request object')

        const compatibleRequest = wrapOptions.forceStreaming
          ? ensureJsonInstruction(request)
          : request
        const options = isRecord(requestOptions) ? requestOptions : {}
        const abortOptions = wrapOptions.signal
          ? { ...options, signal: wrapOptions.signal }
          : requestOptions
        if (!wrapOptions.forceStreaming || compatibleRequest.stream === true)
          return originalCreate(compatibleRequest, abortOptions)

        const stream = await originalCreate(
          { ...compatibleRequest, stream: true },
          { ...options, ...(wrapOptions.signal ? { signal: wrapOptions.signal } : {}), stream: true },
        )
        return aggregateChatCompletionStream(stream, compatibleRequest, wrapOptions.signal)
      }
    },
  })

  const chat = new Proxy(client.chat, {
    get(target, property, receiver) {
      return property === 'completions'
        ? completions
        : Reflect.get(target, property, receiver)
    },
  })

  return new Proxy(client, {
    get(target, property, receiver) {
      return property === 'chat' ? chat : Reflect.get(target, property, receiver)
    },
  })
}

export function createStreamingOpenAIClient(client: unknown, signal?: AbortSignal): unknown {
  return wrapOpenAIClient(client, { forceStreaming: true, signal })
}

/**
 * Inject the owning task's cancellation signal without changing the requested
 * response mode. Midscene creates clients lazily for each model call, so this
 * is the narrowest available hook for cancelling both regular and streaming
 * OpenAI-compatible requests.
 */
export function createAbortableOpenAIClient(client: unknown, signal: AbortSignal): unknown {
  return wrapOpenAIClient(client, { forceStreaming: false, signal })
}
