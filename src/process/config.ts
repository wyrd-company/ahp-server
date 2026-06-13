import { resolve } from 'node:path';

import type { URI } from '@microsoft/agent-host-protocol';

export interface ServerProcessConfig {
  readonly natsUrl?: string;
  readonly natsNamespace: string;
  readonly serverId: string;
  readonly clientId: string;
  readonly grpcUnixSocket?: string;
  readonly storageDirectory: string;
  readonly defaultDirectory?: URI;
}

export function readServerProcessConfig(env: NodeJS.ProcessEnv = process.env): ServerProcessConfig {
  const natsUrl = optionalEnv(env, 'NATS_URL');
  const grpcUnixSocket = optionalEnv(env, 'AHP_GRPC_UNIX_SOCKET') ?? optionalEnv(env, 'AHP_GRPC_UDS_PATH');
  if (!natsUrl && !grpcUnixSocket) {
    throw new Error('configure at least one transport: NATS_URL or AHP_GRPC_UNIX_SOCKET');
  }

  return {
    natsUrl,
    natsNamespace: optionalEnv(env, 'AHP_NATS_NAMESPACE') ?? 'ahp',
    serverId: optionalEnv(env, 'AHP_SERVER_ID') ?? 'server',
    clientId: optionalEnv(env, 'AHP_CLIENT_ID') ?? 'client',
    grpcUnixSocket: grpcUnixSocket ? resolve(grpcUnixSocket) : undefined,
    storageDirectory: resolve(optionalEnv(env, 'AHP_STORAGE_DIR') ?? '.ahp-server'),
    defaultDirectory: toFileUri(optionalEnv(env, 'AHP_DEFAULT_DIRECTORY')),
  };
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
