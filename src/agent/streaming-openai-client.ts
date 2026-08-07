type UnknownRecord = Record<string, unknown>

interface ChatCompletionsLike {
  create: (...args: unknown[]) => Promise<unknown>
}

interface OpenAIClientLike {
  chat: {
    completions: ChatCompletionsLike
  }
}

interface AggregatedChoice {
  index: number
  message: UnknownRecord
  finishReason: unknown
  logprobs: unknown
}

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

function appendString(target: UnknownRecord, key: string, value: unknown): void {
  if (typeof value !== 'string' || value.length === 0)
    return
  target[key] = `${typeof target[key] === 'string' ? target[key] : ''}${value}`
}

function mergeToolCalls(target: UnknownRecord, value: unknown): void {
  if (!Array.isArray(value))
    return

  const toolCalls = Array.isArray(target.tool_calls)
    ? target.tool_calls as UnknownRecord[]
    : []

  for (const item of value) {
    if (!isRecord(item))
      continue

    const index = typeof item.index === 'number' ? item.index : toolCalls.length
    const current = isRecord(toolCalls[index]) ? toolCalls[index] : {}
    const next: UnknownRecord = { ...current, ...item }

    if (isRecord(item.function)) {
      const currentFunction = isRecord(current.function) ? current.function : {}
      const nextFunction = { ...currentFunction, ...item.function }
      if (typeof item.function.arguments === 'string') {
        nextFunction.arguments = `${
          typeof currentFunction.arguments === 'string' ? currentFunction.arguments : ''
        }${item.function.arguments}`
      }
      next.function = nextFunction
    }

    toolCalls[index] = next
  }

  target.tool_calls = toolCalls
}

function mergeDelta(target: UnknownRecord, delta: UnknownRecord): void {
  for (const [key, value] of Object.entries(delta)) {
    if (key === 'tool_calls') {
      mergeToolCalls(target, value)
    }
    else if (key === 'content' || key === 'reasoning_content' || key === 'refusal') {
      appendString(target, key, value)
    }
    else if (value !== undefined && value !== null) {
      target[key] = value
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
): Promise<UnknownRecord> {
  if (
    stream === null
    || typeof stream !== 'object'
    || !(Symbol.asyncIterator in stream)
  ) {
    throw new TypeError('OpenAI-compatible endpoint did not return an async chat completion stream')
  }

  const choices = new Map<number, AggregatedChoice>()
  let responseMetadata: UnknownRecord | undefined
  let usage: unknown

  for await (const rawChunk of stream as AsyncIterable<unknown>) {
    if (!isRecord(rawChunk))
      continue

    responseMetadata ??= rawChunk
    if (rawChunk.usage !== undefined && rawChunk.usage !== null)
      usage = rawChunk.usage

    if (!Array.isArray(rawChunk.choices))
      continue

    for (const rawChoice of rawChunk.choices) {
      if (!isRecord(rawChoice))
        continue

      const index = typeof rawChoice.index === 'number' ? rawChoice.index : 0
      const choice = choices.get(index) ?? {
        index,
        message: { role: 'assistant', content: '' },
        finishReason: null,
        logprobs: null,
      }

      if (isRecord(rawChoice.delta))
        mergeDelta(choice.message, rawChoice.delta)
      if (rawChoice.finish_reason !== undefined && rawChoice.finish_reason !== null)
        choice.finishReason = rawChoice.finish_reason
      if (rawChoice.logprobs !== undefined)
        choice.logprobs = rawChoice.logprobs
      choices.set(index, choice)
    }
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
export function createStreamingOpenAIClient(client: unknown): unknown {
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

        const compatibleRequest = ensureJsonInstruction(request)
        if (compatibleRequest.stream === true)
          return originalCreate(compatibleRequest, requestOptions)

        const options = isRecord(requestOptions) ? requestOptions : {}
        const stream = await originalCreate(
          { ...compatibleRequest, stream: true },
          { ...options, stream: true },
        )
        return aggregateChatCompletionStream(stream, compatibleRequest)
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
