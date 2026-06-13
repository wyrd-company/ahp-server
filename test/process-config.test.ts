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
    PI_AGENT_PROVIDER: 'opencode-go',
    OPENCODE_API_KEY: 'pi-key',
    PI_AGENT_MODEL: 'pi-model',
  });

  assert.equal(config.natsUrl, 'nats://127.0.0.1:4222');
  assert.equal(config.natsNamespace, 'demo');
  assert.equal(config.serverId, 'server-a');
  assert.equal(config.clientId, 'client-a');
  assert.equal(config.grpcUnixSocket, '/tmp/ahp.sock');
  assert.ok(config.storageDirectory.endsWith('/relative-storage'));
  assert.equal(config.defaultDirectory, 'file:///workspaces/example');
  assert.equal(config.piAgentProvider, 'opencode-go');
  assert.equal(config.piAgentBaseUrl, 'https://opencode.ai/zen/go/v1');
  assert.equal(config.piAgentApiKey, 'pi-key');
  assert.equal(config.piAgentModel, 'pi-model');
});

test('requires at least one transport and at least one provider', () => {
  assert.throws(
    () => readServerProcessConfig({ PI_AGENT_MODEL: 'pi-model' }),
    /configure at least one transport/,
  );
  assert.throws(
    () => readServerProcessConfig({ NATS_URL: 'nats://127.0.0.1:4222' }),
    /configure at least one provider/,
  );
  assert.throws(
    () => readServerProcessConfig({
      NATS_URL: 'nats://127.0.0.1:4222',
      OPENCODE_API_KEY: 'pi-key',
      PI_AGENT_PROVIDER: 'opencode-go',
    }),
    /PI_AGENT_MODEL and a provider API key are required/,
  );
});

test('allows gRPC Unix socket as the only transport', () => {
  const config = readServerProcessConfig({
    AHP_GRPC_UDS_PATH: 'relative.sock',
    OPENCODE_API_KEY: 'pi-key',
    PI_AGENT_MODEL: 'pi-model',
  });

  assert.ok(config.grpcUnixSocket?.endsWith('/relative.sock'));
  assert.equal(config.natsUrl, undefined);
  assert.equal(config.piAgentProvider, 'opencode-go');
});

test('allows explicit Pi Agent key and base URL overrides', () => {
  const config = readServerProcessConfig({
    NATS_URL: 'nats://127.0.0.1:4222',
    PI_AGENT_BASE_URL: 'https://pi.example/v1',
    PI_AGENT_API_KEY: 'pi-key',
    PI_AGENT_MODEL: 'pi-model',
  });

  assert.equal(config.piAgentProvider, 'opencode-go');
  assert.equal(config.piAgentBaseUrl, 'https://pi.example/v1');
  assert.equal(config.piAgentApiKey, 'pi-key');
  assert.equal(config.piAgentModel, 'pi-model');
});

test('allows OPENCODE_API_KEY as the default Pi Agent key', () => {
  const config = readServerProcessConfig({
    NATS_URL: 'nats://127.0.0.1:4222',
    OPENCODE_API_KEY: 'pi-key',
    PI_AGENT_MODEL: 'pi-model',
  });

  assert.equal(config.piAgentProvider, 'opencode-go');
  assert.equal(config.piAgentApiKey, 'pi-key');
  assert.equal(config.piAgentModel, 'pi-model');
});
