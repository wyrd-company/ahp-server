import { connect, type NatsConnection } from 'nats';

import { AhpServer } from '../server.js';
import { FileSystemSessionStore } from '../store.js';
import { createCodexAppServerProvider } from '../codex-app-server/provider.js';
import { createClaudeAgentSdkProvider, type ClaudeAgentSdkOptions } from '../claude-agent-sdk/index.js';
import { NatsServerTransport } from '../nats/transport.js';
import { ahpNatsSubjects } from '../nats/subjects.js';
import { createPiAgentProvider } from '../pi-agent/provider.js';
import type { ServerProcessConfig } from './config.js';

export interface RunningServerProcess {
  readonly ready: Promise<void>;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

export async function startServerProcess(config: ServerProcessConfig): Promise<RunningServerProcess> {
  const connection = await connect({ servers: config.natsUrl });
  const subjects = ahpNatsSubjects({
    namespace: config.natsNamespace,
    serverId: config.serverId,
    clientId: config.clientId,
  });
  const providers = [];
  if (config.codexAppServerSocket || config.codexAppServerUrl) {
    providers.push(createCodexAppServerProvider({
      socketPath: config.codexAppServerSocket,
      webSocketUrl: config.codexAppServerUrl,
      defaultModel: config.codexDefaultModel,
    }));
  }
  if (config.claudeAgentSdkConfigured) {
    providers.push(createClaudeAgentSdkProvider({
      defaultModel: config.claudeAgentSdkModel,
      pathToClaudeCodeExecutable: config.claudeAgentSdkExecutable,
      permissionMode: config.claudeAgentSdkPermissionMode as ClaudeAgentSdkOptions['permissionMode'],
    }));
  }
  if (config.piAgentBaseUrl && config.piAgentApiKey && config.piAgentModel) {
    providers.push(createPiAgentProvider({
      baseUrl: config.piAgentBaseUrl,
      apiKey: config.piAgentApiKey,
      defaultModel: config.piAgentModel,
    }));
  }
  const server = new AhpServer({
    store: new FileSystemSessionStore({
      directory: config.storageDirectory,
      agents: providers.map(provider => provider.agent),
    }),
    providers,
    defaultDirectory: config.defaultDirectory,
  });
  const transport = new NatsServerTransport({
    connection,
    inboundSubject: subjects.clientToServer,
    outboundSubject: subjects.serverToClient,
  });
  await transport.ready();
  const acceptRun = server.accept(transport);
  const closed = acceptRun.finally(async () => {
    await closeNats(connection);
  });

  return {
    ready: Promise.resolve(),
    closed,
    async close(): Promise<void> {
      transport.close();
      await closeNats(connection);
      await closed;
    },
  };
}

async function closeNats(connection: NatsConnection): Promise<void> {
  if (connection.isClosed()) {
    return;
  }
  await connection.close();
}
