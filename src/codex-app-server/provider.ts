import { fileURLToPath } from 'node:url';

import type {
  AgentInfo,
  Message,
  ModelSelection,
  StringOrMarkdown,
  StateAction,
  ToolCallResult,
  ToolDefinition,
  ToolResultContent,
  URI,
} from '@microsoft/agent-host-protocol';

import type {
  ActiveClientToolSink,
  ActiveClientTools,
  AgentProvider,
  AgentSession,
  AgentSessionContext,
  AgentTurnSink,
} from '../types.js';
import {
  CodexAppServerSocketClient,
  type CodexAppServerClient,
  type CodexJsonRpcNotification,
  type CodexServerRequestEvent,
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

interface DynamicToolSpec {
  readonly namespace?: string | null;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly deferLoading?: boolean;
}

interface DynamicToolCallParams {
  readonly threadId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly namespace?: string | null;
  readonly tool: string;
  readonly arguments?: unknown;
}

interface DynamicToolCallResponse {
  readonly contentItems: DynamicToolCallOutputContentItem[];
  readonly success: boolean;
}

type DynamicToolCallOutputContentItem =
  | { readonly type: 'inputText'; readonly text: string }
  | { readonly type: 'inputImage'; readonly imageUrl: string };

const ACTIVE_CLIENT_TOOL_NAMESPACE = 'ahp_active_client';

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
      const dynamicTools = toDynamicToolSpecs(context.activeClientTools?.tools);
      const start = await client.request<ThreadStartResponse>('thread/start', {
        cwd,
        model,
        approvalPolicy: options.approvalPolicy ?? 'on-request',
        sandbox: options.sandbox ?? 'workspace-write',
        ephemeral: false,
        sessionStartSource: 'startup',
        threadSource: 'user',
        ...(dynamicTools.length ? { dynamicTools } : {}),
      });
      return new CodexAHPAgentSession(
        client,
        start.thread.id,
        model,
        context.activeClientTools,
        context.activeClientToolSink,
      );
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
  private activeClientTools: ActiveClientTools | undefined;

  constructor(
    private readonly client: CodexAppServerClient,
    private readonly threadId: string,
    private readonly model: string,
    activeClientTools: ActiveClientTools | undefined,
    private readonly activeClientToolSink: ActiveClientToolSink,
  ) {
    this.activeClientTools = activeClientTools;
  }

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
    const unsubscribeServerRequests = this.client.onServerRequest(request => {
      if (request.method !== 'item/tool/call') {
        return;
      }
      request.respond(this.handleDynamicToolCall(ahpTurnId, request));
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
      unsubscribeServerRequests();
    }
  }

  setActiveClientTools(activeClientTools: ActiveClientTools | undefined): void {
    this.activeClientTools = activeClientTools;
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

  private async handleDynamicToolCall(ahpTurnId: string, request: CodexServerRequestEvent): Promise<DynamicToolCallResponse> {
    const params = request.params as DynamicToolCallParams;
    if (params.threadId !== this.threadId) {
      throw new Error(`Codex dynamic tool call targeted unexpected thread ${params.threadId}`);
    }
    if (params.namespace && params.namespace !== ACTIVE_CLIENT_TOOL_NAMESPACE) {
      throw new Error(`Codex dynamic tool namespace is not handled by this adapter: ${params.namespace}`);
    }

    const tool = this.activeClientTools?.tools.find(candidate => candidate.name === params.tool);
    if (!tool) {
      return dynamicToolErrorResponse(`Active-client tool is not available: ${params.tool}`);
    }

    try {
      const result = await this.activeClientToolSink.reportInvocation({
        turnId: ahpTurnId,
        toolCallId: params.callId,
        toolName: params.tool,
        displayName: tool.title ?? tool.name,
        invocationMessage: tool.title ?? tool.name,
        toolInput: JSON.stringify(params.arguments ?? {}),
      });
      return toDynamicToolCallResponse(result);
    } catch (error) {
      return dynamicToolErrorResponse(error instanceof Error ? error.message : String(error));
    }
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

function toDynamicToolSpecs(tools: readonly ToolDefinition[] | undefined): DynamicToolSpec[] {
  return tools?.map(tool => ({
    namespace: ACTIVE_CLIENT_TOOL_NAMESPACE,
    name: tool.name,
    description: tool.description ?? tool.title ?? tool.name,
    inputSchema: tool.inputSchema ?? { type: 'object' },
  })) ?? [];
}

function toDynamicToolCallResponse(result: ToolCallResult): DynamicToolCallResponse {
  return {
    success: result.success,
    contentItems: result.content?.flatMap(toDynamicToolContentItem) ?? [{
      type: 'inputText',
      text: toolResultFallbackText(result),
    }],
  };
}

function toDynamicToolContentItem(content: ToolResultContent): DynamicToolCallOutputContentItem[] {
  if (content.type === 'text') {
    return [{ type: 'inputText', text: content.text }];
  }
  if (content.type === 'embeddedResource' && content.contentType.startsWith('image/')) {
    return [{
      type: 'inputImage',
      imageUrl: `data:${content.contentType};base64,${content.data}`,
    }];
  }
  if (content.type === 'resource' && content.contentType?.startsWith('image/')) {
    return [{ type: 'inputImage', imageUrl: content.uri }];
  }
  return [{ type: 'inputText', text: JSON.stringify(content) }];
}

function toolResultFallbackText(result: ToolCallResult): string {
  if (result.structuredContent) {
    return JSON.stringify(result.structuredContent);
  }
  if (result.error?.message) {
    return result.error.message;
  }
  return stringOrMarkdown(result.pastTenseMessage);
}

function dynamicToolErrorResponse(message: string): DynamicToolCallResponse {
  return {
    success: false,
    contentItems: [{ type: 'inputText', text: message }],
  };
}

function stringOrMarkdown(value: StringOrMarkdown): string {
  return typeof value === 'string' ? value : value.markdown;
}
