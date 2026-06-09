export interface AhpNatsSubjectOptions {
  readonly namespace?: string;
  readonly serverId: string;
  readonly clientId: string;
}

export interface AhpNatsSubjectPair {
  readonly clientToServer: string;
  readonly serverToClient: string;
}

export function ahpNatsSubjects(options: AhpNatsSubjectOptions): AhpNatsSubjectPair {
  const namespace = sanitizeToken(options.namespace ?? 'ahp');
  const serverId = sanitizeToken(options.serverId);
  const clientId = sanitizeToken(options.clientId);
  return {
    clientToServer: `${namespace}.server.${serverId}.client.${clientId}.to-server`,
    serverToClient: `${namespace}.server.${serverId}.client.${clientId}.to-client`,
  };
}

function sanitizeToken(value: string): string {
  const token = value.trim().replaceAll(/[^A-Za-z0-9_-]/g, '_');
  if (!token) {
    throw new Error('NATS subject token cannot be empty');
  }
  return token;
}

