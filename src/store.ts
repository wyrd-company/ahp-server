import type {
  AgentInfo,
  RootState,
  SessionSummary,
  URI,
} from '@microsoft/agent-host-protocol';

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

