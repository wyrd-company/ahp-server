import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readServerProcessConfig } from '../src/index.js';

test('reads server process configuration from environment', () => {
  const config = readServerProcessConfig({
    NATS_URL: 'nats://127.0.0.1:4222',
    AHP_NATS_NAMESPACE: 'demo',
    AHP_SERVER_ID: 'server-a',
    AHP_CLIENT_ID: 'client-a',
    AHP_GRPC_UNIX_SOCKET: '/tmp/ahp.sock',
    AHP_STORAGE_DIR: 'relative-storage',
    AHP_DEFAULT_DIRECTORY: '/workspaces/example',
  });

  assert.equal(config.natsUrl, 'nats://127.0.0.1:4222');
  assert.equal(config.natsNamespace, 'demo');
  assert.equal(config.serverId, 'server-a');
  assert.equal(config.clientId, 'client-a');
  assert.equal(config.grpcUnixSocket, '/tmp/ahp.sock');
  assert.ok(config.storageDirectory.endsWith('/relative-storage'));
  assert.equal(config.defaultDirectory, 'file:///workspaces/example');
});

test('requires at least one transport', () => {
  assert.throws(
    () => readServerProcessConfig({ AHP_STORAGE_DIR: 'storage' }),
    /configure at least one transport/,
  );
});

test('allows gRPC Unix socket as the only transport', () => {
  const config = readServerProcessConfig({
    AHP_GRPC_UDS_PATH: 'relative.sock',
  });

  assert.ok(config.grpcUnixSocket?.endsWith('/relative.sock'));
  assert.equal(config.natsUrl, undefined);
});
