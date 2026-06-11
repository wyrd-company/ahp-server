import type {
  AgentInfo,
  Message,
  ModelSelection,
  StringOrMarkdown,
  StateAction,
  ToolCallResult,
  ToolDefinition,
  ToolResultContent,
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
      return new PiAgentAHPAgentSession(
        client,
        modelId(context.model, options.defaultModel),
        context.activeClientTools,
        context.activeClientToolSink,
      );
    },
  };
}

class PiAgentAHPAgentSession implements AgentSession {
  private readonly messages: PiAgentChatMessage[] = [];
  private activeClientTools: ActiveClientTools | undefined;

  constructor(
    private readonly client: PiAgentChatClient,
    private readonly model: string,
    activeClientTools: ActiveClientTools | undefined,
    private readonly activeClientToolSink: ActiveClientToolSink,
  ) {
    this.activeClientTools = activeClientTools;
  }

  async sendUserMessage(message: Message, sink: AgentTurnSink, signal: AbortSignal, turnId?: string): Promise<void> {
    const ahpTurnId = turnId ?? `turn-${Date.now()}`;
    const partId = `${ahpTurnId}:markdown`;
    let partEmitted = false;

    this.messages.push({ role: 'user', content: message.text });

    for (let attempt = 0; attempt < 16; attempt++) {
      const response = await this.runCompletionIteration({
        turnId: ahpTurnId,
        partId,
        sink,
        signal,
        partEmitted,
      });
      partEmitted = response.partEmitted;
      if (signal.aborted) {
        return;
      }
      if (response.toolCalls.length === 0) {
        if (!partEmitted) {
          sink.emit(markdownPart(ahpTurnId, partId));
        }
        this.messages.push({ role: 'assistant', content: response.responseText });
        sink.emit({
          type: 'session/turnComplete',
          turnId: ahpTurnId,
        } as StateAction);
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
    this.activeClientTools = activeClientTools;
  }

  cancel(): void {}

  private async runCompletionIteration(params: {
    readonly turnId: string;
    readonly partId: string;
    readonly sink: AgentTurnSink;
    readonly signal: AbortSignal;
    readonly partEmitted: boolean;
  }): Promise<{ responseText: string; toolCalls: PiAgentChatToolCall[]; partEmitted: boolean }> {
    let responseText = '';
    let partEmitted = params.partEmitted;
    const toolCalls: PiAgentChatToolCall[] = [];

    for await (const event of this.client.streamChatCompletion({
      model: this.model,
      messages: this.messages,
      tools: openAiTools(this.activeClientTools?.tools),
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
      if (!partEmitted) {
        partEmitted = true;
        params.sink.emit(markdownPart(params.turnId, params.partId));
      }
      responseText += delta;
      params.sink.emit({
        type: 'session/delta',
        turnId: params.turnId,
        partId: params.partId,
        content: delta,
      } as StateAction);
    }

    return { responseText, toolCalls, partEmitted };
  }

  private async invokeActiveClientTool(turnId: string, toolCall: PiAgentChatToolCall): Promise<ToolCallResult> {
    const toolName = toolCall.function.name;
    const tool = this.activeClientTools?.tools.find(candidate => candidate.name === toolName);
    return this.activeClientToolSink.reportInvocation({
      turnId,
      toolCallId: toolCall.id,
      toolName,
      displayName: tool?.title ?? toolName,
      invocationMessage: tool?.title ?? toolName,
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

function modelId(model: ModelSelection | undefined, fallback: string): string {
  return model?.id ?? fallback;
}

function markdownPart(turnId: string, partId: string): StateAction {
  return {
    type: 'session/responsePart',
    turnId,
    part: {
      kind: 'markdown',
      id: partId,
      content: '',
    },
  } as StateAction;
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
