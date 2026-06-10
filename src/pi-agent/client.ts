export interface PiAgentChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface PiAgentStreamCompletionParams {
  readonly model: string;
  readonly messages: readonly PiAgentChatMessage[];
  readonly signal?: AbortSignal;
}

export interface PiAgentChatClient {
  streamChatCompletion(params: PiAgentStreamCompletionParams): AsyncIterable<string>;
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

  async *streamChatCompletion(params: PiAgentStreamCompletionParams): AsyncIterable<string> {
    const response = await this.fetchFn(`${trimTrailingSlash(this.options.baseUrl)}/chat/completions`, {
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

async function* parseServerSentEvents(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
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
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) {
          yield content;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/g, '');
}
