import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readServerProcessConfig } from '../src/index.js';

test('reads server process configuration from environment', () => {
  const config = readServerProcessConfig({
    NATS_URL: 'nats://127.0.0.1:4222',
    CODEX_APP_SERVER_SOCKET: '/tmp/codex.sock',
    AHP_NATS_NAMESPACE: 'demo',
    AHP_SERVER_ID: 'server-a',
    AHP_CLIENT_ID: 'client-a',
    AHP_STORAGE_DIR: 'relative-storage',
    AHP_DEFAULT_DIRECTORY: '/workspaces/example',
    CODEX_DEFAULT_MODEL: 'gpt-test',
  });

  assert.equal(config.natsUrl, 'nats://127.0.0.1:4222');
  assert.equal(config.codexAppServerSocket, '/tmp/codex.sock');
  assert.equal(config.natsNamespace, 'demo');
  assert.equal(config.serverId, 'server-a');
  assert.equal(config.clientId, 'client-a');
  assert.ok(config.storageDirectory.endsWith('/relative-storage'));
  assert.equal(config.defaultDirectory, 'file:///workspaces/example');
  assert.equal(config.codexDefaultModel, 'gpt-test');
});

test('requires NATS and a Codex App Server endpoint', () => {
  assert.throws(
    () => readServerProcessConfig({ CODEX_APP_SERVER_SOCKET: '/tmp/codex.sock' }),
    /NATS_URL is required/,
  );
  assert.throws(
    () => readServerProcessConfig({ NATS_URL: 'nats://127.0.0.1:4222' }),
    /CODEX_APP_SERVER_SOCKET or CODEX_APP_SERVER_URL is required/,
  );
});
