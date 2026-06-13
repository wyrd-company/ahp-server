import type {
  AgentInfo,
  RootState,
  SessionState,
  SessionSummary,
  URI,
} from '@microsoft/agent-host-protocol';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { SessionStore, StoredSession } from './types.js';

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<URI, StoredSession>();

  constructor(private agents: AgentInfo[] = []) {}

  setAgents(agents: readonly AgentInfo[]): void {
    this.agents = [...agents];
  }

  getRootState(): RootState {
    return {
      agents: this.agents,
      activeSessions: this.sessions.size,
    };
  }

  listSessions(): SessionSummary[] {
    return [...this.sessions.values()].map(session => session.state.summary);
  }

  getSession(uri: URI): StoredSession | undefined {
    return this.sessions.get(uri);
  }

  addSession(session: StoredSession): void {
    this.sessions.set(session.uri, session);
  }

  removeSession(uri: URI): StoredSession | undefined {
    const existing = this.sessions.get(uri);
    if (existing) {
      this.sessions.delete(uri);
    }
    return existing;
  }

  updateSession(uri: URI, update: (session: StoredSession) => void): StoredSession {
    const session = this.sessions.get(uri);
    if (!session) {
      throw new Error(`session not found: ${uri}`);
    }
    update(session);
    return session;
  }
}

export interface FileSystemSessionStoreOptions {
  readonly directory: string;
  readonly agents?: readonly AgentInfo[];
}

interface PersistedSessionFile {
  readonly version: 1;
  readonly session: {
    readonly uri: URI;
    readonly state: SessionState;
    readonly providerResumeState?: StoredSession['providerResumeState'];
  };
}

export class FileSystemSessionStore implements SessionStore {
  private readonly sessions = new Map<URI, StoredSession>();
  private agents: AgentInfo[];

  constructor(private readonly options: FileSystemSessionStoreOptions) {
    this.agents = [...(options.agents ?? [])];
    mkdirSync(this.sessionsDirectory, { recursive: true, mode: 0o700 });
    this.loadSessions();
  }

  setAgents(agents: readonly AgentInfo[]): void {
    this.agents = [...agents];
  }

  getRootState(): RootState {
    return {
      agents: this.agents,
      activeSessions: this.sessions.size,
    };
  }

  listSessions(): SessionSummary[] {
    return [...this.sessions.values()].map(session => session.state.summary);
  }

  getSession(uri: URI): StoredSession | undefined {
    return this.sessions.get(uri);
  }

  addSession(session: StoredSession): void {
    this.sessions.set(session.uri, session);
    this.writeSession(session);
  }

  removeSession(uri: URI): StoredSession | undefined {
    const existing = this.sessions.get(uri);
    if (!existing) {
      return undefined;
    }
    this.sessions.delete(uri);
    rmSync(this.sessionPath(uri), { force: true });
    return existing;
  }

  updateSession(uri: URI, update: (session: StoredSession) => void): StoredSession {
    const session = this.sessions.get(uri);
    if (!session) {
      throw new Error(`session not found: ${uri}`);
    }
    update(session);
    this.writeSession(session);
    return session;
  }

  private get sessionsDirectory(): string {
    return join(this.options.directory, 'sessions');
  }

  private loadSessions(): void {
    if (!existsSync(this.sessionsDirectory)) {
      return;
    }
    for (const entry of readdirSync(this.sessionsDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }
      const path = join(this.sessionsDirectory, entry.name);
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as PersistedSessionFile;
      if (parsed.version !== 1) {
        throw new Error(`unsupported session store file version in ${path}`);
      }
      this.sessions.set(parsed.session.uri, {
        uri: parsed.session.uri,
        state: parsed.session.state,
        ...(parsed.session.providerResumeState !== undefined
          ? { providerResumeState: parsed.session.providerResumeState }
          : {}),
      });
    }
  }

  private writeSession(session: StoredSession): void {
    const file: PersistedSessionFile = {
      version: 1,
      session: {
        uri: session.uri,
        state: session.state,
        ...(session.providerResumeState !== undefined ? { providerResumeState: session.providerResumeState } : {}),
      },
    };
    const path = this.sessionPath(session.uri);
    const tempPath = `${path}.${process.pid}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    renameSync(tempPath, path);
  }

  private sessionPath(uri: URI): string {
    return join(this.sessionsDirectory, `${encodeFileName(uri)}.json`);
  }
}

function encodeFileName(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}
