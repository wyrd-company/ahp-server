#!/usr/bin/env node
import { readServerProcessConfig } from './process/config.js';
import { startServerProcess } from './process/run.js';
import { ahpNatsSubjects } from '@wyrd-company/ahp-nats';

try {
  const config = readServerProcessConfig();
  const running = await startServerProcess(config);
  const subjects = config.natsUrl
    ? ahpNatsSubjects({
      namespace: config.natsNamespace,
      serverId: config.serverId,
      clientId: config.clientId,
    })
    : undefined;

  await running.ready;
  console.log(JSON.stringify({
    event: 'ahp-server.ready',
    natsUrl: config.natsUrl,
    subjects,
    grpcUnixSocket: config.grpcUnixSocket,
    storageDirectory: config.storageDirectory,
    providers: [
      ...(config.piAgentProvider ? ['pi-agent'] : []),
    ],
  }));

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    console.log(JSON.stringify({ event: 'ahp-server.stopping', signal }));
    await running.close();
  };
  process.once('SIGINT', signal => {
    void shutdown(signal);
  });
  process.once('SIGTERM', signal => {
    void shutdown(signal);
  });

  await running.closed;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ event: 'ahp-server.error', message }));
  process.exitCode = 1;
}
