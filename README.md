# Agent Host Protocol (AHP) Server

Production-shaped TypeScript implementation of a stand-alone
[Agent Host Protocol](https://github.com/microsoft/agent-host-protocol) server.

The package target is `@wyrd-company/ahp-server`.

## Current Scope

This repository currently contains the first vertical-slice implementation:

- A transport-agnostic AHP server core.
- Compatibility tests against the published `@microsoft/agent-host-protocol` TypeScript client.
- An in-memory session store behind a `SessionStore` interface.
- A pluggable `AgentProvider` interface for optional agent adapters.
- A Codex App Server adapter that connects to CAS using WebSocket JSON-RPC-lite over a Unix socket.
- NATS transport adapters for both the server side and the TypeScript AHP client side.

The first target demo is:

```text
NATS client -> AHP server -> Codex App Server Unix socket -> streamed Codex response -> NATS client
```

The current tests validate the AHP client/server flow, CAS adapter mapping with a fake CAS client, and NATS subject routing with a fake in-process broker. A live CAS/NATS end-to-end validation is still future work.

## Design Direction

The server is intended to be protocol-compliant with the Microsoft AHP TypeScript client as the compatibility tie-breaker. If protocol documentation and VS Code reference behavior disagree, this project follows the TypeScript client.

Adapters are explicit plugins. Users import optional packages and wire them into the server deliberately; runtime package discovery is not part of the first design. The code is currently colocated in this repo to keep context close, but the boundaries are shaped so `ahp-codex-app-server`, `ahp-nats`, and later adapters can move to sibling packages.

Initial state is in memory. Durable storage is expected later because devcontainers are rebuilt; the storage boundary already exists so a filesystem-backed event/session store can replace the in-memory store.

Security is scoped for local devcontainer/Docker-network use first. Remote and multi-tenant security are not implemented, but the transport and provider boundaries should not make that impossible later.

## Implemented AHP Surface

The server currently implements the minimum useful session surface:

- `initialize`
- `ping`
- `reconnect` using snapshot fallback
- `subscribe`
- `unsubscribe`
- `listSessions`
- `resolveSessionConfig`
- `createSession`
- `disposeSession`
- `fetchTurns`
- `completions`
- `dispatchAction`

Session output is streamed as AHP `action` notifications using:

- `session/responsePart`
- `session/delta`
- `session/turnComplete`
- `session/error`

Root session catalogue notifications are emitted for session add/remove/summary changes.

## Codex App Server Adapter

CAS uses WebSocket text frames over a Unix domain socket. Its protocol is JSON-RPC-like but intentionally omits `jsonrpc: "2.0"`.

The adapter:

- Connects to an already-running CAS Unix socket.
- Sends `initialize`, then `initialized`.
- Creates a CAS thread for each AHP session via `thread/start`.
- Sends user turns via `turn/start`.
- Maps `item/agentMessage/delta` to AHP markdown response parts and deltas.
- Maps `turn/completed` to `session/turnComplete`.
- Responds to unknown CAS server requests with method-not-found.

## NATS Convention

The initial subject convention is:

```text
<namespace>.server.<serverId>.client.<clientId>.to-server
<namespace>.server.<serverId>.client.<clientId>.to-client
```

The default namespace is `ahp`. Subject tokens are sanitized to NATS-safe token text.

## Usage Sketch

```ts
import {
  AhpServer,
  createCodexAppServerProvider,
  createNatsServerTransport,
  ahpNatsSubjects,
} from '@wyrd-company/ahp-server';

const subjects = ahpNatsSubjects({
  serverId: 'devcontainer-1',
  clientId: 'client-1',
});

const server = new AhpServer({
  providers: [
    createCodexAppServerProvider({
      socketPath: '/path/to/codex-app-server.sock',
    }),
  ],
});

await server.accept(createNatsServerTransport({
  connection: natsConnection,
  inboundSubject: subjects.clientToServer,
  outboundSubject: subjects.serverToClient,
}));
```

## Development

```bash
npm install
npm run verify
```

`npm run verify` runs:

- TypeScript typecheck
- Node test suite
- Build

## References

- AHP protocol and TypeScript client: `/workspaces/references/agent-host-protocol`
- VS Code reference AHP server: `/workspaces/references/vscode/src/vs/platform/agentHost/node`
- Codex App Server protocol: `/workspaces/references/codex/codex-rs/app-server-protocol`
- Codex App Server Rust client: `/workspaces/references/codex/codex-rs/app-server-client`
- NATS TypeScript SDK: `/workspaces/references/nats.js`

## Planned Follow-Up

- Live NATS validation against a real NATS server.
- Live CAS validation against an already-running Codex App Server Unix socket.
- Durable filesystem-backed session/event storage.
- Extract adapter packages into sibling repos if that remains the preferred package layout.
- Pi Agent adapter.
- Claude Agent SDK and Cursor SDK risk spikes.
- A2A adapter where one A2A task maps to one AHP session.

