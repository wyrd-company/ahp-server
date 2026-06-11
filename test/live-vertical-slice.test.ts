import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AhpClient } from '@microsoft/agent-host-protocol/client';
import { connect } from '@nats-io/transport-node';
import type { Message, StateAction } from '@microsoft/agent-host-protocol';

import {
  AhpServer,
  NatsAhpClientTransport,
  NatsServerTransport,
  ahpNatsSubjects,
  createCodexAppServerProvider,
} from '../src/index.js';

test('streams a live CAS turn through AHP over a live NATS broker', {
  skip: process.env.NATS_URL && (process.env.CODEX_APP_SERVER_URL || process.env.CODEX_APP_SERVER_SOCKET)
    ? false
    : 'set NATS_URL and CODEX_APP_SERVER_URL or CODEX_APP_SERVER_SOCKET to run live vertical-slice validation',
  timeout: 120_000,
}, async () => {
  assert.ok(process.env.NATS_URL);

  const serverConnection = await connect({ servers: process.env.NATS_URL, timeout: 2_000 });
  const clientConnection = await connect({ servers: process.env.NATS_URL, timeout: 2_000 });
  const subjects = ahpNatsSubjects({
    namespace: `ahp.live.slice.${Date.now()}`,
    serverId: 'server',
    clientId: 'client',
  });

  const server = new AhpServer({
    providers: [
      createCodexAppServerProvider({
        webSocketUrl: process.env.CODEX_APP_SERVER_URL,
        socketPath: process.env.CODEX_APP_SERVER_SOCKET,
        defaultModel: process.env.CODEX_E2E_MODEL ?? 'gpt-5.5',
      }),
    ],
  });
  const serverTransport = new NatsServerTransport({
    connection: serverConnection,
    inboundSubject: subjects.clientToServer,
    outboundSubject: subjects.serverToClient,
  });
  await serverTransport.ready();
  const serverRun = server.accept(serverTransport);

  const clientTransport = new NatsAhpClientTransport({
    connection: clientConnection,
    inboundSubject: subjects.serverToClient,
    outboundSubject: subjects.clientToServer,
  });
  await clientTransport.ready();
  const client = new AhpClient(clientTransport, { requestTimeoutMs: 10_000 });

  let sessionUri: string | undefined;
  try {
    client.connect();
    await client.initialize({
      clientId: 'live-slice-client',
      protocolVersions: ['0.3.0'],
      initialSubscriptions: ['ahp-root://'],
    });

    sessionUri = `ahp-session:/live-slice-${Date.now()}`;
    await client.request('createSession', {
      channel: sessionUri,
      provider: 'codex',
      workingDirectory: `file://${process.cwd()}`,
    });

    const { subscription } = await client.subscribe(sessionUri);
    client.dispatch(sessionUri, {
      type: 'session/turnStarted',
      turnId: 'live-slice-turn',
      message: userMessage(process.env.CODEX_LIVE_TURN_PROMPT ?? 'Reply with exactly: pong'),
    } as StateAction);

    const actions: StateAction[] = [];
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const next = await Promise.race([
        subscription.next(),
        new Promise<IteratorResult<never>>(resolve => setTimeout(
          () => resolve({ done: true, value: undefined as never }),
          1_000,
        )),
      ]);
      if (next.done) {
        continue;
      }
      if (next.value.type !== 'action') {
        continue;
      }
      actions.push(next.value.params.action);
      const type = next.value.params.action.type;
      if (type === 'session/turnComplete' || type === 'session/error') {
        break;
      }
    }

    const types = actions.map(action => String(action.type));
    assert.ok(types.includes('session/delta'), `expected streamed delta, saw: ${JSON.stringify(actions)}`);
    assert.ok(types.includes('session/turnComplete'), `expected turn completion, saw: ${JSON.stringify(actions)}`);
  } finally {
    if (sessionUri) {
      try {
        await client.request('disposeSession', { channel: sessionUri });
      } catch {
        // Ignore cleanup failure after validation failure.
      }
    }
    await client.shutdown();
    await serverConnection.close();
    await clientConnection.close();
    await serverRun;
  }
});

function userMessage(text: string): Message {
  return {
    text,
    origin: { kind: 'user' as Message['origin']['kind'] },
  };
}
