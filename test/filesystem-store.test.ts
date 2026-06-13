import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { SessionState } from '@microsoft/agent-host-protocol';

import { FileSystemSessionStore } from '../src/index.js';

test('persists session state across store instances', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ahp-store-'));
  try {
    const state = sessionState('ahp-session:/persisted');
    const store = new FileSystemSessionStore({ directory });
    store.addSession({ uri: state.summary.resource, state });

    store.updateSession(state.summary.resource, session => {
      session.state = {
        ...session.state,
        lifecycle: 'ready' as SessionState['lifecycle'],
        summary: {
          ...session.state.summary,
          title: 'Persisted Session',
        },
      };
    });

    const reloaded = new FileSystemSessionStore({ directory });
    const restored = reloaded.getSession(state.summary.resource);
    assert.ok(restored);
    assert.equal(restored.state.lifecycle, 'ready');
    assert.equal(restored.state.summary.title, 'Persisted Session');
    assert.equal(reloaded.listSessions().length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('persists provider-native resume state across store instances', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ahp-store-'));
  try {
    const state = sessionState('ahp-session:/provider-resume');
    const store = new FileSystemSessionStore({ directory });
    store.addSession({
      uri: state.summary.resource,
      state,
      providerResumeState: { threadId: 'native-thread-1' },
    });

    store.updateSession(state.summary.resource, session => {
      session.providerResumeState = { threadId: 'native-thread-2' };
    });

    const reloaded = new FileSystemSessionStore({ directory });
    const restored = reloaded.getSession(state.summary.resource);
    assert.ok(restored);
    assert.deepEqual(restored.providerResumeState, { threadId: 'native-thread-2' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('removes persisted session files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ahp-store-'));
  try {
    const state = sessionState('ahp-session:/removed');
    const store = new FileSystemSessionStore({ directory });
    store.addSession({ uri: state.summary.resource, state });
    assert.ok(store.removeSession(state.summary.resource));

    const reloaded = new FileSystemSessionStore({ directory });
    assert.equal(reloaded.getSession(state.summary.resource), undefined);
    assert.equal(reloaded.listSessions().length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function sessionState(uri: string): SessionState {
  const now = Date.now();
  return {
    summary: {
      resource: uri,
      provider: 'test',
      title: 'New Session',
      status: 1,
      createdAt: now,
      modifiedAt: now,
    },
    lifecycle: 'creating',
    turns: [],
  } as SessionState;
}
