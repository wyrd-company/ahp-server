import type {
  AgentInfo,
  Message,
  ModelSelection,
  StateAction,
} from '@microsoft/agent-host-protocol';

import type {
  AgentProvider,
  AgentSession,
  AgentSessionContext,
  AgentTurnSink,
} from '../types.js';
import {
  OpenAICompatiblePiAgentClient,
  type OpenAICompatiblePiAgentClientOptions,
  type PiAgentChatClient,
  type PiAgentChatMessage,
} from './client.js';

export interface PiAgentProviderOptions {
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly client?: PiAgentChatClient;
  readonly clientFactory?: () => PiAgentChatClient;
  readonly providerId?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly defaultModel: string;
}

export function createPiAgentProvider(options: PiAgentProviderOptions): AgentProvider {
  const providerId = options.providerId ?? 'pi-agent';
  const agent: AgentInfo = {
    provider: providerId,
    displayName: options.displayName ?? 'Pi Agent',
    description: options.description ?? 'Pi Agent OpenAI-compatible adapter',
    models: [
      {
        id: options.defaultModel,
        provider: providerId,
        name: options.defaultModel,
      },
    ],
  };

  return {
    agent,
    createSession(context: AgentSessionContext): AgentSession {
      const client = options.client ?? options.clientFactory?.() ?? createClient(options);
      return new PiAgentAHPAgentSession(client, modelId(context.model, options.defaultModel));
    },
  };
}

class PiAgentAHPAgentSession implements AgentSession {
  private readonly messages: PiAgentChatMessage[] = [];

  constructor(
    private readonly client: PiAgentChatClient,
    private readonly model: string,
  ) {}

  async sendUserMessage(message: Message, sink: AgentTurnSink, signal: AbortSignal, turnId?: string): Promise<void> {
    const ahpTurnId = turnId ?? `turn-${Date.now()}`;
    const partId = `${ahpTurnId}:markdown`;
    let responseText = '';
    let partEmitted = false;

    this.messages.push({ role: 'user', content: message.text });

    for await (const delta of this.client.streamChatCompletion({
      model: this.model,
      messages: this.messages,
      signal,
    })) {
      if (signal.aborted) {
        return;
      }
      if (!partEmitted) {
        partEmitted = true;
        sink.emit({
          type: 'session/responsePart',
          turnId: ahpTurnId,
          part: {
            kind: 'markdown',
            id: partId,
            content: '',
          },
        } as StateAction);
      }
      responseText += delta;
      sink.emit({
        type: 'session/delta',
        turnId: ahpTurnId,
        partId,
        content: delta,
      } as StateAction);
    }

    if (!partEmitted) {
      sink.emit({
        type: 'session/responsePart',
        turnId: ahpTurnId,
        part: {
          kind: 'markdown',
          id: partId,
          content: '',
        },
      } as StateAction);
    }
    this.messages.push({ role: 'assistant', content: responseText });
    sink.emit({
      type: 'session/turnComplete',
      turnId: ahpTurnId,
    } as StateAction);
  }

  cancel(): void {}
}

function createClient(options: PiAgentProviderOptions): PiAgentChatClient {
  if (!options.baseUrl || !options.apiKey) {
    throw new Error('Pi Agent baseUrl and apiKey are required when no client/clientFactory is provided');
  }
  return new OpenAICompatiblePiAgentClient({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    headers: options.headers,
  } satisfies OpenAICompatiblePiAgentClientOptions);
}

function modelId(model: ModelSelection | undefined, fallback: string): string {
  return model?.id ?? fallback;
}
