import {
  SUPPORTED_PROTOCOL_VERSIONS,
  rootReducer,
  sessionReducer,
  type ActionEnvelope,
  type AgentInfo,
  type CreateSessionParams,
  type DispatchActionParams,
  type FetchTurnsParams,
  type InitializeParams,
  type InitializeResult,
  type ListSessionsResult,
  type Message,
  type ReconnectParams,
  type ReconnectResult,
  type ResourceCopyParams,
  type ResourceDeleteParams,
  type ResourceListParams,
  type ResourceMkdirParams,
  type ResourceMoveParams,
  type ResourceReadParams,
  type ResourceResolveParams,
  type ResourceWriteParams,
  type ResolveSessionConfigParams,
  type ResolveSessionConfigResult,
  type SessionAction,
  type SessionState,
  type SessionSummary,
  type Snapshot,
  type StateAction,
  type SubscribeParams,
  type SubscribeResult,
  type URI,
} from '@microsoft/agent-host-protocol';

import { AhpServerError, JsonRpcErrorCodes, toJsonRpcError } from './errors.js';
import { FileResourceService } from './resources.js';
import { InMemorySessionStore } from './store.js';
import type {
  AgentProvider,
  AgentTurnSink,
  AhpServerOptions,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  ServerTransport,
  SessionStore,
  StoredSession,
} from './types.js';

interface ClientConnection {
  readonly transport: ServerTransport;
  clientId?: string;
  initialized: boolean;
  readonly subscriptions: Set<URI>;
  readonly send: (message: JsonRpcMessage) => Promise<void>;
}

const ROOT_URI = 'ahp-root://';
const ACTION = {
  RootActiveSessionsChanged: 'root/activeSessionsChanged',
  SessionReady: 'session/ready',
  SessionCreationFailed: 'session/creationFailed',
  SessionTurnStarted: 'session/turnStarted',
  SessionPendingMessageSet: 'session/pendingMessageSet',
  SessionTurnCancelled: 'session/turnCancelled',
  SessionError: 'session/error',
  SessionResponsePart: 'session/responsePart',
  SessionTurnComplete: 'session/turnComplete',
} as const;

export class AhpServer {
  private readonly providers = new Map<string, AgentProvider>();
  private readonly store: SessionStore;
  private readonly supportedProtocolVersions: string[];
  private readonly resources: FileResourceService;
  private readonly connections = new Set<ClientConnection>();
  private serverSeq = 0;

  constructor(private readonly options: AhpServerOptions) {
    for (const provider of options.providers) {
      this.providers.set(provider.agent.provider, provider);
    }
    this.store = options.store ?? new InMemorySessionStore(options.providers.map(p => p.agent));
    this.supportedProtocolVersions = [...(options.supportedProtocolVersions ?? SUPPORTED_PROTOCOL_VERSIONS)];
    this.resources = new FileResourceService({
      roots: options.resourceRoots ?? (options.defaultDirectory ? [options.defaultDirectory] : undefined),
    });
  }

  async accept(transport: ServerTransport): Promise<void> {
    const connection: ClientConnection = {
      transport,
      initialized: false,
      subscriptions: new Set(),
      send: async message => {
        await transport.send(message);
      },
    };
    this.connections.add(connection);
    try {
      while (true) {
        const inbound = await transport.recv();
        if (inbound === null) {
          return;
        }
        const message = this.decode(inbound);
        await this.handleMessage(connection, message);
      }
    } finally {
      this.connections.delete(connection);
      await transport.close();
    }
  }

  private decode(message: JsonRpcMessage | string): JsonRpcMessage {
    if (typeof message !== 'string') {
      return message;
    }
    const parsed = JSON.parse(message) as JsonRpcMessage;
    return parsed;
  }

  private async handleMessage(connection: ClientConnection, message: JsonRpcMessage): Promise<void> {
    if (this.isResponse(message)) {
      return;
    }
    if (this.isRequest(message)) {
      await this.handleRequest(connection, message);
      return;
    }
    await this.handleNotification(connection, message);
  }

  private async handleRequest(connection: ClientConnection, request: JsonRpcRequest): Promise<void> {
    try {
      const result = await this.dispatchRequest(connection, request.method, request.params);
      await connection.send({ jsonrpc: '2.0', id: request.id, result });
    } catch (error) {
      await connection.send({ jsonrpc: '2.0', id: request.id, error: toJsonRpcError(error) });
    }
  }

  private async dispatchRequest(connection: ClientConnection, method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.initialize(connection, params as InitializeParams);
      case 'ping':
        return null;
      case 'reconnect':
        return this.reconnect(connection, params as ReconnectParams);
      case 'subscribe':
        return this.subscribe(connection, params as SubscribeParams);
      case 'listSessions':
        return this.listSessions();
      case 'resourceRead':
        return this.resources.read(params as ResourceReadParams);
      case 'resourceWrite':
        return this.resources.write(params as ResourceWriteParams);
      case 'resourceList':
        return this.resources.list(params as ResourceListParams);
      case 'resourceCopy':
        return this.resources.copy(params as ResourceCopyParams);
      case 'resourceDelete':
        return this.resources.delete(params as ResourceDeleteParams);
      case 'resourceMove':
        return this.resources.move(params as ResourceMoveParams);
      case 'resourceResolve':
        return this.resources.resolve(params as ResourceResolveParams);
      case 'resourceMkdir':
        return this.resources.mkdir(params as ResourceMkdirParams);
      case 'resolveSessionConfig':
        return this.resolveSessionConfig(params as ResolveSessionConfigParams);
      case 'createSession':
        return this.createSession(connection, params as CreateSessionParams);
      case 'disposeSession':
        return this.disposeSession(params as { channel: URI });
      case 'fetchTurns':
        return this.fetchTurns(params as FetchTurnsParams);
      case 'completions':
        return { items: [] };
      default:
        throw new AhpServerError(JsonRpcErrorCodes.MethodNotFound, `method not found: ${method}`);
    }
  }

  private async handleNotification(connection: ClientConnection, notification: JsonRpcNotification): Promise<void> {
    switch (notification.method) {
      case 'unsubscribe': {
        const { channel } = notification.params as { channel: URI };
        connection.subscriptions.delete(channel);
        return;
      }
      case 'dispatchAction':
        await this.dispatchAction(connection, notification.params as DispatchActionParams);
        return;
      default:
        return;
    }
  }

  private initialize(connection: ClientConnection, params: InitializeParams): InitializeResult {
    const protocolVersion = params.protocolVersions.find(version =>
      this.supportedProtocolVersions.includes(version),
    );
    if (!protocolVersion) {
      throw new AhpServerError(
        JsonRpcErrorCodes.UnsupportedProtocolVersion,
        `unsupported protocol versions: ${params.protocolVersions.join(', ')}`,
      );
    }

    connection.clientId = params.clientId;
    connection.initialized = true;

    const snapshots = (params.initialSubscriptions ?? []).map(uri => {
      connection.subscriptions.add(uri);
      return this.snapshot(uri);
    });

    return {
      protocolVersion,
      serverSeq: this.serverSeq,
      snapshots,
      ...(this.options.defaultDirectory ? { defaultDirectory: this.options.defaultDirectory } : {}),
    };
  }

  private reconnect(connection: ClientConnection, params: ReconnectParams): ReconnectResult {
    connection.clientId = params.clientId;
    connection.initialized = true;
    connection.subscriptions.clear();
    for (const uri of params.subscriptions) {
      connection.subscriptions.add(uri);
    }
    return {
      type: 'snapshot',
      snapshots: params.subscriptions.map(uri => this.snapshot(uri)),
    } as unknown as ReconnectResult;
  }

  private subscribe(connection: ClientConnection, params: SubscribeParams): SubscribeResult {
    connection.subscriptions.add(params.channel);
    return { snapshot: this.snapshot(params.channel) };
  }

  private listSessions(): ListSessionsResult {
    return { items: this.store.listSessions() };
  }

  private async resolveSessionConfig(params: ResolveSessionConfigParams): Promise<ResolveSessionConfigResult> {
    const provider = params.provider ? this.providers.get(params.provider) : this.firstProvider();
    if (!provider) {
      throw new AhpServerError(JsonRpcErrorCodes.ProviderNotFound, `provider not found: ${params.provider ?? '(default)'}`);
    }
    if (!provider.resolveSessionConfig) {
      return { schema: { type: 'object', properties: {} }, values: params.config ?? {} };
    }
    return provider.resolveSessionConfig({
      workingDirectory: params.workingDirectory,
      config: params.config,
    });
  }

  private async createSession(connection: ClientConnection, params: CreateSessionParams): Promise<null> {
    if (this.store.getSession(params.channel)) {
      throw new AhpServerError(JsonRpcErrorCodes.SessionAlreadyExists, `session already exists: ${params.channel}`);
    }
    const provider = params.provider ? this.providers.get(params.provider) : this.firstProvider();
    if (!provider) {
      throw new AhpServerError(JsonRpcErrorCodes.ProviderNotFound, `provider not found: ${params.provider ?? '(default)'}`);
    }

    const now = Date.now();
    const state: SessionState = {
      summary: {
        resource: params.channel,
        provider: provider.agent.provider,
        title: 'New Session',
        status: 1 as SessionSummary['status'],
        createdAt: now,
        modifiedAt: now,
        ...(params.model ? { model: params.model } : {}),
        ...(params.agent ? { agent: params.agent } : {}),
        ...(params.workingDirectory ? { workingDirectory: params.workingDirectory } : {}),
      },
      lifecycle: 'creating' as SessionState['lifecycle'],
      turns: [],
      ...(params.config ? {
        config: {
          schema: { type: 'object', properties: {} },
          values: params.config,
        },
      } : {}),
      ...(params.activeClient ? { activeClient: params.activeClient } : {}),
    };

    const stored: StoredSession = { uri: params.channel, state };
    this.store.addSession(stored);
    this.publishRootNotification('root/sessionAdded', { channel: ROOT_URI, summary: state.summary });
    this.publishRootAction({ type: ACTION.RootActiveSessionsChanged, activeSessions: this.store.listSessions().length } as StateAction);

    try {
      stored.agentSession = await provider.createSession({
        sessionUri: params.channel,
        providerId: provider.agent.provider,
        workingDirectory: params.workingDirectory,
        model: params.model,
        config: params.config,
        activeClientId: connection.clientId,
      });
      this.applySessionAction(params.channel, { type: ACTION.SessionReady } as StateAction);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.applySessionAction(params.channel, {
        type: ACTION.SessionCreationFailed,
        error: { errorType: 'provider.createSession', message },
      } as StateAction);
      throw new AhpServerError(
        JsonRpcErrorCodes.InternalError,
        `provider.createSession failed: ${message}`,
      );
    }
    return null;
  }

  private async disposeSession(params: { channel: URI }): Promise<null> {
    const session = this.store.removeSession(params.channel);
    if (!session) {
      throw new AhpServerError(JsonRpcErrorCodes.NotFound, `session not found: ${params.channel}`);
    }
    session.abortController?.abort();
    await session.agentSession?.dispose?.();
    this.publishRootNotification('root/sessionRemoved', { channel: ROOT_URI, session: params.channel });
    this.publishRootAction({ type: ACTION.RootActiveSessionsChanged, activeSessions: this.store.listSessions().length } as StateAction);
    return null;
  }

  private fetchTurns(params: FetchTurnsParams): { turns: unknown[]; hasMore: boolean } {
    const session = this.requireSession(params.channel);
    const turns = session.state.turns;
    const limit = params.limit ?? turns.length;
    return { turns: turns.slice(Math.max(0, turns.length - limit)), hasMore: false };
  }

  private async dispatchAction(connection: ClientConnection, params: DispatchActionParams): Promise<void> {
    const origin = connection.clientId
      ? { clientId: connection.clientId, clientSeq: params.clientSeq }
      : undefined;

    if (params.channel === ROOT_URI) {
      this.publishRootAction(params.action, origin);
      return;
    }

    const session = this.requireSession(params.channel);
    this.applySessionAction(params.channel, params.action, origin);

    if (params.action.type === ACTION.SessionTurnStarted) {
      await this.startAgentTurn(session, params.action.turnId, params.action.message);
    } else if (params.action.type === ACTION.SessionPendingMessageSet) {
      await this.startAgentTurn(session, params.action.id, params.action.message);
    } else if (params.action.type === ACTION.SessionTurnCancelled) {
      session.abortController?.abort(params.action.turnId);
      await session.agentSession?.cancel?.(params.action.turnId);
    }
  }

  private async startAgentTurn(session: StoredSession, turnId: string, message: Message): Promise<void> {
    if (!session.agentSession) {
      this.applySessionAction(session.uri, {
        type: ACTION.SessionError,
        turnId,
        error: { errorType: 'session.notReady', message: 'session backend is not ready' },
      } as StateAction);
      return;
    }

    session.abortController?.abort('new turn started');
    const abortController = new AbortController();
    session.abortController = abortController;

    const sink: AgentTurnSink = {
      emit: action => this.applySessionAction(session.uri, action),
      fail: error => {
        this.applySessionAction(session.uri, {
          type: ACTION.SessionError,
          turnId,
          error: { errorType: 'agent.turn', message: error.message },
        } as StateAction);
      },
    };

    try {
      await session.agentSession.sendUserMessage(message, sink, abortController.signal, turnId);
    } catch (error) {
      if (abortController.signal.aborted) {
        return;
      }
      const messageText = error instanceof Error ? error.message : String(error);
      this.applySessionAction(session.uri, {
        type: ACTION.SessionError,
        turnId,
        error: { errorType: 'agent.turn', message: messageText },
      } as StateAction);
    }
  }

  private snapshot(uri: URI): Snapshot {
    if (uri === ROOT_URI) {
      return {
        resource: ROOT_URI,
        state: this.store.getRootState(),
        fromSeq: this.serverSeq,
      };
    }
    const session = this.requireSession(uri);
    return {
      resource: uri,
      state: session.state,
      fromSeq: this.serverSeq,
    };
  }

  private publishRootNotification(method: string, params: unknown): void {
    const notification: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    for (const connection of this.connections) {
      if (connection.subscriptions.has(ROOT_URI)) {
        void connection.send(notification);
      }
    }
  }

  private publishRootAction(action: StateAction, origin?: ActionEnvelope['origin']): void {
    const root = this.store.getRootState();
    const updated = rootReducer(root, action as never);
    if ('setAgents' in this.store && typeof this.store.setAgents === 'function') {
      this.store.setAgents(updated.agents);
    }
    this.publishAction(ROOT_URI, action, origin);
  }

  private applySessionAction(uri: URI, action: StateAction, origin?: ActionEnvelope['origin']): void {
    const session = this.store.updateSession(uri, stored => {
      stored.state = sessionReducer(stored.state, action as SessionAction);
      stored.state.summary.modifiedAt = Date.now();
    });
    this.publishAction(uri, action, origin);
    this.publishRootNotification('root/sessionSummaryChanged', {
      channel: ROOT_URI,
      session: uri,
      changes: session.state.summary,
    });
  }

  private publishAction(channel: URI, action: StateAction, origin?: ActionEnvelope['origin']): void {
    const envelope: ActionEnvelope = {
      channel,
      action,
      serverSeq: ++this.serverSeq,
      origin,
    };
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'action',
      params: envelope,
    };
    for (const connection of this.connections) {
      if (connection.subscriptions.has(channel)) {
        void connection.send(notification);
      }
    }
  }

  private firstProvider(): AgentProvider | undefined {
    return this.providers.values().next().value;
  }

  private requireSession(uri: URI): StoredSession {
    const session = this.store.getSession(uri);
    if (!session) {
      throw new AhpServerError(JsonRpcErrorCodes.NotFound, `session not found: ${uri}`);
    }
    return session;
  }

  private isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
    return 'method' in message && 'id' in message;
  }

  private isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
    return 'id' in message && ('result' in message || 'error' in message) && !('method' in message);
  }
}

export function textMessage(text: string): Message {
  return { text, origin: { kind: 'user' as Message['origin']['kind'] } };
}

export function markdownResponsePart(partId: string): StateAction {
  return {
    type: ACTION.SessionResponsePart,
    turnId: partId.split(':')[0] ?? partId,
    part: {
      kind: 'markdown',
      id: partId,
      content: '',
    },
  } as StateAction;
}

export function completeTurn(turnId: string): StateAction {
  return {
    type: ACTION.SessionTurnComplete,
    turnId,
  } as StateAction;
}
