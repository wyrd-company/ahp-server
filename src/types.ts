import type {
  RootState,
  SessionState,
  SessionSummary,
  URI,
  JsonRpcErrorResponse,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccessResponse,
} from '@microsoft/agent-host-protocol';
import type {
  AhpTransport,
  JsonRpcMessage,
  TransportFrame,
} from '@microsoft/agent-host-protocol/client';
import type {
  AgentProvider,
  AgentSession,
  ResumableAgentProvider,
} from '@wyrd-company/ahp-provider-kit';

export type {
  ActiveClientToolInvocation,
  ActiveClientToolSink,
  ActiveClientTools,
  AgentProvider,
  AgentSession,
  AgentSessionContext,
  AgentTurnSink,
  ResumableAgentProvider,
  ResumableAgentSessionContext,
} from '@wyrd-company/ahp-provider-kit';
export type {
  AhpTransport,
  JsonRpcErrorResponse,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccessResponse,
  TransportFrame,
};
export type ServerTransport = AhpTransport;

export interface StoredSession {
  readonly uri: URI;
  state: SessionState;
  agentSession?: AgentSession;
  abortController?: AbortController;
  resumePromise?: Promise<void>;
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
