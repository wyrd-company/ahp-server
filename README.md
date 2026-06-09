# Agent Host Protocol (AHP) Server

Production-shaped TypeScript implementation of a stand-alone
[Agent Host Protocol](https://github.com/microsoft/agent-host-protocol) server.

The package target is `@wyrd-company/ahp-server`.

## Current Scope

This repository currently contains the first vertical-slice implementation:

- A transport-agnostic AHP server core.
- Compatibility tests against the published `@microsoft/agent-host-protocol` TypeScript client.
- In-memory and filesystem-backed session stores behind a `SessionStore` interface.
- A pluggable `AgentProvider` interface for optional agent adapters.
- A Codex App Server adapter that connects to CAS using WebSocket JSON-RPC-lite over a Unix socket.
- NATS transport adapters for both the server side and the TypeScript AHP client side.
- Gated live integration tests for real NATS, real CAS, and the combined NATS -> AHP -> CAS -> NATS path.

The first target demo is:

```text
NATS client -> AHP server -> Codex App Server Unix socket -> streamed Codex response -> NATS client
```

The normal test suite validates the AHP client/server flow, CAS adapter mapping with a fake CAS client, and NATS subject routing with a fake in-process broker. Gated live tests validate against real services when endpoints are provided.

## Design Direction

The server is intended to be protocol-compliant with the Microsoft AHP TypeScript client as the compatibility tie-breaker. If protocol documentation and VS Code reference behavior disagree, this project follows the TypeScript client.

Adapters are explicit plugins. Users import optional packages and wire them into the server deliberately; runtime package discovery is not part of the first design. The code is currently colocated in this repo to keep context close, but the boundaries are shaped so `ahp-codex-app-server`, `ahp-nats`, and later adapters can move to sibling packages.

State can start in memory for tests and short-lived runs, or use `FileSystemSessionStore` to persist session state into a mounted directory across devcontainer rebuilds. Adapter runtime handles are intentionally not serialized; provider sessions are recreated by adapter/server wiring.

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
- Can also connect to a CAS WebSocket URL for validation and non-target local deployments.
- Sends `initialize`, then `initialized`.
- Creates a CAS thread for each AHP session via `thread/start`.
- Sends user turns via `turn/start`.
- Maps `item/agentMessage/delta` to AHP markdown response parts and deltas.
- Maps `turn/completed` to `session/turnComplete`.
- Responds to unknown CAS server requests with method-not-found.

When starting CAS over a Unix socket, place the socket under a private directory such as `/tmp/ahp-cas` with mode `700`. Codex secures the socket parent directory and will fail if asked to use a shared directory directly, such as `unix:///tmp/app-server-control.sock`.

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
  FileSystemSessionStore,
  createCodexAppServerProvider,
  createNatsServerTransport,
  ahpNatsSubjects,
} from '@wyrd-company/ahp-server';

const subjects = ahpNatsSubjects({
  serverId: 'devcontainer-1',
  clientId: 'client-1',
});

const server = new AhpServer({
  store: new FileSystemSessionStore({
    directory: '/workspace-storage/ahp-server',
  }),
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
task live:vertical
```

`npm run verify` runs:

- TypeScript typecheck
- Node test suite
- Build

Live validation is opt-in because it requires external processes and, for the full CAS turn, model access:

```bash
# Preferred repeatable full validation. Starts Docker NATS and CAS over Unix socket
# when NATS_URL and CODEX_APP_SERVER_URL/CODEX_APP_SERVER_SOCKET are not supplied.
task live:vertical

# Start NATS in Docker and discover its container IP.
docker run -d --name ahp-server-nats-validation nats:2.10-alpine -js
docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ahp-server-nats-validation

# Start a real Codex App Server over WebSocket.
codex app-server --listen ws://127.0.0.1:43123

# Or start CAS over a Unix socket. Use a private directory; Codex secures the socket
# directory and will fail if asked to chmod a shared directory such as /tmp.
mkdir -p /tmp/ahp-cas
chmod 700 /tmp/ahp-cas
codex app-server --listen unix:///tmp/ahp-cas/app-server-control.sock

# Validate AHP over real NATS.
NATS_URL=nats://<container-ip>:4222 node --test --import tsx test/nats-live.test.ts

# Validate AHP backed by real CAS.
CODEX_APP_SERVER_URL=ws://127.0.0.1:43123 CODEX_E2E_MODEL=gpt-5.5 \
  CODEX_LIVE_TURN_PROMPT='Reply with exactly: pong' \
  node --test --import tsx test/codex-live.test.ts

# Or validate against CAS over Unix socket.
CODEX_APP_SERVER_SOCKET=/tmp/ahp-cas/app-server-control.sock CODEX_E2E_MODEL=gpt-5.5 \
  CODEX_LIVE_TURN_PROMPT='Reply with exactly: pong' \
  node --test --import tsx test/codex-live.test.ts

# Validate the full vertical slice.
NATS_URL=nats://<container-ip>:4222 CODEX_APP_SERVER_URL=ws://127.0.0.1:43123 \
  CODEX_E2E_MODEL=gpt-5.5 CODEX_LIVE_TURN_PROMPT='Reply with exactly: pong' \
  node --test --import tsx test/live-vertical-slice.test.ts

# Or validate the full vertical slice over NATS + CAS Unix socket.
NATS_URL=nats://<container-ip>:4222 CODEX_APP_SERVER_SOCKET=/tmp/ahp-cas/app-server-control.sock \
  CODEX_E2E_MODEL=gpt-5.5 CODEX_LIVE_TURN_PROMPT='Reply with exactly: pong' \
  node --test --import tsx test/live-vertical-slice.test.ts
```

## References

- AHP protocol and TypeScript client: `/workspaces/references/agent-host-protocol`
- VS Code reference AHP server: `/workspaces/references/vscode/src/vs/platform/agentHost/node`
- Codex App Server protocol: `/workspaces/references/codex/codex-rs/app-server-protocol`
- Codex App Server Rust client: `/workspaces/references/codex/codex-rs/app-server-client`
- NATS TypeScript SDK: `/workspaces/references/nats.js`

## Planned Follow-Up

- Durable filesystem-backed session/event storage.
- Extract adapter packages into sibling repos if that remains the preferred package layout.
- Pi Agent adapter.
- Claude Agent SDK and Cursor SDK risk spikes.
- A2A adapter where one A2A task maps to one AHP session.
