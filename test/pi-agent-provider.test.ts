import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { AhpClient } from '@microsoft/agent-host-protocol/client';
import type { AhpTransport, JsonRpcMessage, TransportFrame } from '@microsoft/agent-host-protocol/client';
import type { Message, StateAction } from '@microsoft/agent-host-protocol';

import {
  AhpServer,
  createInMemoryTransportPair,
  createPiAgentProvider,
  type PiAgentChatClient,
  type PiAgentChatMessage,
  type PiAgentStreamCompletionParams,
} from '../src/index.js';

const runningServers: Array<Promise<void>> = [];

after(async () => {
  await Promise.allSettled(runningServers);
});

test('Pi Agent provider streams OpenAI-compatible chat completions as AHP actions', async () => {
  const pi = new FakePiAgentClient(['Pi ', 'says ', 'hello']);
  const server = new AhpServer({
    providers: [createPiAgentProvider({ client: pi, defaultModel: 'pi-test' })],
  });
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  runningServers.push(server.accept(serverTransport));

  const client = new AhpClient(asAhpTransport(clientTransport), { requestTimeoutMs: 1_000 });
  client.connect();
  await client.initialize({ clientId: 'test-client', protocolVersions: ['0.3.0'] });

  const sessionUri = 'ahp-session:/pi-session';
  await client.request('createSession', {
    channel: sessionUri,
    provider: 'pi-agent',
  });
  const { subscription } = await client.subscribe(sessionUri);

  client.dispatch(sessionUri, {
    type: 'session/turnStarted',
    turnId: 'ahp-turn-1',
    message: userMessage('Hello Pi'),
  } as StateAction);

  const events = [
    await subscription.next(),
    await subscription.next(),
    await subscription.next(),
    await subscription.next(),
    await subscription.next(),
  ].map(event => {
    assert.equal(event.done, false);
    assert.equal(event.value.type, 'action');
    return event.value.params.action;
  });

  assert.equal(pi.requests.length, 1);
  assert.equal(pi.requests[0]?.model, 'pi-test');
  assert.deepEqual(pi.requests[0]?.messages, [{ role: 'user', content: 'Hello Pi' }]);
  assert.equal(events[1]?.type, 'session/responsePart');
  assert.equal((events[1] as { turnId?: string }).turnId, 'ahp-turn-1');
  assert.equal(events[2]?.type, 'session/delta');
  assert.equal((events[2] as { content?: string }).content, 'Pi ');
  assert.equal((events[2] as { turnId?: string }).turnId, 'ahp-turn-1');
  assert.equal(events[4]?.type, 'session/delta');

  const final = await subscription.next();
  assert.equal(final.done, false);
  assert.equal(final.value.type, 'action');
  assert.equal(final.value.params.action.type, 'session/turnComplete');
  assert.equal((final.value.params.action as { turnId?: string }).turnId, 'ahp-turn-1');

  await client.shutdown();
});

class FakePiAgentClient implements PiAgentChatClient {
  readonly requests: Array<{ model: string; messages: readonly PiAgentChatMessage[] }> = [];

  constructor(private readonly chunks: readonly string[]) {}

  async *streamChatCompletion(params: PiAgentStreamCompletionParams): AsyncIterable<string> {
    this.requests.push({
      model: params.model,
      messages: params.messages.map(message => ({ ...message })),
    });
    for (const chunk of this.chunks) {
      yield chunk;
    }
  }
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
