import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { AhpClient } from '@microsoft/agent-host-protocol/client';
import { GrpcAhpClientTransport } from '@wyrd-company/ahp-grpc';

import {
  startServerProcess,
  type ServerProcessConfig,
} from '../src/index.js';

test('starts the server process with gRPC Unix socket as the only transport', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ahp-grpc-process-'));
  const socketPath = join(directory, 'ahp.sock');
  const storageDirectory = join(directory, 'storage');
  const running = await startServerProcess({
    grpcUnixSocket: socketPath,
    natsNamespace: 'ahp',
    serverId: 'server',
    clientId: 'client',
    storageDirectory,
  } satisfies ServerProcessConfig);

  const transport = new GrpcAhpClientTransport({ socketPath });
  const client = new AhpClient(transport, { requestTimeoutMs: 1_000 });

  try {
    await running.ready;
    await transport.ready();
    client.connect();
    const init = await client.initialize({
      clientId: 'grpc-process-client',
      protocolVersions: ['0.3.0'],
      initialSubscriptions: ['ahp-root://'],
    });
    assert.equal(init.protocolVersion, '0.3.0');

    const sessions = await client.request('listSessions', { channel: 'ahp-root://' });
    assert.deepEqual(sessions, { items: [] });
  } finally {
    await client.shutdown().catch(() => undefined);
    await running.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
