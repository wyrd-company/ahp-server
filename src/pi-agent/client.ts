export type PiAgentChatMessage =
  | {
    readonly role: 'system' | 'user';
    readonly content: string;
  }
  | {
    readonly role: 'assistant';
    readonly content: string | null;
    readonly tool_calls?: readonly PiAgentChatToolCall[];
  }
  | {
    readonly role: 'tool';
    readonly tool_call_id: string;
    readonly content: string;
  };

export interface PiAgentChatTool {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters: {
      readonly type: 'object';
      readonly properties?: Record<string, object>;
      readonly required?: string[];
    };
  };
}

export interface PiAgentChatToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

export interface PiAgentStreamCompletionParams {
  readonly model: string;
  readonly messages: readonly PiAgentChatMessage[];
  readonly tools?: readonly PiAgentChatTool[];
  readonly signal?: AbortSignal;
}

export type PiAgentChatStreamEvent =
  | string
  | {
    readonly type: 'text';
    readonly content: string;
  }
  | {
    readonly type: 'toolCall';
    readonly toolCall: PiAgentChatToolCall;
  };

export interface PiAgentChatClient {
  streamChatCompletion(params: PiAgentStreamCompletionParams): AsyncIterable<PiAgentChatStreamEvent>;
}

export interface OpenAICompatiblePiAgentClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetchFn?: typeof fetch;
}

interface ChatCompletionChunk {
  readonly choices?: ReadonlyArray<{
    readonly delta?: {
      readonly content?: string | null;
      readonly tool_calls?: ReadonlyArray<{
        readonly index?: number;
        readonly id?: string;
        readonly type?: 'function';
        readonly function?: {
          readonly name?: string;
          readonly arguments?: string;
        };
      }>;
    };
  }>;
  readonly error?: {
    readonly message?: string;
  };
}

export class OpenAICompatiblePiAgentClient implements PiAgentChatClient {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: OpenAICompatiblePiAgentClientOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async *streamChatCompletion(params: PiAgentStreamCompletionParams): AsyncIterable<PiAgentChatStreamEvent> {
    const response = await this.fetchFn(chatCompletionsUrl(this.options.baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...this.options.headers,
      },
      body: JSON.stringify({
        model: params.model,
        messages: params.messages,
        ...(params.tools ? { tools: params.tools } : {}),
        stream: true,
      }),
      signal: params.signal,
    });

    if (!response.ok) {
      throw new Error(`Pi Agent request failed with ${response.status}: ${await response.text()}`);
    }
    if (!response.body) {
      throw new Error('Pi Agent response did not include a stream body');
    }

    yield* parseServerSentEvents(response.body);
  }
}

async function* parseServerSentEvents(body: ReadableStream<Uint8Array>): AsyncIterable<PiAgentChatStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const toolCalls = new Map<number, MutableToolCall>();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) {
          continue;
        }
        const data = trimmed.slice('data:'.length).trim();
        if (!data || data === '[DONE]') {
          continue;
        }
        const parsed = JSON.parse(data) as ChatCompletionChunk;
        if (parsed.error?.message) {
          throw new Error(parsed.error.message);
        }
        const delta = parsed.choices?.[0]?.delta;
        const content = delta?.content;
        if (content) {
          yield content;
        }
        if (delta?.tool_calls) {
          for (const toolCall of delta.tool_calls) {
            const index = toolCall.index ?? toolCalls.size;
            const current = toolCalls.get(index) ?? {
              id: '',
              name: '',
              arguments: '',
            };
            if (toolCall.id) {
              current.id = toolCall.id;
            }
            if (toolCall.function?.name) {
              current.name = toolCall.function.name;
            }
            if (toolCall.function?.arguments) {
              current.arguments += toolCall.function.arguments;
            }
            toolCalls.set(index, current);
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  for (const [index, toolCall] of toolCalls.entries()) {
    if (!toolCall.name) {
      continue;
    }
    yield {
      type: 'toolCall',
      toolCall: {
        id: toolCall.id || `tool-call-${index}`,
        type: 'function',
        function: {
          name: toolCall.name,
          arguments: toolCall.arguments || '{}',
        },
      },
    };
  }
}

interface MutableToolCall {
  id: string;
  name: string;
  arguments: string;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/g, '');
}

function chatCompletionsUrl(baseUrl: string): string {
  const normalized = trimTrailingSlash(baseUrl);
  return normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`;
}
