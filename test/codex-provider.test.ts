import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { AhpClient } from '@microsoft/agent-host-protocol/client';
import type { AhpTransport, JsonRpcMessage, TransportFrame } from '@microsoft/agent-host-protocol/client';
import type { Message, StateAction } from '@microsoft/agent-host-protocol';

import {
  AhpServer,
  createCodexAppServerProvider,
  createInMemoryTransportPair,
  type CodexAppServerClient,
  type CodexJsonRpcNotification,
  type CodexServerRequestEvent,
} from '../src/index.js';

const runningServers: Array<Promise<void>> = [];

after(async () => {
  await Promise.allSettled(runningServers);
});

test('Codex provider maps an AHP turn to CAS thread and turn requests', async () => {
  const codex = new FakeCodexClient();
  const provider = createCodexAppServerProvider({ client: codex, defaultModel: 'gpt-test' });
  const server = new AhpServer({ providers: [provider] });
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  runningServers.push(server.accept(serverTransport));

  const client = new AhpClient(asAhpTransport(clientTransport), { requestTimeoutMs: 1_000 });
  client.connect();
  await client.initialize({ clientId: 'test-client', protocolVersions: ['0.3.0'] });

  const sessionUri = 'ahp-session:/codex-session';
  await client.request('createSession', {
    channel: sessionUri,
    provider: 'codex',
    workingDirectory: 'file:///workspaces/project-a',
  });
  const { subscription } = await client.subscribe(sessionUri);

  client.dispatch(sessionUri, {
    type: 'session/turnStarted',
    turnId: 'ahp-turn-1',
    message: userMessage('Summarize the repo'),
  } as StateAction);

  const events = [
    await subscription.next(),
    await subscription.next(),
    await subscription.next(),
    await subscription.next(),
  ].map(event => {
    assert.equal(event.done, false);
    assert.equal(event.value.type, 'action');
    return event.value.params.action;
  });

  assert.deepEqual(codex.requests.map(request => request.method), [
    'thread/start',
    'turn/start',
  ]);
  assert.equal(codex.requests[0]?.params.cwd, '/workspaces/project-a');
  assert.equal(codex.requests[1]?.params.threadId, 'codex-thread-1');
  assert.deepEqual(codex.requests[1]?.params.input, [
    { type: 'text', text: 'Summarize the repo', text_elements: [] },
  ]);
  assert.equal(events[1]?.type, 'session/responsePart');
  assert.equal((events[1] as { turnId?: string }).turnId, 'ahp-turn-1');
  assert.equal(events[2]?.type, 'session/delta');
  assert.equal((events[2] as { turnId?: string }).turnId, 'ahp-turn-1');
  assert.equal((events[2] as { content?: string }).content, 'Codex says hello');
  assert.equal(events[3]?.type, 'session/turnComplete');
  assert.equal((events[3] as { turnId?: string }).turnId, 'ahp-turn-1');

  await client.shutdown();
});

interface RecordedRequest {
  method: string;
  params: Record<string, unknown>;
}

class FakeCodexClient implements CodexAppServerClient {
  readonly requests: RecordedRequest[] = [];
  private notificationListeners = new Set<(notification: CodexJsonRpcNotification) => void>();

  async connect(): Promise<void> {}

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params: params as Record<string, unknown> });
    if (method === 'thread/start') {
      return { thread: { id: 'codex-thread-1' } } as T;
    }
    if (method === 'turn/start') {
      queueMicrotask(() => {
        this.emit({
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'codex-thread-1',
            turnId: 'codex-turn-1',
            itemId: 'item-1',
            delta: 'Codex says hello',
          },
        });
        this.emit({
          method: 'turn/completed',
          params: {
            threadId: 'codex-thread-1',
            turn: { id: 'codex-turn-1' },
          },
        });
      });
      return { turn: { id: 'codex-turn-1' } } as T;
    }
    return undefined as T;
  }

  notify(): void {}

  onNotification(listener: (notification: CodexJsonRpcNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onServerRequest(_listener: (request: CodexServerRequestEvent) => void): () => void {
    return () => {};
  }

  async close(): Promise<void> {}

  private emit(notification: CodexJsonRpcNotification): void {
    for (const listener of this.notificationListeners) {
      listener(notification);
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
