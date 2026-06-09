import type { JsonRpcMessage, ServerTransport } from '../types.js';

class InMemoryEndpoint implements ServerTransport {
  private inbox: Array<JsonRpcMessage | string | null> = [];
  private waiter: ((message: JsonRpcMessage | string | null) => void) | undefined;
  private closed = false;
  peer!: InMemoryEndpoint;

  send(message: JsonRpcMessage | string): void {
    if (this.closed) {
      throw new Error('transport closed');
    }
    this.peer.deliver(message);
  }

  recv(): Promise<JsonRpcMessage | string | null> {
    const next = this.inbox.shift();
    if (next !== undefined) {
      return Promise.resolve(next);
    }
    if (this.closed) {
      return Promise.resolve(null);
    }
    return new Promise(resolve => {
      this.waiter = resolve;
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.deliver(null);
    this.peer.deliver(null);
  }

  private deliver(message: JsonRpcMessage | string | null): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter(message);
      return;
    }
    this.inbox.push(message);
  }
}

export class InMemoryServerTransport extends InMemoryEndpoint {}

export function createInMemoryTransportPair(): [ServerTransport, ServerTransport] {
  const a = new InMemoryEndpoint();
  const b = new InMemoryEndpoint();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

