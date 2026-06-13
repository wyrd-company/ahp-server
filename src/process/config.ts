import { resolve } from 'node:path';

import type { URI } from '@microsoft/agent-host-protocol';

export interface ServerProcessConfig {
  readonly natsUrl?: string;
  readonly natsNamespace: string;
  readonly serverId: string;
  readonly clientId: string;
  readonly grpcUnixSocket?: string;
  readonly storageDirectory: string;
  readonly piAgentProvider?: string;
  readonly piAgentBaseUrl?: string;
  readonly piAgentApiKey?: string;
  readonly piAgentModel?: string;
  readonly defaultDirectory?: URI;
}

export function readServerProcessConfig(env: NodeJS.ProcessEnv = process.env): ServerProcessConfig {
  const natsUrl = optionalEnv(env, 'NATS_URL');
  const grpcUnixSocket = optionalEnv(env, 'AHP_GRPC_UNIX_SOCKET') ?? optionalEnv(env, 'AHP_GRPC_UDS_PATH');
  const configuredPiAgentProvider = optionalEnv(env, 'PI_AGENT_PROVIDER');
  const piAgentProvider = configuredPiAgentProvider ?? 'opencode-go';
  const piAgentBaseUrl = optionalEnv(env, 'PI_AGENT_BASE_URL') ?? defaultPiAgentBaseUrl(piAgentProvider);
  const piAgentApiKey = optionalEnv(env, 'PI_AGENT_API_KEY') ?? providerApiKey(env, piAgentProvider);
  const piAgentModel = optionalEnv(env, 'PI_AGENT_MODEL');
  const piConfigured = Boolean(configuredPiAgentProvider || optionalEnv(env, 'PI_AGENT_BASE_URL') || optionalEnv(env, 'PI_AGENT_API_KEY') || piAgentModel);
  if (!natsUrl && !grpcUnixSocket) {
    throw new Error('configure at least one transport: NATS_URL or AHP_GRPC_UNIX_SOCKET');
  }
  if (!piConfigured) {
    throw new Error('configure at least one provider: PI_AGENT_MODEL with PI_AGENT_API_KEY/OPENCODE_API_KEY');
  }
  if (piConfigured && (!piAgentBaseUrl || !piAgentApiKey || !piAgentModel)) {
    throw new Error('PI_AGENT_MODEL and a provider API key are required when configuring Pi Agent');
  }

  return {
    natsUrl,
    natsNamespace: optionalEnv(env, 'AHP_NATS_NAMESPACE') ?? 'ahp',
    serverId: optionalEnv(env, 'AHP_SERVER_ID') ?? 'server',
    clientId: optionalEnv(env, 'AHP_CLIENT_ID') ?? 'client',
    grpcUnixSocket: grpcUnixSocket ? resolve(grpcUnixSocket) : undefined,
    storageDirectory: resolve(optionalEnv(env, 'AHP_STORAGE_DIR') ?? '.ahp-server'),
    piAgentProvider: piConfigured ? piAgentProvider : undefined,
    piAgentBaseUrl: piConfigured ? piAgentBaseUrl : undefined,
    piAgentApiKey: piConfigured ? piAgentApiKey : undefined,
    piAgentModel: piConfigured ? piAgentModel : undefined,
    defaultDirectory: toFileUri(optionalEnv(env, 'AHP_DEFAULT_DIRECTORY')),
  };
}

function optionalEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function providerApiKey(env: NodeJS.ProcessEnv, provider: string): string | undefined {
  const envName = providerApiKeyEnvName(provider);
  return envName ? optionalEnv(env, envName) : undefined;
}

function providerApiKeyEnvName(provider: string): string | undefined {
  switch (provider) {
    case 'opencode':
    case 'opencode-go':
      return 'OPENCODE_API_KEY';
    default:
      return undefined;
  }
}

function defaultPiAgentBaseUrl(provider: string): string | undefined {
  switch (provider) {
    case 'opencode':
      return 'https://opencode.ai/zen/v1';
    case 'opencode-go':
      return 'https://opencode.ai/zen/go/v1';
    default:
      return undefined;
  }
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
