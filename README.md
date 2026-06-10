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
- A Pi Agent adapter that connects to OpenAI-compatible Chat Completions endpoints.
- A Claude Agent SDK adapter that streams Claude SDK turns through AHP sessions.
- File-backed AHP `resource*` commands constrained to configured local roots.
- Transport adapters provided by sibling packages, with TypeScript as the first implementation:
  - `@wyrd-company/ahp-nats` for NATS.io JSON-RPC text frames.
  - `@wyrd-company/ahp-grpc` for gRPC bidirectional streaming over Unix domain sockets.
- Gated live integration tests for real NATS, real CAS, real Pi/OpenCode Go, real Claude Agent SDK, resource commands, and packaged server-process paths.

The first target demo is:

```text
NATS client -> AHP server -> Codex App Server Unix socket -> streamed Codex response -> NATS client
```

The normal test suite validates the AHP client/server flow, CAS adapter mapping with a fake CAS client, and NATS subject routing with a fake in-process broker. Gated live tests validate against real services when endpoints are provided, including the packaged `ahp-server` process.

## Design Direction

The server is intended to be protocol-compliant with the Microsoft AHP TypeScript client as the compatibility tie-breaker. If protocol documentation and VS Code reference behavior disagree, this project follows the TypeScript client.

Adapters and transports are explicit packages. Users import optional packages and wire them into the server deliberately; runtime package discovery is not part of the first design. NATS and gRPC transports now live in sibling repos so their wire contracts can evolve toward multi-language implementations, with TypeScript as the initial implementation.

State can start in memory for tests and short-lived runs, or use `FileSystemSessionStore` to persist session state into a mounted directory across devcontainer rebuilds. Adapter runtime handles are intentionally not serialized; provider sessions are recreated by adapter/server wiring.

Security is scoped for local devcontainer/Docker-network use first. Remote and multi-tenant security are not implemented, but the transport and provider boundaries should not make that impossible later.

File resource commands only support `file://` URIs. They are constrained to `resourceRoots` in library mode, or `AHP_DEFAULT_DIRECTORY` in the packaged process. If no root is configured, the server process working directory is used. Existing targets are checked through `realpath` so symlinks cannot escape the allowed root.

## Implemented AHP Surface

The server currently implements the minimum useful session surface:

- `initialize`
- `ping`
- `reconnect` using snapshot fallback
- `subscribe`
- `unsubscribe`
- `listSessions`
- `resourceRead`
- `resourceWrite`
- `resourceList`
- `resourceCopy`
- `resourceDelete`
- `resourceMove`
- `resourceResolve`
- `resourceMkdir`
- `resolveSessionConfig`
- `createSession`
- `disposeSession`
- `fetchTurns`
- `completions`
- `dispatchAction`

`completions` currently returns an empty result. `resourceRequest` and `createResourceWatch` are not implemented yet.

Session output is streamed as AHP `action` notifications using:

- `session/responsePart`
- `session/delta`
- `session/turnComplete`
- `session/error`

Root session catalogue notifications are emitted for session add/remove/summary changes.

## Active-Client Tools

The server supports active-client tools as a provider-agnostic capability:

- `createSession.activeClient` seeds the provider session with the current active-client tool set.
- `session/activeClientToolsChanged` updates the provider session through the optional `AgentSession.setActiveClientTools` hook.
- Clearing the active client, disposing the session, or disconnecting the active client removes those tools from the provider session.
- Providers report active-client tool invocations through `AgentSessionContext.activeClientToolSink.reportInvocation`.
- The server emits `session/toolCallStart` and `session/toolCallReady` with `contributor: { kind: "client", clientId }`.
- The server owns trusted correlation for session URI, turn id, tool call id, tool name, and owning client id. Tool input is not trusted for those fields.
- `session/toolCallComplete`, `session/toolCallContentChanged`, and `session/toolCallResultConfirmed` are accepted only from the active client that owns the server-recorded tool call.

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

## gRPC Convention

The gRPC transport package exposes one bidirectional streaming RPC over a Unix domain socket:

```protobuf
service AhpTransport {
  rpc Connect(stream AhpFrame) returns (stream AhpFrame);
}

message AhpFrame {
  string text = 1;
}
```

Each `text` value is one UTF-8 JSON-RPC AHP frame. The canonical proto lives in `@wyrd-company/ahp-grpc` under `proto/wyrd/ahp/transport/v1/transport.proto`.

## Usage Sketch

### Packaged Process

The package exposes an `ahp-server` executable. The current process slice wires one filesystem store, one or more configured transports, and explicitly configured adapters.

```bash
NATS_URL=nats://nats:4222 \
CODEX_APP_SERVER_SOCKET=/tmp/ahp-cas/app-server-control.sock \
AHP_STORAGE_DIR=/workspace-storage/ahp-server \
AHP_NATS_NAMESPACE=ahp \
AHP_SERVER_ID=devcontainer-1 \
AHP_CLIENT_ID=client-1 \
ahp-server
```

For gRPC over a Unix domain socket:

```bash
AHP_GRPC_UNIX_SOCKET=/tmp/ahp-server/ahp.sock \
CLAUDE_AGENT_SDK_ENABLED=1 \
AHP_STORAGE_DIR=/workspace-storage/ahp-server \
ahp-server
```

NATS and gRPC can be enabled at the same time by setting both `NATS_URL` and `AHP_GRPC_UNIX_SOCKET`.

For Pi Agent / OpenAI-compatible Chat Completions:

```bash
NATS_URL=nats://nats:4222 \
PI_AGENT_PROVIDER=opencode-go \
OPENCODE_API_KEY=... \
PI_AGENT_MODEL=deepseek-v4-flash \
AHP_STORAGE_DIR=/workspace-storage/ahp-server \
ahp-server
```

For Claude Agent SDK:

```bash
NATS_URL=nats://nats:4222 \
CLAUDE_AGENT_SDK_ENABLED=1 \
CLAUDE_AGENT_SDK_MODEL=claude-sonnet-4-6 \
AHP_STORAGE_DIR=/workspace-storage/ahp-server \
ahp-server
```

Configuration:

- Configure at least one transport:
  - `NATS_URL` for the NATS transport.
  - `AHP_GRPC_UNIX_SOCKET` for the gRPC Unix domain socket transport. `AHP_GRPC_UDS_PATH` is accepted as an alias.
- Configure at least one provider:
  - Codex: `CODEX_APP_SERVER_SOCKET` or `CODEX_APP_SERVER_URL`.
  - Claude Agent SDK: `CLAUDE_AGENT_SDK_ENABLED=1`, or set `CLAUDE_AGENT_SDK_MODEL` / `CLAUDE_AGENT_SDK_EXECUTABLE`.
  - Pi Agent: `PI_AGENT_MODEL` and a provider key. `opencode-go` is the default `PI_AGENT_PROVIDER` and uses `OPENCODE_API_KEY`.
- `AHP_STORAGE_DIR` defaults to `.ahp-server`.
- `AHP_NATS_NAMESPACE` defaults to `ahp` when NATS is enabled.
- `AHP_SERVER_ID` defaults to `server` when NATS is enabled.
- `AHP_CLIENT_ID` defaults to `client` when NATS is enabled.
- `CODEX_DEFAULT_MODEL` defaults to `gpt-5.5`.
- `CLAUDE_AGENT_SDK_MODEL` is optional; when omitted, the Claude SDK uses its default model.
- `CLAUDE_AGENT_SDK_EXECUTABLE` optionally points at a Claude Code executable instead of the SDK bundled binary.
- `CLAUDE_AGENT_SDK_PERMISSION_MODE` defaults to `dontAsk`.
- `PI_AGENT_BASE_URL` is optional for built-in Pi providers. `opencode-go` defaults to `https://opencode.ai/zen/go/v1`.
- `PI_AGENT_API_KEY` can override the provider-specific key when testing custom OpenAI-compatible endpoints.
- `AHP_DEFAULT_DIRECTORY` optionally sets the AHP default directory and packaged-process resource root. Plain paths are converted to `file://` URIs.

When NATS is enabled, the process subscribes and publishes using the documented NATS subject convention for the configured server/client IDs. When gRPC is enabled, the process listens on the configured Unix socket and accepts one AHP client stream per gRPC `Connect` call.

### Library

```ts
import {
  AhpServer,
  FileSystemSessionStore,
  createCodexAppServerProvider,
  createClaudeAgentSdkProvider,
  createPiAgentProvider,
} from '@wyrd-company/ahp-server';
import {
  createNatsServerTransport,
  ahpNatsSubjects,
} from '@wyrd-company/ahp-nats';
import {
  createGrpcUdsServer,
} from '@wyrd-company/ahp-grpc';

const subjects = ahpNatsSubjects({
  serverId: 'devcontainer-1',
  clientId: 'client-1',
});

const server = new AhpServer({
  store: new FileSystemSessionStore({
    directory: '/workspace-storage/ahp-server',
  }),
  defaultDirectory: 'file:///workspace',
  resourceRoots: ['file:///workspace'],
  providers: [
    createCodexAppServerProvider({
      socketPath: '/path/to/codex-app-server.sock',
    }),
    createPiAgentProvider({
      baseUrl: 'https://opencode.ai/zen/go/v1',
      apiKey: process.env.OPENCODE_API_KEY!,
      defaultModel: 'deepseek-v4-flash',
    }),
    createClaudeAgentSdkProvider({
      defaultModel: 'claude-sonnet-4-6',
      permissionMode: 'dontAsk',
    }),
  ],
});

await server.accept(createNatsServerTransport({
  connection: natsConnection,
  inboundSubject: subjects.clientToServer,
  outboundSubject: subjects.serverToClient,
}));

const grpcServer = createGrpcUdsServer({
  socketPath: '/tmp/ahp-server/ahp.sock',
  onTransport: transport => {
    void server.accept(transport);
  },
});
await grpcServer.listen();
```

## Development

```bash
npm install
npm run verify
task live:vertical
task live:process
task live:pi
task live:claude
task live:resources
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

# Validate the packaged server process against Docker NATS and CAS over Unix socket.
task live:process

# Validate the Pi Agent adapter and packaged server process.
# The task loads .env from this repository root when present.
task live:pi

# Validate the Claude Agent SDK adapter and packaged server process.
# The task loads .env from this repository root when present.
task live:claude

# Validate packaged file resource commands over Docker NATS.
task live:resources

# .env example for Pi Agent live validation:
OPENCODE_API_KEY=...
PI_AGENT_MODEL=deepseek-v4-flash
# Optional overrides:
# PI_AGENT_PROVIDER=opencode-go
# PI_AGENT_BASE_URL=https://opencode.ai/zen/go/v1
# PI_AGENT_API_KEY=...

# .env example for Claude Agent SDK live validation:
CLAUDE_AGENT_SDK_ENABLED=1
# Optional:
# CLAUDE_AGENT_SDK_MODEL=claude-sonnet-4-6
# CLAUDE_AGENT_SDK_EXECUTABLE=/path/to/claude
# CLAUDE_AGENT_SDK_PERMISSION_MODE=dontAsk

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
- Pi Agent harness: `/workspaces/references/pi`
- Claude Agent SDK: `/workspaces/references/claude-agent-sdk-typescript`
- NATS TypeScript SDK: `/workspaces/references/nats.js`

## Planned Follow-Up

- Extract adapter packages into sibling repos if that remains the preferred package layout.
- Full Pi coding-agent runtime/RPC adapter if OpenAI-compatible chat completion is not enough for the desired workflow.
- Cursor SDK risk spike.
- A2A adapter where one A2A task maps to one AHP session.
