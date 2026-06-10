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
    CLAUDE_AGENT_SDK_ENABLED: '1',
    CLAUDE_AGENT_SDK_MODEL: 'claude-test',
    CLAUDE_AGENT_SDK_EXECUTABLE: '/usr/local/bin/claude',
    CLAUDE_AGENT_SDK_PERMISSION_MODE: 'dontAsk',
    PI_AGENT_PROVIDER: 'opencode-go',
    OPENCODE_API_KEY: 'pi-key',
    PI_AGENT_MODEL: 'pi-model',
  });

  assert.equal(config.natsUrl, 'nats://127.0.0.1:4222');
  assert.equal(config.codexAppServerSocket, '/tmp/codex.sock');
  assert.equal(config.natsNamespace, 'demo');
  assert.equal(config.serverId, 'server-a');
  assert.equal(config.clientId, 'client-a');
  assert.ok(config.storageDirectory.endsWith('/relative-storage'));
  assert.equal(config.defaultDirectory, 'file:///workspaces/example');
  assert.equal(config.codexDefaultModel, 'gpt-test');
  assert.equal(config.claudeAgentSdkConfigured, true);
  assert.equal(config.claudeAgentSdkModel, 'claude-test');
  assert.equal(config.claudeAgentSdkExecutable, '/usr/local/bin/claude');
  assert.equal(config.claudeAgentSdkPermissionMode, 'dontAsk');
  assert.equal(config.piAgentProvider, 'opencode-go');
  assert.equal(config.piAgentBaseUrl, 'https://opencode.ai/zen/go/v1');
  assert.equal(config.piAgentApiKey, 'pi-key');
  assert.equal(config.piAgentModel, 'pi-model');
});

test('requires NATS and at least one provider', () => {
  assert.throws(
    () => readServerProcessConfig({ CODEX_APP_SERVER_SOCKET: '/tmp/codex.sock' }),
    /NATS_URL is required/,
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

test('allows Claude Agent SDK as the only provider', () => {
  const config = readServerProcessConfig({
    NATS_URL: 'nats://127.0.0.1:4222',
    CLAUDE_AGENT_SDK_ENABLED: 'true',
  });

  assert.equal(config.claudeAgentSdkConfigured, true);
  assert.equal(config.claudeAgentSdkPermissionMode, 'dontAsk');
  assert.equal(config.codexAppServerSocket, undefined);
  assert.equal(config.piAgentProvider, undefined);
});
