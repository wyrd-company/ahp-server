import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AhpClient } from '@microsoft/agent-host-protocol/client';
import type { AhpTransport, JsonRpcMessage, TransportFrame } from '@microsoft/agent-host-protocol/client';
import type { Message, StateAction } from '@microsoft/agent-host-protocol';

import {
  AhpServer,
  createInMemoryTransportPair,
  createPiAgentProvider,
} from '../src/index.js';

test('streams a live Pi Agent OpenAI-compatible turn through AHP', {
  skip: process.env.PI_AGENT_BASE_URL && process.env.PI_AGENT_API_KEY && process.env.PI_AGENT_MODEL
    ? false
    : 'set PI_AGENT_BASE_URL, PI_AGENT_API_KEY, and PI_AGENT_MODEL to run live Pi Agent validation',
  timeout: 120_000,
}, async () => {
  assert.ok(process.env.PI_AGENT_BASE_URL);
  assert.ok(process.env.PI_AGENT_API_KEY);
  assert.ok(process.env.PI_AGENT_MODEL);

  const server = new AhpServer({
    providers: [
      createPiAgentProvider({
        baseUrl: process.env.PI_AGENT_BASE_URL,
        apiKey: process.env.PI_AGENT_API_KEY,
        defaultModel: process.env.PI_AGENT_MODEL,
      }),
    ],
  });
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  const serverRun = server.accept(serverTransport);
  const client = new AhpClient(asAhpTransport(clientTransport), { requestTimeoutMs: 10_000 });
  let sessionUri: string | undefined;

  try {
    client.connect();
    await client.initialize({ clientId: 'live-pi-client', protocolVersions: ['0.3.0'] });

    sessionUri = `ahp-session:/live-pi-${Date.now()}`;
    await client.request('createSession', {
      channel: sessionUri,
      provider: 'pi-agent',
    });
    const { subscription } = await client.subscribe(sessionUri);
    client.dispatch(sessionUri, {
      type: 'session/turnStarted',
      turnId: 'live-pi-turn',
      message: userMessage(process.env.PI_AGENT_LIVE_TURN_PROMPT ?? 'Reply with exactly: pong'),
    } as StateAction);

    const actions = await collectUntilTerminal(subscription);
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
    await serverRun;
  }
});

async function collectUntilTerminal(subscription: AsyncIterator<unknown>): Promise<StateAction[]> {
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
    const value = next.value as { type?: string; params?: { action?: StateAction } };
    if (next.done || value.type !== 'action' || !value.params?.action) {
      continue;
    }
    actions.push(value.params.action);
    const type = value.params.action.type;
    if (type === 'session/turnComplete' || type === 'session/error') {
      break;
    }
  }
  return actions;
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
