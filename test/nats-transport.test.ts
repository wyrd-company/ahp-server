import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { AhpClient } from '@microsoft/agent-host-protocol/client';
import {
  NatsAhpClientTransport,
  NatsServerTransport,
  ahpNatsSubjects,
  type NatsConnectionLike,
} from '@wyrd-company/ahp-nats';
import type { AgentInfo } from '@microsoft/agent-host-protocol';

import {
  AhpServer,
  type AgentProvider,
} from '../src/index.js';

const runningServers: Array<Promise<void>> = [];

after(async () => {
  await Promise.allSettled(runningServers);
});

test('routes AHP client and server frames over paired NATS subjects', async () => {
  const broker = new FakeNatsBroker();
  const subjects = ahpNatsSubjects({
    namespace: 'wyrd.ahp',
    serverId: 'server-a',
    clientId: 'client-a',
  });

  assert.deepEqual(subjects, {
    clientToServer: 'wyrd_ahp.server.server-a.client.client-a.to-server',
    serverToClient: 'wyrd_ahp.server.server-a.client.client-a.to-client',
  });

  const server = new AhpServer({ providers: [createNoopProvider()] });
  runningServers.push(server.accept(new NatsServerTransport({
    connection: broker,
    inboundSubject: subjects.clientToServer,
    outboundSubject: subjects.serverToClient,
  })));

  const client = new AhpClient(new NatsAhpClientTransport({
    connection: broker,
    inboundSubject: subjects.serverToClient,
    outboundSubject: subjects.clientToServer,
  }), { requestTimeoutMs: 1_000 });

  client.connect();
  const init = await client.initialize({
    clientId: 'client-a',
    protocolVersions: ['0.3.0'],
    initialSubscriptions: ['ahp-root://'],
  });

  assert.equal(init.protocolVersion, '0.3.0');
  assert.equal(init.snapshots[0]?.resource, 'ahp-root://');

  await client.shutdown();
});

class FakeNatsBroker implements NatsConnectionLike {
  private readonly subscriptions = new Map<string, Set<FakeSubscription>>();

  publish(subject: string, data?: Uint8Array): void {
    for (const subscription of this.subscriptions.get(subject) ?? []) {
      subscription.deliver({ data: data ?? new Uint8Array() });
    }
  }

  request(): Promise<never> {
    return Promise.reject(new Error('FakeNatsBroker request is not implemented'));
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

function createNoopProvider(): AgentProvider {
  const agent: AgentInfo = {
    provider: 'noop',
    displayName: 'Noop',
    description: 'No-op test provider.',
    models: [{ id: 'noop', provider: 'noop', name: 'Noop' }],
  };
  return {
    agent,
    createSession() {
      return {
        async sendUserMessage(): Promise<void> {},
      };
    },
  };
}
