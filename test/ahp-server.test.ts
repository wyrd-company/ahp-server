import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { AhpClient } from '@microsoft/agent-host-protocol/client';
import type { AhpTransport, JsonRpcMessage, TransportFrame } from '@microsoft/agent-host-protocol/client';
import type { AgentInfo, Message, SessionState, StateAction } from '@microsoft/agent-host-protocol';

import { AhpServer, FileSystemSessionStore, createInMemoryTransportPair, createInProcessAhpClientTransport } from '../src/index.js';
import type {
  AgentProvider,
  AgentSession,
  AgentTurnSink,
  ResumableAgentProvider,
  ResumableAgentSessionContext,
} from '../src/index.js';

const runningServers: Array<Promise<void>> = [];

after(async () => {
  await Promise.allSettled(runningServers);
});

test('serves the minimal AHP session flow to the TypeScript client', async () => {
  const provider = createEchoProvider();
  const server = new AhpServer({ providers: [provider] });
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  runningServers.push(server.accept(serverTransport));

  const client = new AhpClient(clientTransport, { requestTimeoutMs: 1_000 });
  client.connect();

  const init = await client.initialize({
    clientId: 'test-client',
    protocolVersions: ['0.3.0'],
    initialSubscriptions: ['ahp-root://'],
  });

  assert.equal(init.protocolVersion, '0.3.0');
  assert.equal(init.snapshots.length, 1);
  assert.deepEqual(init.snapshots[0]?.state, {
    agents: [provider.agent],
    activeSessions: 0,
  });

  const sessionUri = 'ahp-session:/test-session';
  await client.request('createSession', {
    channel: sessionUri,
    provider: 'echo',
    workingDirectory: 'file:///workspaces/example',
  });

  const { result, subscription } = await client.subscribe(sessionUri);
  assert.equal(result.snapshot?.resource, sessionUri);
  const sessionState = result.snapshot?.state as SessionState | undefined;
  assert.equal(sessionState?.summary.provider, 'echo');
  assert.equal(sessionState?.lifecycle, 'ready');

  client.dispatch(sessionUri, {
    type: 'session/turnStarted',
    turnId: 'turn-1',
    message: userMessage('Hello AHP'),
  } as StateAction);

  const events = [
    await subscription.next(),
    await subscription.next(),
    await subscription.next(),
    await subscription.next(),
  ].map(result => {
    assert.equal(result.done, false);
    assert.equal(result.value.type, 'action');
    return result.value.params.action;
  });

  assert.equal(events[0]?.type, 'session/turnStarted');
  assert.equal(events[1]?.type, 'session/responsePart');
  assert.equal(events[2]?.type, 'session/delta');
  assert.equal(events[3]?.type, 'session/turnComplete');

  await client.shutdown();
});

test('creates an in-process client transport for an existing server', async () => {
  const provider = createEchoProvider();
  const server = new AhpServer({ providers: [provider] });
  const inProcess = createInProcessAhpClientTransport(server);

  const client = new AhpClient(inProcess.transport, { requestTimeoutMs: 1_000 });
  client.connect();

  const init = await client.initialize({
    clientId: 'in-process-client',
    protocolVersions: ['0.3.0'],
    initialSubscriptions: ['ahp-root://'],
  });

  assert.deepEqual(init.snapshots[0]?.state, {
    agents: [provider.agent],
    activeSessions: 0,
  });

  await client.shutdown();
  await inProcess.close();
});

test('returns listSessions and fetchTurns results', async () => {
  const server = new AhpServer({ providers: [createEchoProvider()] });
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  runningServers.push(server.accept(serverTransport));

  const client = new AhpClient(clientTransport, { requestTimeoutMs: 1_000 });
  client.connect();
  await client.initialize({ clientId: 'test-client', protocolVersions: ['0.3.0'] });

  const sessionUri = 'ahp-session:/list-session';
  await client.request('createSession', { channel: sessionUri, provider: 'echo' });

  const sessions = await client.request('listSessions', { channel: 'ahp-root://' });
  assert.equal(sessions.items.length, 1);
  assert.equal(sessions.items[0]?.resource, sessionUri);

  const turns = await client.request('fetchTurns', { channel: sessionUri, limit: 20 });
  assert.deepEqual(turns, { turns: [], hasMore: false });

  const { subscription } = await client.subscribe(sessionUri);
  client.dispatch(sessionUri, {
    type: 'session/turnStarted',
    turnId: 'turn-1',
    message: userMessage('Hello history'),
  } as StateAction);
  for (let i = 0; i < 4; i++) {
    await subscription.next();
  }

  const completedTurns = await client.request('fetchTurns', { channel: sessionUri, limit: 20 });
  assert.equal(completedTurns.turns.length, 1);
  assert.equal(completedTurns.turns[0]?.id, 'turn-1');
  assert.equal(completedTurns.turns[0]?.state, 'complete');
  assert.equal(completedTurns.hasMore, false);

  await client.shutdown();
});

test('resumes persisted filesystem sessions during reconnect', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ahp-resume-'));
  const sessionUri = 'ahp-session:/resumable-session';
  const resumedContexts: ResumableAgentSessionContext[] = [];

  try {
    const firstServer = new AhpServer({
      providers: [createResumableEchoProvider('created')],
      store: new FileSystemSessionStore({ directory }),
    });
    const [firstClientTransport, firstServerTransport] = createInMemoryTransportPair();
    runningServers.push(firstServer.accept(firstServerTransport));
    const firstClient = new AhpClient(firstClientTransport, { requestTimeoutMs: 1_000 });
    firstClient.connect();
    await firstClient.initialize({ clientId: 'resume-client', protocolVersions: ['0.3.0'] });
    await firstClient.request('createSession', {
      channel: sessionUri,
      provider: 'resumable-echo',
      workingDirectory: 'file:///workspaces/example',
      model: { id: 'test-model' },
      config: { providerSessionId: 'native-session-1' },
    });
    await firstClient.shutdown();

    const secondServer = new AhpServer({
      providers: [createResumableEchoProvider('resumed', resumedContexts)],
      store: new FileSystemSessionStore({ directory }),
    });
    const [secondClientTransport, secondServerTransport] = createInMemoryTransportPair();
    runningServers.push(secondServer.accept(secondServerTransport));
    const secondClient = new AhpClient(secondClientTransport, { requestTimeoutMs: 1_000 });
    secondClient.connect();

    const reconnect = await secondClient.reconnect({
      clientId: 'resume-client',
      lastSeenServerSeq: 0,
      subscriptions: [sessionUri],
    });
    assert.equal(reconnect.type, 'snapshot');
    assert.equal(resumedContexts.length, 1);
    assert.equal(resumedContexts[0]?.sessionUri, sessionUri);
    assert.equal(resumedContexts[0]?.state.summary.resource, sessionUri);
    assert.equal(resumedContexts[0]?.workingDirectory, 'file:///workspaces/example');
    assert.equal(resumedContexts[0]?.model?.id, 'test-model');
    assert.equal(resumedContexts[0]?.config?.providerSessionId, 'native-session-1');

    const subscription = secondClient.attachSubscription(sessionUri);
    secondClient.dispatch(sessionUri, {
      type: 'session/turnStarted',
      turnId: 'resumed-turn',
      message: userMessage('after restart'),
    } as StateAction);

    const events = [
      await subscription.next(),
      await subscription.next(),
      await subscription.next(),
      await subscription.next(),
    ].map(result => {
      assert.equal(result.done, false);
      assert.equal(result.value.type, 'action');
      return result.value.params.action;
    });

    assert.deepEqual(events.map(action => action.type), [
      'session/turnStarted',
      'session/responsePart',
      'session/delta',
      'session/turnComplete',
    ]);
    assert.equal((events[2] as StateAction & { content: string } | undefined)?.content, 'resumed: after restart');

    await secondClient.shutdown();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('reconnect still returns persisted snapshots when provider resume is unsupported', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ahp-no-resume-'));
  const sessionUri = 'ahp-session:/non-resumable-session';

  try {
    const firstServer = new AhpServer({
      providers: [createEchoProvider()],
      store: new FileSystemSessionStore({ directory }),
    });
    const [firstClientTransport, firstServerTransport] = createInMemoryTransportPair();
    runningServers.push(firstServer.accept(firstServerTransport));
    const firstClient = new AhpClient(firstClientTransport, { requestTimeoutMs: 1_000 });
    firstClient.connect();
    await firstClient.initialize({ clientId: 'resume-client', protocolVersions: ['0.3.0'] });
    await firstClient.request('createSession', { channel: sessionUri, provider: 'echo' });
    await firstClient.shutdown();

    const secondServer = new AhpServer({
      providers: [createEchoProvider()],
      store: new FileSystemSessionStore({ directory }),
    });
    const [secondClientTransport, secondServerTransport] = createInMemoryTransportPair();
    runningServers.push(secondServer.accept(secondServerTransport));
    const secondClient = new AhpClient(secondClientTransport, { requestTimeoutMs: 1_000 });
    secondClient.connect();

    const reconnect = await secondClient.reconnect({
      clientId: 'resume-client',
      lastSeenServerSeq: 0,
      subscriptions: [sessionUri],
    });
    assert.equal(reconnect.type, 'snapshot');
    assert.equal(reconnect.snapshots[0]?.resource, sessionUri);

    const subscription = secondClient.attachSubscription(sessionUri);
    secondClient.dispatch(sessionUri, {
      type: 'session/turnStarted',
      turnId: 'unsupported-resume-turn',
      message: userMessage('after restart'),
    } as StateAction);

    const turnStarted = await subscription.next();
    const error = await subscription.next();
    assert.equal(turnStarted.done, false);
    assert.equal(error.done, false);
    assert.equal(error.value.type, 'action');
    assert.equal(error.value.params.action.type, 'session/error');
    assert.equal(error.value.params.action.error.errorType, 'provider.resumeSession');
    assert.match(error.value.params.action.error.message, /provider does not support session resume: echo/);

    await secondClient.shutdown();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('returns createSession errors when provider startup fails', async () => {
  const server = new AhpServer({ providers: [createFailingProvider()] });
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  runningServers.push(server.accept(serverTransport));

  const client = new AhpClient(clientTransport, { requestTimeoutMs: 1_000 });
  client.connect();
  await client.initialize({ clientId: 'test-client', protocolVersions: ['0.3.0'] });

  const sessionUri = 'ahp-session:/failed-session';
  await assert.rejects(
    () => client.request('createSession', { channel: sessionUri, provider: 'failing' }),
    /provider\.createSession failed: adapter unavailable/,
  );

  const { result } = await client.subscribe(sessionUri);
  const sessionState = result.snapshot?.state as SessionState | undefined;
  assert.equal(sessionState?.lifecycle, 'creationFailed');
  assert.equal(sessionState?.creationError?.message, 'adapter unavailable');

  await client.shutdown();
});

function createEchoProvider(): AgentProvider {
  const agent: AgentInfo = {
    provider: 'echo',
    displayName: 'Echo Agent',
    description: 'Test agent that echoes user messages.',
    models: [
      {
        id: 'echo',
        provider: 'echo',
        name: 'Echo',
      },
    ],
  };

  return {
    agent,
    createSession(): AgentSession {
      return {
        async sendUserMessage(message: Message, sink: AgentTurnSink): Promise<void> {
          const turnId = 'turn-1';
          sink.emit({
            type: 'session/responsePart',
            turnId,
            part: {
              kind: 'markdown',
              id: 'part-1',
              content: '',
            },
          } as StateAction);
          sink.emit({
            type: 'session/delta',
            turnId,
            partId: 'part-1',
            content: `Echo: ${message.text}`,
          } as StateAction);
          sink.emit({
            type: 'session/turnComplete',
            turnId,
          } as StateAction);
        },
      };
    },
  };
}

function createResumableEchoProvider(
  responsePrefix: string,
  resumedContexts: ResumableAgentSessionContext[] = [],
): ResumableAgentProvider {
  const agent: AgentInfo = {
    provider: 'resumable-echo',
    displayName: 'Resumable Echo Agent',
    description: 'Test agent that echoes after resume.',
    models: [{ id: 'test-model', provider: 'resumable-echo', name: 'Test Model' }],
  };

  return {
    agent,
    createSession(): AgentSession {
      return createEchoSession(responsePrefix);
    },
    resumeSession(context): AgentSession {
      resumedContexts.push(context);
      return createEchoSession(responsePrefix);
    },
  };
}

function createEchoSession(responsePrefix: string): AgentSession {
  return {
    async sendUserMessage(message: Message, sink: AgentTurnSink, _signal: AbortSignal, turnId = 'turn'): Promise<void> {
      const partId = `${turnId}:part`;
      sink.emit({
        type: 'session/responsePart',
        turnId,
        part: {
          kind: 'markdown',
          id: partId,
          content: '',
        },
      } as StateAction);
      sink.emit({
        type: 'session/delta',
        turnId,
        partId,
        content: `${responsePrefix}: ${message.text}`,
      } as StateAction);
      sink.emit({
        type: 'session/turnComplete',
        turnId,
      } as StateAction);
    },
  };
}

function createFailingProvider(): AgentProvider {
  return {
    agent: {
      provider: 'failing',
      displayName: 'Failing Agent',
      description: 'Test agent that fails during startup.',
      models: [
        {
          id: 'failing',
          provider: 'failing',
          name: 'Failing',
        },
      ],
    },
    createSession(): AgentSession {
      throw new Error('adapter unavailable');
    },
  };
}

function userMessage(text: string): Message {
  return {
    text,
    origin: { kind: 'user' as Message['origin']['kind'] },
  };
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
