import type {
  AgentInfo,
  ActionEnvelope,
  Message,
  ModelSelection,
  RootState,
  SessionConfigSchema,
  StringOrMarkdown,
  SessionState,
  SessionSummary,
  StateAction,
  ToolDefinition,
  URI,
} from '@microsoft/agent-host-protocol';

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: number | string;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcNotification {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: number | string;
  readonly result?: unknown;
  readonly error?: JsonRpcError;
}

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export interface ServerTransport {
  send(message: JsonRpcMessage | string): Promise<void> | void;
  recv(): Promise<JsonRpcMessage | string | null>;
  close(): Promise<void> | void;
}

export interface AgentTurnSink {
  emit(action: StateAction): void;
  fail(error: Error): void;
}

export interface ActiveClientTools {
  readonly clientId: string;
  readonly tools: readonly ToolDefinition[];
}

export interface ActiveClientToolInvocation {
  readonly turnId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly displayName?: string;
  readonly invocationMessage?: StringOrMarkdown;
  readonly toolInput?: string;
  readonly _meta?: Record<string, unknown>;
}

export interface ActiveClientToolSink {
  reportInvocation(invocation: ActiveClientToolInvocation): void;
}

export interface AgentSessionContext {
  readonly sessionUri: URI;
  readonly providerId: string;
  readonly workingDirectory?: URI;
  readonly model?: ModelSelection;
  readonly config?: Record<string, unknown>;
  readonly activeClientId?: string;
  readonly activeClientTools?: ActiveClientTools;
  readonly activeClientToolSink: ActiveClientToolSink;
}

export interface AgentSession {
  sendUserMessage(message: Message, sink: AgentTurnSink, signal: AbortSignal, turnId?: string): Promise<void>;
  setActiveClientTools?(activeClientTools: ActiveClientTools | undefined): Promise<void> | void;
  cancel?(reason?: string): Promise<void> | void;
  dispose?(): Promise<void> | void;
}

export interface AgentProvider {
  readonly agent: AgentInfo;
  resolveSessionConfig?(params: {
    workingDirectory?: URI;
    config?: Record<string, unknown>;
  }): Promise<{ schema: SessionConfigSchema; values: Record<string, unknown> }> |
    { schema: SessionConfigSchema; values: Record<string, unknown> };
  createSession(context: AgentSessionContext): Promise<AgentSession> | AgentSession;
}

export interface StoredSession {
  readonly uri: URI;
  state: SessionState;
  agentSession?: AgentSession;
  abortController?: AbortController;
}

export interface SessionStore {
  getRootState(): RootState;
  listSessions(): SessionSummary[];
  getSession(uri: URI): StoredSession | undefined;
  addSession(session: StoredSession): void;
  removeSession(uri: URI): StoredSession | undefined;
  updateSession(uri: URI, update: (session: StoredSession) => void): StoredSession;
}

export interface AhpServerOptions {
  readonly providers: readonly AgentProvider[];
  readonly store?: SessionStore;
  readonly supportedProtocolVersions?: readonly string[];
  readonly defaultDirectory?: URI;
  readonly resourceRoots?: readonly URI[];
}
