import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { test } from 'node:test';

import { AhpClient } from '@microsoft/agent-host-protocol/client';
import { connect } from '@nats-io/transport-node';
import {
  NatsAhpClientTransport,
  ahpNatsSubjects,
} from '@wyrd-company/ahp-nats';
import type { ContentEncoding } from '@microsoft/agent-host-protocol';

test('serves file resource commands through the packaged AHP server process over NATS', {
  skip: process.env.NATS_URL ? false : 'set NATS_URL to run live resource process validation',
  timeout: 60_000,
}, async () => {
  assert.ok(process.env.NATS_URL);
  const resourceRoot = mkdtempSync(join(tmpdir(), 'ahp-resource-process-root-'));
  const storageDirectory = mkdtempSync(join(tmpdir(), 'ahp-resource-process-store-'));
  const namespace = `ahp.live.resources.${Date.now()}`;
  const serverId = 'server';
  const clientId = 'client';
  const child = spawnServerProcess({
    AHP_CLIENT_ID: clientId,
    AHP_NATS_NAMESPACE: namespace,
    AHP_SERVER_ID: serverId,
    AHP_STORAGE_DIR: storageDirectory,
    AHP_DEFAULT_DIRECTORY: resourceRoot,
  });

  const clientConnection = await connect({ servers: process.env.NATS_URL, timeout: 2_000 });
  const subjects = ahpNatsSubjects({ namespace, serverId, clientId });
  const clientTransport = new NatsAhpClientTransport({
    connection: clientConnection,
    inboundSubject: subjects.serverToClient,
    outboundSubject: subjects.clientToServer,
  });
  const client = new AhpClient(clientTransport, { requestTimeoutMs: 10_000 });

  try {
    await waitForReady(child);
    await clientTransport.ready();
    client.connect();
    const init = await client.initialize({ clientId: 'live-resource-process-client', protocolVersions: ['0.3.0'] });
    assert.equal(init.defaultDirectory, pathToFileURL(resourceRoot).href);

    const dirUri = resourceUri(resourceRoot, 'workspace');
    const fileUri = resourceUri(resourceRoot, 'workspace/source.txt');
    const copyUri = resourceUri(resourceRoot, 'workspace/copy.txt');
    const movedUri = resourceUri(resourceRoot, 'workspace/moved.txt');

    await client.request('resourceMkdir', { channel: 'ahp-root://', uri: dirUri });
    await client.request('resourceWrite', {
      channel: 'ahp-root://',
      uri: fileUri,
      data: 'packaged resources',
      encoding: 'utf-8' as ContentEncoding,
    });
    const read = await client.request('resourceRead', {
      channel: 'ahp-root://',
      uri: fileUri,
      encoding: 'utf-8' as ContentEncoding,
    });
    assert.equal(read.data, 'packaged resources');

    await client.request('resourceCopy', { channel: 'ahp-root://', source: fileUri, destination: copyUri });
    await client.request('resourceMove', { channel: 'ahp-root://', source: copyUri, destination: movedUri });
    await client.request('resourceDelete', { channel: 'ahp-root://', uri: fileUri });
    assert.equal(readFileSync(filePath(resourceRoot, 'workspace/moved.txt'), 'utf8'), 'packaged resources');
  } finally {
    await client.shutdown().catch(() => undefined);
    await clientConnection.close();
    await stopServerProcess(child);
    rmSync(resourceRoot, { recursive: true, force: true });
    rmSync(storageDirectory, { recursive: true, force: true });
  }
});

function spawnServerProcess(extraEnv: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ['dist/src/cli.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...extraEnv,
    },
  });
}

async function waitForReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdout += String(chunk);
  });
  child.stderr.on('data', chunk => {
    stderr += String(chunk);
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    for (const line of stdout.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      const event = JSON.parse(line) as { event?: string };
      if (event.event === 'ahp-server.ready') {
        return;
      }
    }
    if (child.exitCode !== null) {
      throw new Error(`AHP server exited before ready with ${child.exitCode}: ${stderr}`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for AHP server ready. stdout=${stdout} stderr=${stderr}`);
}

async function stopServerProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  child.kill('SIGTERM');
  const stopped = await Promise.race([
    once(child, 'exit').then(() => true),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (stopped) {
    return;
  }
  child.kill('SIGKILL');
  await once(child, 'exit');
}

function resourceUri(root: string, relativePath: string): string {
  return pathToFileURL(filePath(root, relativePath)).href;
}

function filePath(root: string, relativePath: string): string {
  return join(root, ...relativePath.split('/'));
}
