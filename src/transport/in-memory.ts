import { InMemoryTransport } from '@microsoft/agent-host-protocol/client';
import type { AhpTransport } from '@microsoft/agent-host-protocol/client';

export { InMemoryTransport as InMemoryServerTransport } from '@microsoft/agent-host-protocol/client';

export interface ReusableAhpServer {
  accept(transport: AhpTransport): Promise<void>;
}

export interface InProcessAhpClientTransport {
  readonly transport: AhpTransport;
  readonly serverRun: Promise<void>;
  close(): Promise<void>;
}

export function createInMemoryTransportPair(): [AhpTransport, AhpTransport] {
  return InMemoryTransport.pair();
}

export function createInProcessAhpClientTransport(server: ReusableAhpServer): InProcessAhpClientTransport {
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  const serverRun = server.accept(serverTransport);

  return {
    transport: clientTransport,
    serverRun,
    async close(): Promise<void> {
      await clientTransport.close();
      await Promise.allSettled([serverRun]);
    },
  };
}
