import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { test } from 'node:test';

import { AhpClient } from '@microsoft/agent-host-protocol/client';
import { connect } from '@nats-io/transport-node';
import type { Message, StateAction } from '@microsoft/agent-host-protocol';

import {
  NatsAhpClientTransport,
  ahpNatsSubjects,
} from '../src/index.js';

test('streams a live Claude Agent SDK turn through the packaged AHP server process', {
  skip: process.env.NATS_URL && claudeLiveEnabled()
    ? false
    : 'set NATS_URL and CLAUDE_AGENT_SDK_ENABLED=1 to run live Claude process validation',
  timeout: 180_000,
}, async () => {
  assert.ok(process.env.NATS_URL);
  const storageDirectory = mkdtempSync(join(tmpdir(), 'ahp-claude-process-'));
  const namespace = `ahp.live.claude.${Date.now()}`;
  const serverId = 'server';
  const clientId = 'client';
  const child = spawnServerProcess({
    AHP_CLIENT_ID: clientId,
    AHP_NATS_NAMESPACE: namespace,
    AHP_SERVER_ID: serverId,
    AHP_STORAGE_DIR: storageDirectory,
    PI_AGENT_BASE_URL: '',
    PI_AGENT_API_KEY: '',
    PI_AGENT_MODEL: '',
  });

  const clientConnection = await connect({ servers: process.env.NATS_URL, timeout: 2_000 });
  const subjects = ahpNatsSubjects({ namespace, serverId, clientId });
  const clientTransport = new NatsAhpClientTransport({
    connection: clientConnection,
    inboundSubject: subjects.serverToClient,
    outboundSubject: subjects.clientToServer,
  });
  const client = new AhpClient(clientTransport, { requestTimeoutMs: 10_000 });
  let sessionUri: string | undefined;

  try {
    await waitForReady(child);
    await clientTransport.ready();
    client.connect();
    await client.initialize({ clientId: 'live-claude-process-client', protocolVersions: ['0.3.0'] });

    sessionUri = `ahp-session:/live-claude-process-${Date.now()}`;
    await client.request('createSession', {
      channel: sessionUri,
      provider: 'claude-agent-sdk',
      workingDirectory: `file://${process.cwd()}`,
    });
    const { subscription } = await client.subscribe(sessionUri);
    client.dispatch(sessionUri, {
      type: 'session/turnStarted',
      turnId: 'live-claude-process-turn',
      message: userMessage(process.env.CLAUDE_AGENT_SDK_LIVE_TURN_PROMPT ?? 'Reply with exactly: pong'),
    } as StateAction);

    const actions = await collectUntilTerminal(subscription);
    const types = actions.map(action => String(action.type));
    assert.ok(types.includes('session/delta'), `expected streamed delta, saw: ${JSON.stringify(actions)}`);
    assert.ok(types.includes('session/turnComplete'), `expected turn completion, saw: ${JSON.stringify(actions)}`);
    assertPersistedCompletedTurn(storageDirectory);
  } finally {
    await client.shutdown().catch(() => undefined);
    await clientConnection.close();
    await stopServerProcess(child);
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

async function collectUntilTerminal(subscription: AsyncIterator<unknown>): Promise<StateAction[]> {
  const actions: StateAction[] = [];
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const next = await Promise.race([
      subscription.next(),
      new Promise<IteratorResult<never>>(resolve => setTimeout(
        () => resolve({ done: true, value: undefined as never }),
        1_000,
      )),
    ]);
    const value = next.value as { type?: string; params?: { action?: StateAction } };
    if (next.done || value.type !== 'action' || !value.params?.action) {
      continue;
    }
    actions.push(value.params.action);
    const type = value.params.action.type;
    if (type === 'session/turnComplete' || type === 'session/error') {
      break;
    }
  }
  return actions;
}

function assertPersistedCompletedTurn(storageDirectory: string): void {
  const sessionsDirectory = join(storageDirectory, 'sessions');
  const files = readdirSync(sessionsDirectory).filter(file => file.endsWith('.json'));
  assert.equal(files.length, 1);
  const parsed = JSON.parse(readFileSync(join(sessionsDirectory, files[0] ?? ''), 'utf8')) as {
    session?: {
      state?: {
        turns?: Array<{ state?: string }>;
      };
    };
  };
  assert.equal(parsed.session?.state?.turns?.[0]?.state, 'complete');
}

function claudeLiveEnabled(): boolean {
  return process.env.CLAUDE_AGENT_SDK_ENABLED === '1' || process.env.CLAUDE_AGENT_SDK_ENABLED === 'true';
}

function userMessage(text: string): Message {
  return {
    text,
    origin: { kind: 'user' as Message['origin']['kind'] },
  };
}
