import { fileURLToPath } from 'node:url';

import type {
  AgentInfo,
  ModelSelection,
  StateAction,
  StringOrMarkdown,
  ToolCallResult,
  ToolDefinition,
  URI,
} from '@microsoft/agent-host-protocol';

import type {
  ActiveClientToolInvocation,
  ActiveClientToolSink,
  ActiveClientTools,
  AgentTurnSink,
} from './types.js';

export interface SingleModelAgentInfoOptions {
  readonly providerId: string;
  readonly displayName: string;
  readonly description: string;
  readonly defaultModel: string;
}

export function singleModelAgentInfo(options: SingleModelAgentInfoOptions): AgentInfo {
  return {
    provider: options.providerId,
    displayName: options.displayName,
    description: options.description,
    models: [
      {
        id: options.defaultModel,
        provider: options.providerId,
        name: options.defaultModel,
      },
    ],
  };
}

export function resolveModelId(model: ModelSelection | undefined, fallback: string): string;
export function resolveModelId(model: ModelSelection | undefined, fallback: string | undefined): string | undefined;
export function resolveModelId(model: ModelSelection | undefined, fallback: string | undefined): string | undefined {
  return model?.id ?? fallback;
}

export function uriToPath(uri: URI): string {
  if (!uri.startsWith('file://')) {
    return uri;
  }
  return fileURLToPath(uri);
}

export function markdownPartId(turnId: string): string {
  return `${turnId}:markdown`;
}

export function markdownPart(turnId: string, partId = markdownPartId(turnId)): StateAction {
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

export class MarkdownTurnEmitter {
  private emitted = false;

  constructor(
    private readonly sink: AgentTurnSink,
    readonly turnId: string,
    readonly partId: string = markdownPartId(turnId),
  ) {}

  get partEmitted(): boolean {
    return this.emitted;
  }

  ensurePart(): void {
    if (this.emitted) {
      return;
    }
    this.emitted = true;
    this.sink.emit(markdownPart(this.turnId, this.partId));
  }

  emitDelta(content: string): void {
    if (!content) {
      return;
    }
    this.ensurePart();
    this.sink.emit({
      type: 'session/delta',
      turnId: this.turnId,
      partId: this.partId,
      content,
    } as StateAction);
  }

  complete(): void {
    this.ensurePart();
    this.sink.emit({
      type: 'session/turnComplete',
      turnId: this.turnId,
    } as StateAction);
  }
}

export interface ActiveClientToolRouterOptions {
  readonly activeClientTools?: ActiveClientTools;
  readonly sink: ActiveClientToolSink;
}

export interface ActiveClientToolRouterInvocation extends ActiveClientToolInvocation {
  readonly useRegisteredToolDisplayName?: boolean;
}

export class ActiveClientToolRouter {
  private activeClientTools: ActiveClientTools | undefined;

  constructor(private readonly options: ActiveClientToolRouterOptions) {
    this.activeClientTools = options.activeClientTools;
  }

  setActiveClientTools(activeClientTools: ActiveClientTools | undefined): void {
    this.activeClientTools = activeClientTools;
  }

  get snapshot(): ActiveClientTools | undefined {
    return this.activeClientTools;
  }

  get tools(): readonly ToolDefinition[] | undefined {
    return this.activeClientTools?.tools;
  }

  findTool(toolName: string): ToolDefinition | undefined {
    return this.activeClientTools?.tools.find(candidate => candidate.name === toolName);
  }

  async reportInvocation(invocation: ActiveClientToolRouterInvocation): Promise<ToolCallResult> {
    const tool = this.findTool(invocation.toolName);
    const inferredDisplayName = invocation.useRegisteredToolDisplayName === false
      ? invocation.toolName
      : tool?.title ?? invocation.toolName;

    return this.options.sink.reportInvocation({
      turnId: invocation.turnId,
      toolCallId: invocation.toolCallId,
      toolName: invocation.toolName,
      displayName: invocation.displayName ?? inferredDisplayName,
      invocationMessage: invocation.invocationMessage ?? inferredDisplayName,
      toolInput: invocation.toolInput,
      ...(invocation._meta ? { _meta: invocation._meta } : {}),
    });
  }
}

export function stringOrMarkdown(value: StringOrMarkdown): string {
  return typeof value === 'string' ? value : value.markdown;
}
