import type { AhpTransport, JsonRpcMessage, TransportFrame } from '@microsoft/agent-host-protocol/client';
import { StringCodec, type Msg, type NatsConnection, type Subscription } from 'nats';

import type { JsonRpcMessage as ServerJsonRpcMessage, ServerTransport } from '../types.js';

export interface NatsConnectionLike {
  publish(subject: string, data?: Uint8Array): void;
  subscribe(subject: string): AsyncIterable<MsgLike> & { unsubscribe(): void };
}

export interface MsgLike {
  readonly data: Uint8Array;
}

export interface AhpNatsTransportOptions {
  readonly connection: NatsConnection | NatsConnectionLike;
  readonly inboundSubject: string;
  readonly outboundSubject: string;
}

class NatsTextTransport {
  private readonly codec = StringCodec();
  private readonly subscription: Subscription | (AsyncIterable<MsgLike> & { unsubscribe(): void });
  private readonly inbox: Array<string | null> = [];
  private waiter: ((message: string | null) => void) | undefined;
  private closed = false;

  constructor(private readonly options: AhpNatsTransportOptions) {
    this.subscription = options.connection.subscribe(options.inboundSubject);
    void this.readLoop();
  }

  sendText(text: string): void {
    if (this.closed) {
      throw new Error('NATS transport closed');
    }
    this.options.connection.publish(optionsSubject(this.options.outboundSubject), this.codec.encode(text));
  }

  recvText(): Promise<string | null> {
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
    this.subscription.unsubscribe();
    this.deliver(null);
  }

  private async readLoop(): Promise<void> {
    try {
      for await (const message of this.subscription) {
        this.deliver(this.codec.decode(message.data));
      }
    } finally {
      this.close();
    }
  }

  private deliver(message: string | null): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter(message);
      return;
    }
    this.inbox.push(message);
  }
}

export class NatsServerTransport implements ServerTransport {
  private readonly inner: NatsTextTransport;

  constructor(options: AhpNatsTransportOptions) {
    this.inner = new NatsTextTransport(options);
  }

  send(message: ServerJsonRpcMessage | string): void {
    this.inner.sendText(typeof message === 'string' ? message : JSON.stringify(message));
  }

  async recv(): Promise<ServerJsonRpcMessage | string | null> {
    const text = await this.inner.recvText();
    return text === null ? null : text;
  }

  close(): void {
    this.inner.close();
  }
}

export class NatsAhpClientTransport implements AhpTransport {
  private readonly inner: NatsTextTransport;

  constructor(options: AhpNatsTransportOptions) {
    this.inner = new NatsTextTransport(options);
  }

  send(message: JsonRpcMessage | string): void {
    this.inner.sendText(typeof message === 'string' ? message : JSON.stringify(message));
  }

  async recv(): Promise<TransportFrame | null> {
    const text = await this.inner.recvText();
    return text === null ? null : { kind: 'text', text };
  }

  close(): void {
    this.inner.close();
  }
}

export function createNatsServerTransport(options: AhpNatsTransportOptions): ServerTransport {
  return new NatsServerTransport(options);
}

export function createNatsAhpClientTransport(options: AhpNatsTransportOptions): AhpTransport {
  return new NatsAhpClientTransport(options);
}

function optionsSubject(subject: string): string {
  return subject;
}

void (undefined as Msg | undefined);

