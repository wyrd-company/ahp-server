import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { AhpClient } from '@microsoft/agent-host-protocol/client';
import type { AgentInfo, Message, StateAction } from '@microsoft/agent-host-protocol';

import {
  AhpServer,
  GrpcAhpClientTransport,
  NatsAhpClientTransport,
  NatsServerTransport,
  ahpNatsSubjects,
  createGrpcUdsServer,
  type AgentProvider,
  type AgentSession,
  type AgentTurnSink,
  type NatsConnectionLike,
} from '../src/index.js';

const runningServers: Array<Promise<void>> = [];

after(async () => {
  await Promise.allSettled(runningServers);
});

test('serves AHP clients over NATS and gRPC transports at the same time', async () => {
  const server = new AhpServer({ providers: [createEchoProvider()] });
  const broker = new FakeNatsBroker();
  const subjects = ahpNatsSubjects({
    namespace: `ahp.multi.${Date.now()}`,
    serverId: 'server',
    clientId: 'nats-client',
  });

  runningServers.push(server.accept(new NatsServerTransport({
    connection: broker,
    inboundSubject: subjects.clientToServer,
    outboundSubject: subjects.serverToClient,
  })));

  const directory = mkdtempSync(join(tmpdir(), 'ahp-server-grpc-'));
  const socketPath = join(directory, 'ahp.sock');
  const grpcServer = createGrpcUdsServer({
    socketPath,
    onTransport: transport => {
      runningServers.push(server.accept(transport));
    },
  });
  await grpcServer.listen();

  const natsClient = new AhpClient(new NatsAhpClientTransport({
    connection: broker,
    inboundSubject: subjects.serverToClient,
    outboundSubject: subjects.clientToServer,
  }), { requestTimeoutMs: 1_000 });
  const grpcTransport = new GrpcAhpClientTransport({ socketPath });
  await grpcTransport.ready();
  const grpcClient = new AhpClient(grpcTransport, { requestTimeoutMs: 1_000 });

  try {
    natsClient.connect();
    grpcClient.connect();
    await natsClient.initialize({ clientId: 'nats-client', protocolVersions: ['0.3.0'] });
    await grpcClient.initialize({ clientId: 'grpc-client', protocolVersions: ['0.3.0'] });

    await Promise.all([
      assertSessionFlow(natsClient, 'nats'),
      assertSessionFlow(grpcClient, 'grpc'),
    ]);
  } finally {
    await natsClient.shutdown().catch(() => undefined);
    await grpcClient.shutdown().catch(() => undefined);
    await grpcServer.close();
    rmSync(directory, { recursive: true, force: true });
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

class FakeNatsBroker implements NatsConnectionLike {
  private readonly subscriptions = new Map<string, Set<FakeSubscription>>();

  publish(subject: string, data?: Uint8Array): void {
    for (const subscription of this.subscriptions.get(subject) ?? []) {
      subscription.deliver({ data: data ?? new Uint8Array() });
    }
  }

  subscribe(subject: string): FakeSubscription {
    const subscription = new FakeSubscription(() => {
      this.subscriptions.get(subject)?.delete(subscription);
    });
    const subscriptions = this.subscriptions.get(subject) ?? new Set<FakeSubscription>();
    subscriptions.add(subscription);
    this.subscriptions.set(subject, subscriptions);
    return subscription;
  }
}

class FakeSubscription implements AsyncIterable<{ data: Uint8Array }> {
  private readonly queue: Array<{ data: Uint8Array } | null> = [];
  private waiter: ((message: { data: Uint8Array } | null) => void) | undefined;
  private closed = false;

  constructor(private readonly onUnsubscribe: () => void) {}

  deliver(message: { data: Uint8Array }): void {
    if (this.closed) {
      return;
    }
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter(message);
      return;
    }
    this.queue.push(message);
  }

  unsubscribe(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.onUnsubscribe();
    this.deliverNull();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<{ data: Uint8Array }> {
    while (true) {
      const message = await this.next();
      if (message === null) {
        return;
      }
      yield message;
    }
  }

  private next(): Promise<{ data: Uint8Array } | null> {
    const message = this.queue.shift();
    if (message !== undefined) {
      return Promise.resolve(message);
    }
    if (this.closed) {
      return Promise.resolve(null);
    }
    return new Promise(resolve => {
      this.waiter = resolve;
    });
  }

  private deliverNull(): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter(null);
      return;
    }
    this.queue.push(null);
  }
}
