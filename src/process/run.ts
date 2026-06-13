import { connect, type NatsConnection } from '@nats-io/transport-node';
import { NatsServerTransport, ahpNatsSubjects } from '@wyrd-company/ahp-nats';
import { createGrpcUdsServer, type AhpGrpcUdsServer } from '@wyrd-company/ahp-grpc';

import { AhpServer } from '../server.js';
import { FileSystemSessionStore } from '../store.js';
import { createClaudeAgentSdkProvider, type ClaudeAgentSdkOptions } from '../claude-agent-sdk/index.js';
import { createPiAgentProvider } from '../pi-agent/provider.js';
import type { ServerTransport } from '../types.js';
import type { ServerProcessConfig } from './config.js';

export interface RunningServerProcess {
  readonly ready: Promise<void>;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

export async function startServerProcess(config: ServerProcessConfig): Promise<RunningServerProcess> {
  const providers = [];
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

  const acceptRuns = new Set<Promise<void>>();
  const closeActions: Array<() => Promise<void> | void> = [];
  const accept = (transport: ServerTransport): void => {
    const acceptRun = server.accept(transport).finally(() => {
      acceptRuns.delete(acceptRun);
    });
    acceptRuns.add(acceptRun);
  };

  if (config.natsUrl) {
    const natsConnection = await connect({ servers: config.natsUrl });
    const subjects = ahpNatsSubjects({
      namespace: config.natsNamespace,
      serverId: config.serverId,
      clientId: config.clientId,
    });
    const transport = new NatsServerTransport({
      connection: natsConnection,
      inboundSubject: subjects.clientToServer,
      outboundSubject: subjects.serverToClient,
    });
    await transport.ready();
    accept(transport);
    closeActions.push(() => transport.close());
    closeActions.push(() => closeNats(natsConnection));
  }

  let grpcServer: AhpGrpcUdsServer | undefined;
  if (config.grpcUnixSocket) {
    grpcServer = createGrpcUdsServer({
      socketPath: config.grpcUnixSocket,
      onTransport: accept,
    });
    await grpcServer.listen();
    closeActions.push(() => grpcServer?.close());
  }

  let closeStarted = false;
  let resolveClosed!: () => void;
  let rejectClosed!: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });

  return {
    ready: Promise.resolve(),
    closed,
    async close(): Promise<void> {
      if (closeStarted) {
        await closed;
        return;
      }
      closeStarted = true;
      try {
        await Promise.allSettled(closeActions.map(action => action()));
        await Promise.allSettled([...acceptRuns]);
        resolveClosed();
      } catch (error) {
        rejectClosed(error);
        throw error;
      }
    },
  };
}

async function closeNats(connection: NatsConnection): Promise<void> {
  if (connection.isClosed()) {
    return;
  }
  await connection.close();
}
