import { fileURLToPath } from 'node:url';

import type {
  AgentInfo,
  Message,
  ModelSelection,
  StateAction,
  URI,
} from '@microsoft/agent-host-protocol';

import type {
  AgentProvider,
  AgentSession,
  AgentSessionContext,
  AgentTurnSink,
} from '../types.js';
import {
  CodexAppServerSocketClient,
  type CodexAppServerClient,
  type CodexJsonRpcNotification,
} from './rpc-client.js';

export interface CodexAppServerProviderOptions {
  readonly socketPath?: string;
  readonly webSocketUrl?: string;
  readonly client?: CodexAppServerClient;
  readonly clientFactory?: () => CodexAppServerClient;
  readonly providerId?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly defaultModel?: string;
  readonly approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
  readonly sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
}

interface ThreadStartResponse {
  readonly thread: { readonly id: string };
}

interface TurnStartResponse {
  readonly turn: { readonly id: string };
}

export function createCodexAppServerProvider(options: CodexAppServerProviderOptions): AgentProvider {
  const providerId = options.providerId ?? 'codex';
  const defaultModel = options.defaultModel ?? 'codex';
  const agent: AgentInfo = {
    provider: providerId,
    displayName: options.displayName ?? 'Codex',
    description: options.description ?? 'Codex App Server adapter',
    models: [
      {
        id: defaultModel,
        provider: providerId,
        name: defaultModel,
      },
    ],
  };

  return {
    agent,
    async createSession(context: AgentSessionContext): Promise<AgentSession> {
      const client = options.client ?? options.clientFactory?.() ?? createSocketClient(options);
      await client.connect();
      const cwd = context.workingDirectory ? uriToPath(context.workingDirectory) : process.cwd();
      const model = modelId(context.model, defaultModel);
      const start = await client.request<ThreadStartResponse>('thread/start', {
        cwd,
        model,
        approvalPolicy: options.approvalPolicy ?? 'on-request',
        sandbox: options.sandbox ?? 'workspace-write',
        ephemeral: false,
        sessionStartSource: 'startup',
        threadSource: 'user',
      });
      return new CodexAHPAgentSession(client, start.thread.id, model);
    },
  };
}

function createSocketClient(options: CodexAppServerProviderOptions): CodexAppServerClient {
  if (!options.socketPath) {
    if (!options.webSocketUrl) {
      throw new Error('Codex App Server socketPath or webSocketUrl is required when no client/clientFactory is provided');
    }
  }
  return new CodexAppServerSocketClient({
    socketPath: options.socketPath,
    webSocketUrl: options.webSocketUrl,
  });
}

class CodexAHPAgentSession implements AgentSession {
  constructor(
    private readonly client: CodexAppServerClient,
    private readonly threadId: string,
    private readonly model: string,
  ) {}

  async sendUserMessage(message: Message, sink: AgentTurnSink, signal: AbortSignal, turnId?: string): Promise<void> {
    const ahpTurnId = turnId ?? `turn-${Date.now()}`;
    let codexTurnId: string | undefined;
    let markdownPartEmitted = false;
    let complete: (() => void) | undefined;
    let fail: ((error: Error) => void) | undefined;

    const done = new Promise<void>((resolve, reject) => {
      complete = resolve;
      fail = reject;
    });

    const unsubscribe = this.client.onNotification(notification => {
      try {
        if (signal.aborted) {
          return;
        }
        if (!isThreadNotification(notification, this.threadId)) {
          return;
        }
        if (notification.method === 'turn/started') {
          const params = notification.params as { turn?: { id?: string } };
          codexTurnId = params.turn?.id ?? codexTurnId;
          return;
        }
        if (notification.method === 'item/agentMessage/delta') {
          const params = notification.params as { delta?: string; turnId?: string };
          codexTurnId = params.turnId ?? codexTurnId;
          if (!markdownPartEmitted) {
            markdownPartEmitted = true;
            sink.emit(markdownPart(ahpTurnId));
          }
          sink.emit({
            type: 'session/delta',
            turnId: ahpTurnId,
            partId: markdownPartId(ahpTurnId),
            content: params.delta ?? '',
          } as StateAction);
          return;
        }
        if (notification.method === 'turn/completed') {
          const params = notification.params as { turn?: { id?: string } };
          codexTurnId = params.turn?.id ?? codexTurnId;
          sink.emit({
            type: 'session/turnComplete',
            turnId: ahpTurnId,
          } as StateAction);
          complete?.();
          return;
        }
        if (notification.method === 'error') {
          const params = notification.params as { message?: string } | undefined;
          fail?.(new Error(params?.message ?? `Codex App Server reported an error: ${JSON.stringify(notification.params)}`));
        }
      } catch (error) {
        fail?.(error instanceof Error ? error : new Error(String(error)));
      }
    });

    try {
      const response = await this.client.request<TurnStartResponse>('turn/start', {
        threadId: this.threadId,
        input: [{ type: 'text', text: message.text, text_elements: [] }],
        model: this.model,
      });
      codexTurnId = response.turn.id;
      if (signal.aborted) {
        await this.cancel(codexTurnId);
        return;
      }
      await done;
    } finally {
      unsubscribe();
    }
  }

  async cancel(reason?: string): Promise<void> {
    await this.client.request('turn/interrupt', {
      threadId: this.threadId,
      turnId: reason,
    });
  }

  async dispose(): Promise<void> {
    await this.client.close();
  }
}

function markdownPart(turnId: string): StateAction {
  return {
    type: 'session/responsePart',
    turnId,
    part: {
      kind: 'markdown',
      id: markdownPartId(turnId),
      content: '',
    },
  } as StateAction;
}

function markdownPartId(turnId: string): string {
  return `${turnId}:markdown`;
}

function isThreadNotification(notification: CodexJsonRpcNotification, threadId: string): boolean {
  const params = notification.params as { threadId?: string } | undefined;
  return params?.threadId === undefined || params.threadId === threadId;
}

function modelId(model: ModelSelection | undefined, fallback: string): string {
  return model?.id ?? fallback;
}

function uriToPath(uri: URI): string {
  if (!uri.startsWith('file://')) {
    return uri;
  }
  return fileURLToPath(uri);
}
