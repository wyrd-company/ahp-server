import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { AhpClient } from '@microsoft/agent-host-protocol/client';
import type { AhpTransport, JsonRpcMessage, TransportFrame } from '@microsoft/agent-host-protocol/client';
import type { AgentInfo, Message, StateAction, ToolDefinition } from '@microsoft/agent-host-protocol';

import {
  AhpServer,
  createInMemoryTransportPair,
  type ActiveClientToolSink,
  type ActiveClientTools,
  type AgentProvider,
  type AgentSession,
  type AgentSessionContext,
  type AgentTurnSink,
} from '../src/index.js';

const runningServers: Array<Promise<void>> = [];

after(async () => {
  await Promise.allSettled(runningServers);
});

test('forwards active-client tools to providers with trusted session context', async () => {
  const provider = new FakeActiveToolProvider();
  const server = new AhpServer({ providers: [provider] });
  const owner = createClient(server);
  const other = createClient(server);

  owner.client.connect();
  other.client.connect();
  await owner.client.initialize({ clientId: 'owner-client', protocolVersions: ['0.3.0'] });
  await other.client.initialize({ clientId: 'other-client', protocolVersions: ['0.3.0'] });

  const firstTool = toolDefinition('openFile', 'Open File');
  const secondTool = toolDefinition('searchWorkspace', 'Search Workspace');
  const sessionUri = 'ahp-session:/active-client-tools';

  await owner.client.request('createSession', {
    channel: sessionUri,
    provider: 'fake-active-tools',
    activeClient: {
      clientId: 'owner-client',
      displayName: 'Owner Client',
      tools: [firstTool],
    },
  });

  const session = provider.sessions[0];
  assert.ok(session);
  assert.equal(session.context.activeClientTools?.clientId, 'owner-client');
  assert.deepEqual(session.context.activeClientTools?.tools.map(tool => tool.name), ['openFile']);
  assert.deepEqual(session.activeClientTools?.tools.map(tool => tool.name), ['openFile']);

  owner.client.dispatch(sessionUri, {
    type: 'session/activeClientToolsChanged',
    tools: [secondTool],
  } as StateAction);
  await waitFor(() => session.activeClientTools?.tools[0]?.name === 'searchWorkspace');

  owner.client.dispatch(sessionUri, {
    type: 'session/activeClientChanged',
    activeClient: null,
  } as StateAction);
  await waitFor(() => session.activeClientTools === undefined);

  owner.client.dispatch(sessionUri, {
    type: 'session/activeClientChanged',
    activeClient: {
      clientId: 'owner-client',
      displayName: 'Owner Client',
      tools: [secondTool],
    },
  } as StateAction);
  await waitFor(() => session.activeClientTools?.tools[0]?.name === 'searchWorkspace');

  const { subscription } = await owner.client.subscribe(sessionUri);
  owner.client.dispatch(sessionUri, {
    type: 'session/turnStarted',
    turnId: 'turn-1',
    message: userMessage('use the client tool'),
  } as StateAction);

  const turnStarted = await nextAction(subscription);
  assert.equal(turnStarted.action.type, 'session/turnStarted');

  session.invokeTool({
    turnId: 'turn-1',
    toolCallId: 'tool-call-1',
    toolName: 'searchWorkspace',
    toolInput: JSON.stringify({
      sessionUri: 'ahp-session:/forged',
      turnId: 'forged-turn',
      toolCallId: 'forged-call',
      query: 'real input',
    }),
  });

  const toolStart = await nextAction(subscription);
  assert.equal(toolStart.action.type, 'session/toolCallStart');
  assert.equal(toolStart.action.turnId, 'turn-1');
  assert.equal(toolStart.action.toolCallId, 'tool-call-1');
  assert.equal(toolStart.action.toolName, 'searchWorkspace');
  assert.deepEqual(toolStart.action.contributor, {
    kind: 'client',
    clientId: 'owner-client',
  });

  const toolReady = await nextAction(subscription);
  assert.equal(toolReady.action.type, 'session/toolCallReady');
  assert.equal(toolReady.action.turnId, 'turn-1');
  assert.equal(toolReady.action.toolCallId, 'tool-call-1');
  assert.match(String(toolReady.action.toolInput), /forged-turn/);

  other.client.dispatch(sessionUri, {
    type: 'session/toolCallComplete',
    turnId: 'turn-1',
    toolCallId: 'tool-call-1',
    result: {
      success: true,
      pastTenseMessage: 'Wrong client completed the tool',
    },
  } as StateAction);

  owner.client.dispatch(sessionUri, {
    type: 'session/toolCallComplete',
    turnId: 'turn-1',
    toolCallId: 'tool-call-1',
    result: {
      success: true,
      pastTenseMessage: 'Searched workspace',
    },
  } as StateAction);

  const completion = await nextAction(subscription);
  assert.equal(completion.origin?.clientId, 'owner-client');
  assert.equal(completion.action.type, 'session/toolCallComplete');
  assert.equal(completion.action.result.pastTenseMessage, 'Searched workspace');

  await owner.client.shutdown();
  await waitFor(() => session.activeClientTools === undefined);
  await other.client.shutdown();
});

class FakeActiveToolProvider implements AgentProvider {
  readonly agent: AgentInfo = {
    provider: 'fake-active-tools',
    displayName: 'Fake Active Tools',
    description: 'Fake provider used to validate active-client tool plumbing.',
    models: [{ id: 'fake-active-tools', provider: 'fake-active-tools', name: 'Fake Active Tools' }],
  };

  readonly sessions: FakeActiveToolSession[] = [];

  createSession(context: AgentSessionContext): AgentSession {
    const session = new FakeActiveToolSession(context);
    this.sessions.push(session);
    return session;
  }
}

class FakeActiveToolSession implements AgentSession {
  activeClientTools: ActiveClientTools | undefined;
  readonly sink: ActiveClientToolSink;

  constructor(readonly context: AgentSessionContext) {
    this.activeClientTools = context.activeClientTools;
    this.sink = context.activeClientToolSink;
  }

  async sendUserMessage(_message: Message, _sink: AgentTurnSink): Promise<void> {}

  setActiveClientTools(activeClientTools: ActiveClientTools | undefined): void {
    this.activeClientTools = activeClientTools;
  }

  invokeTool(invocation: Parameters<ActiveClientToolSink['reportInvocation']>[0]): void {
    this.sink.reportInvocation(invocation);
  }
}

function createClient(server: AhpServer): { client: AhpClient } {
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  runningServers.push(server.accept(serverTransport));
  const client = new AhpClient(asAhpTransport(clientTransport), { requestTimeoutMs: 1_000 });
  return { client };
}

function toolDefinition(name: string, title: string): ToolDefinition {
  return {
    name,
    title,
    description: `${title} test tool`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
    },
  };
}

function userMessage(text: string): Message {
  return {
    text,
    origin: { kind: 'user' as Message['origin']['kind'] },
  };
}

async function nextAction(subscription: AsyncIterator<unknown>): Promise<{ action: StateAction; origin?: { clientId?: string } }> {
  const next = await subscription.next();
  assert.equal(next.done, false);
  const value = next.value as { type?: string; params?: { action?: StateAction; origin?: { clientId?: string } } };
  assert.equal(value.type, 'action');
  assert.ok(value.params?.action);
  return {
    action: value.params.action,
    origin: value.params.origin,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true);
}

function asAhpTransport(transport: {
  send(message: unknown): Promise<void> | void;
  recv(): Promise<unknown>;
  close(): Promise<void> | void;
}): AhpTransport {
  return {
    send(message: JsonRpcMessage | string): Promise<void> | void {
      return transport.send(message);
    },
    async recv(): Promise<TransportFrame | null> {
      const message = await transport.recv();
      if (message === null) {
        return null;
      }
      if (typeof message === 'string') {
        return { kind: 'text', text: message };
      }
      return { kind: 'parsed', message: message as never };
    },
    close(): Promise<void> | void {
      return transport.close();
    },
  };
}
