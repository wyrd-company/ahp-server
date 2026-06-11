import { InMemoryTransport } from '@microsoft/agent-host-protocol/client';
import type { AhpTransport } from '@microsoft/agent-host-protocol/client';

export { InMemoryTransport as InMemoryServerTransport } from '@microsoft/agent-host-protocol/client';

export function createInMemoryTransportPair(): [AhpTransport, AhpTransport] {
  return InMemoryTransport.pair();
}
