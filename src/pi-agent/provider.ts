import type {
  AgentInfo,
  Message,
  StringOrMarkdown,
  StateAction,
  ToolCallResult,
  ToolDefinition,
  ToolResultContent,
} from '@microsoft/agent-host-protocol';

import type {
  ActiveClientTools,
  AgentProvider,
  AgentSession,
  AgentSessionContext,
  AgentTurnSink,
} from '../types.js';
import {
  ActiveClientToolRouter,
  MarkdownTurnEmitter,
  resolveModelId,
  singleModelAgentInfo,
} from '../provider-kit.js';
import {
  OpenAICompatiblePiAgentClient,
  type OpenAICompatiblePiAgentClientOptions,
  type PiAgentChatClient,
  type PiAgentChatMessage,
  type PiAgentChatStreamEvent,
  type PiAgentChatTool,
  type PiAgentChatToolCall,
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
  const agent: AgentInfo = singleModelAgentInfo({
    providerId,
    displayName: options.displayName ?? 'Pi Agent',
    description: options.description ?? 'Pi Agent OpenAI-compatible adapter',
    defaultModel: options.defaultModel,
  });

  return {
    agent,
    createSession(context: AgentSessionContext): AgentSession {
      const client = options.client ?? options.clientFactory?.() ?? createClient(options);
      return new PiAgentAHPAgentSession(
        client,
        resolveModelId(context.model, options.defaultModel),
        context.activeClientTools,
        context.activeClientToolSink,
      );
    },
  };
}

class PiAgentAHPAgentSession implements AgentSession {
  private readonly messages: PiAgentChatMessage[] = [];
  private readonly activeClientTools: ActiveClientToolRouter;

  constructor(
    private readonly client: PiAgentChatClient,
    private readonly model: string,
    activeClientTools: ActiveClientTools | undefined,
    activeClientToolSink: AgentSessionContext['activeClientToolSink'],
  ) {
    this.activeClientTools = new ActiveClientToolRouter({
      activeClientTools,
      sink: activeClientToolSink,
    });
  }

  async sendUserMessage(message: Message, sink: AgentTurnSink, signal: AbortSignal, turnId?: string): Promise<void> {
    const ahpTurnId = turnId ?? `turn-${Date.now()}`;
    const markdown = new MarkdownTurnEmitter(sink, ahpTurnId);

    this.messages.push({ role: 'user', content: message.text });

    for (let attempt = 0; attempt < 16; attempt++) {
      const response = await this.runCompletionIteration({
        markdown,
        signal,
      });
      if (signal.aborted) {
        return;
      }
      if (response.toolCalls.length === 0) {
        this.messages.push({ role: 'assistant', content: response.responseText });
        markdown.complete();
        return;
      }

      this.messages.push({
        role: 'assistant',
        content: response.responseText || null,
        tool_calls: response.toolCalls,
      });
      for (const toolCall of response.toolCalls) {
        const toolResult = await this.invokeActiveClientTool(ahpTurnId, toolCall);
        this.messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toolResultContent(toolResult),
        });
      }
    }

    sink.emit({
      type: 'session/error',
      turnId: ahpTurnId,
      error: { errorType: 'pi-agent.toolLoop', message: 'Pi Agent exceeded active-client tool iteration limit' },
    } as StateAction);
  }

  setActiveClientTools(activeClientTools: ActiveClientTools | undefined): void {
    this.activeClientTools.setActiveClientTools(activeClientTools);
  }

  cancel(): void {}

  private async runCompletionIteration(params: {
    readonly markdown: MarkdownTurnEmitter;
    readonly signal: AbortSignal;
  }): Promise<{ responseText: string; toolCalls: PiAgentChatToolCall[] }> {
    let responseText = '';
    const toolCalls: PiAgentChatToolCall[] = [];

    for await (const event of this.client.streamChatCompletion({
      model: this.model,
      messages: this.messages,
      tools: openAiTools(this.activeClientTools.tools),
      signal: params.signal,
    })) {
      if (params.signal.aborted) {
        break;
      }
      if (isToolCallEvent(event)) {
        toolCalls.push(event.toolCall);
        continue;
      }
      const delta = typeof event === 'string' ? event : event.content;
      if (!delta) {
        continue;
      }
      responseText += delta;
      params.markdown.emitDelta(delta);
    }

    return { responseText, toolCalls };
  }

  private async invokeActiveClientTool(turnId: string, toolCall: PiAgentChatToolCall): Promise<ToolCallResult> {
    const toolName = toolCall.function.name;
    return this.activeClientTools.reportInvocation({
      turnId,
      toolCallId: toolCall.id,
      toolName,
      toolInput: toolCall.function.arguments || '{}',
    });
  }
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

function openAiTools(tools: readonly ToolDefinition[] | undefined): readonly PiAgentChatTool[] | undefined {
  if (!tools?.length) {
    return undefined;
  }
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.inputSchema ?? { type: 'object' },
    },
  }));
}

function toolResultContent(result: ToolCallResult): string {
  if (result.content?.length) {
    return result.content.map(toolResultContentPart).join('\n');
  }
  if (result.structuredContent) {
    return JSON.stringify(result.structuredContent);
  }
  if (result.error?.message) {
    return result.error.message;
  }
  return stringOrMarkdown(result.pastTenseMessage);
}

function toolResultContentPart(content: ToolResultContent): string {
  if (content.type === 'text') {
    return content.text;
  }
  return JSON.stringify(content);
}

function stringOrMarkdown(value: StringOrMarkdown): string {
  return typeof value === 'string' ? value : value.markdown;
}

function isToolCallEvent(event: PiAgentChatStreamEvent): event is Extract<PiAgentChatStreamEvent, { type: 'toolCall' }> {
  return typeof event !== 'string' && event.type === 'toolCall';
}
