import { connect, type NatsConnection } from 'nats';

import { AhpServer } from '../server.js';
import { FileSystemSessionStore } from '../store.js';
import { createCodexAppServerProvider } from '../codex-app-server/provider.js';
import { NatsServerTransport } from '../nats/transport.js';
import { ahpNatsSubjects } from '../nats/subjects.js';
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
  const provider = createCodexAppServerProvider({
    socketPath: config.codexAppServerSocket,
    webSocketUrl: config.codexAppServerUrl,
    defaultModel: config.codexDefaultModel,
  });
  const server = new AhpServer({
    store: new FileSystemSessionStore({
      directory: config.storageDirectory,
      agents: [provider.agent],
    }),
    providers: [provider],
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
