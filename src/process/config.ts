import { resolve } from 'node:path';

import type { URI } from '@microsoft/agent-host-protocol';

export interface ServerProcessConfig {
  readonly natsUrl: string;
  readonly natsNamespace: string;
  readonly serverId: string;
  readonly clientId: string;
  readonly storageDirectory: string;
  readonly codexAppServerSocket?: string;
  readonly codexAppServerUrl?: string;
  readonly codexDefaultModel: string;
  readonly piAgentBaseUrl?: string;
  readonly piAgentApiKey?: string;
  readonly piAgentModel?: string;
  readonly defaultDirectory?: URI;
}

export function readServerProcessConfig(env: NodeJS.ProcessEnv = process.env): ServerProcessConfig {
  const natsUrl = requireEnv(env, 'NATS_URL');
  const codexAppServerSocket = optionalEnv(env, 'CODEX_APP_SERVER_SOCKET');
  const codexAppServerUrl = optionalEnv(env, 'CODEX_APP_SERVER_URL');
  const piAgentBaseUrl = optionalEnv(env, 'PI_AGENT_BASE_URL');
  const piAgentApiKey = optionalEnv(env, 'PI_AGENT_API_KEY');
  const piAgentModel = optionalEnv(env, 'PI_AGENT_MODEL');
  const codexConfigured = Boolean(codexAppServerSocket || codexAppServerUrl);
  const piConfigured = Boolean(piAgentBaseUrl || piAgentApiKey || piAgentModel);
  if (!codexConfigured && !piConfigured) {
    throw new Error('configure at least one provider: Codex endpoint or PI_AGENT_BASE_URL, PI_AGENT_API_KEY, and PI_AGENT_MODEL');
  }
  if (piConfigured && (!piAgentBaseUrl || !piAgentApiKey || !piAgentModel)) {
    throw new Error('PI_AGENT_BASE_URL, PI_AGENT_API_KEY, and PI_AGENT_MODEL are required when configuring Pi Agent');
  }

  return {
    natsUrl,
    natsNamespace: optionalEnv(env, 'AHP_NATS_NAMESPACE') ?? 'ahp',
    serverId: optionalEnv(env, 'AHP_SERVER_ID') ?? 'server',
    clientId: optionalEnv(env, 'AHP_CLIENT_ID') ?? 'client',
    storageDirectory: resolve(optionalEnv(env, 'AHP_STORAGE_DIR') ?? '.ahp-server'),
    codexAppServerSocket,
    codexAppServerUrl,
    codexDefaultModel: optionalEnv(env, 'CODEX_E2E_MODEL') ?? optionalEnv(env, 'CODEX_DEFAULT_MODEL') ?? 'gpt-5.5',
    piAgentBaseUrl,
    piAgentApiKey,
    piAgentModel,
    defaultDirectory: toFileUri(optionalEnv(env, 'AHP_DEFAULT_DIRECTORY')),
  };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = optionalEnv(env, name);
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optionalEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function toFileUri(path: string | undefined): URI | undefined {
  if (!path) {
    return undefined;
  }
  if (path.startsWith('file://')) {
    return path;
  }
  return `file://${resolve(path)}`;
}
