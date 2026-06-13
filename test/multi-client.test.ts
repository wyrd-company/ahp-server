import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { AhpClient } from '@microsoft/agent-host-protocol/client';
import type { AgentInfo, Message, StateAction } from '@microsoft/agent-host-protocol';

import {
  AhpServer,
  createInMemoryTransportPair,
  type AgentProvider,
  type AgentSession,
  type AgentTurnSink,
} from '../src/index.js';

const runningServers: Array<Promise<void>> = [];

after(async () => {
  await Promise.allSettled(runningServers);
});

test('serves multiple AHP clients over independent transports at the same time', async () => {
  const server = new AhpServer({ providers: [createEchoProvider()] });
  const first = createClient(server);
  const second = createClient(server);

  try {
    first.client.connect();
    second.client.connect();
    await first.client.initialize({ clientId: 'first-client', protocolVersions: ['0.3.0'] });
    await second.client.initialize({ clientId: 'second-client', protocolVersions: ['0.3.0'] });

    await Promise.all([
      assertSessionFlow(first.client, 'first'),
      assertSessionFlow(second.client, 'second'),
    ]);
  } finally {
    await first.client.shutdown().catch(() => undefined);
    await second.client.shutdown().catch(() => undefined);
  }
});

async function assertSessionFlow(client: AhpClient, name: string): Promise<void> {
  const sessionUri = `ahp-session:/${name}-${Date.now()}`;
  const turnId = `${name}-turn`;
  await client.request('createSession', { channel: sessionUri, provider: 'echo' });
  const { subscription } = await client.subscribe(sessionUri);
  client.dispatch(sessionUri, {
    type: 'session/turnStarted',
    turnId,
    message: userMessage(`hello ${name}`),
  } as StateAction);

  const actions = [
    await subscription.next(),
    await subscription.next(),
    await subscription.next(),
    await subscription.next(),
  ].map(event => {
    assert.equal(event.done, false);
    assert.equal(event.value.type, 'action');
    return event.value.params.action;
  });

  assert.deepEqual(actions.map(action => action.type), [
    'session/turnStarted',
    'session/responsePart',
    'session/delta',
    'session/turnComplete',
  ]);
}

function createClient(server: AhpServer): { client: AhpClient } {
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  runningServers.push(server.accept(serverTransport));
  return { client: new AhpClient(clientTransport, { requestTimeoutMs: 1_000 }) };
}

function createEchoProvider(): AgentProvider {
  const agent: AgentInfo = {
    provider: 'echo',
    displayName: 'Echo Agent',
    description: 'Test agent that echoes user messages.',
    models: [{ id: 'echo', provider: 'echo', name: 'Echo' }],
  };

  return {
    agent,
    createSession(): AgentSession {
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

function userMessage(text: string): Message {
  return {
    text,
    origin: { kind: 'user' as Message['origin']['kind'] },
  };
}
