#!/usr/bin/env node
import { readServerProcessConfig } from './process/config.js';
import { startServerProcess } from './process/run.js';
import { ahpNatsSubjects } from './nats/subjects.js';

try {
  const config = readServerProcessConfig();
  const running = await startServerProcess(config);
  const subjects = ahpNatsSubjects({
    namespace: config.natsNamespace,
    serverId: config.serverId,
    clientId: config.clientId,
  });

  await running.ready;
  console.log(JSON.stringify({
    event: 'ahp-server.ready',
    natsUrl: config.natsUrl,
    subjects,
    storageDirectory: config.storageDirectory,
    providers: [
      ...(config.codexAppServerSocket || config.codexAppServerUrl ? ['codex'] : []),
      ...(config.claudeAgentSdkConfigured ? ['claude-agent-sdk'] : []),
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
