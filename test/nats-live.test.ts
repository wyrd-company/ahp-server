import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AhpClient } from '@microsoft/agent-host-protocol/client';
import { connect } from '@nats-io/transport-node';
import {
  NatsAhpClientTransport,
  NatsServerTransport,
  ahpNatsSubjects,
} from '@wyrd-company/ahp-nats';
import type { AgentInfo, Message, StateAction } from '@microsoft/agent-host-protocol';

import {
  AhpServer,
  type AgentProvider,
  type AgentSession,
  type AgentTurnSink,
} from '../src/index.js';

test('routes a real AHP session flow through a live NATS broker', {
  skip: process.env.NATS_URL ? false : 'set NATS_URL to run live NATS validation',
}, async () => {
  const natsUrl = process.env.NATS_URL;
  assert.ok(natsUrl);

  const serverConnection = await connect({ servers: natsUrl, timeout: 2_000 });
  const clientConnection = await connect({ servers: natsUrl, timeout: 2_000 });
  const subjects = ahpNatsSubjects({
    namespace: `ahp.live.${Date.now()}`,
    serverId: 'server',
    clientId: 'client',
  });

  const server = new AhpServer({ providers: [createLiveEchoProvider()] });
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
  const client = new AhpClient(clientTransport, { requestTimeoutMs: 2_000 });

  try {
    client.connect();
    const init = await client.initialize({
      clientId: 'live-nats-client',
      protocolVersions: ['0.3.0'],
      initialSubscriptions: ['ahp-root://'],
    });
    assert.equal(init.protocolVersion, '0.3.0');

    const sessionUri = 'ahp-session:/live-nats-session';
    await client.request('createSession', { channel: sessionUri, provider: 'live-echo' });
    const { subscription } = await client.subscribe(sessionUri);

    client.dispatch(sessionUri, {
      type: 'session/turnStarted',
      turnId: 'live-turn',
      message: userMessage('hello over real NATS'),
    } as StateAction);

    const actionTypes = [
      await subscription.next(),
      await subscription.next(),
      await subscription.next(),
      await subscription.next(),
    ].map(event => {
      assert.equal(event.done, false);
      assert.equal(event.value.type, 'action');
      return event.value.params.action.type;
    });

    assert.deepEqual(actionTypes, [
      'session/turnStarted',
      'session/responsePart',
      'session/delta',
      'session/turnComplete',
    ]);
  } finally {
    await client.shutdown();
    await serverConnection.close();
    await clientConnection.close();
    await serverRun;
  }
});

function createLiveEchoProvider(): AgentProvider {
  const agent: AgentInfo = {
    provider: 'live-echo',
    displayName: 'Live Echo',
    description: 'Echo provider used by live NATS validation.',
    models: [{ id: 'live-echo', provider: 'live-echo', name: 'Live Echo' }],
  };

  return {
    agent,
    createSession(): AgentSession {
      return {
        async sendUserMessage(message: Message, sink: AgentTurnSink): Promise<void> {
          sink.emit({
            type: 'session/responsePart',
            turnId: 'live-turn',
            part: {
              kind: 'markdown',
              id: 'live-part',
              content: '',
            },
          } as StateAction);
          sink.emit({
            type: 'session/delta',
            turnId: 'live-turn',
            partId: 'live-part',
            content: `Echo: ${message.text}`,
          } as StateAction);
          sink.emit({
            type: 'session/turnComplete',
            turnId: 'live-turn',
          } as StateAction);
        },
      };
    },
  };
}

function userMessage(text: string): Message {
  return {
    text,
    origin: { kind: 'user' as Message['origin']['kind'] },
  };
}
