# Agent Host Protocol (AHP) Server

Production-shaped TypeScript implementation of a stand-alone
[Agent Host Protocol](https://github.com/microsoft/agent-host-protocol) server.

The package target is `@wyrd-company/ahp-server`.

## Current Scope

This repository contains the AHP server core and packaged server process:

- A transport-agnostic AHP server core.
- Compatibility tests against the published `@microsoft/agent-host-protocol` TypeScript client.
- In-memory and filesystem-backed session stores behind a `SessionStore` interface.
- A pluggable `AgentProvider` interface for optional agent adapters.
- File-backed AHP `resource*` commands constrained to configured local roots.
- Transport adapters are provided by sibling packages, with TypeScript as the first implementation:
  - `@wyrd-company/ahp-nats` for NATS.io JSON-RPC text frames.
  - `@wyrd-company/ahp-grpc` for gRPC bidirectional streaming over Unix domain sockets.
- Optional provider adapters are published as sibling packages and are imported by host applications deliberately. Use `@wyrd-company/ahp-codex-app-server`, `@wyrd-company/ahp-claude-agent-sdk`, `@wyrd-company/ahp-cursor-sdk`, or `@wyrd-company/ahp-pi-agent` when wiring those runtimes.
- Gated live integration tests for real NATS, resource commands, and packaged server-process paths.

The normal test suite validates the AHP client/server flow, active-client tool routing, resource commands, packaged process behavior, and NATS/gRPC transport wiring.

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
- `reportInvocation` resolves with the owning client's `session/toolCallComplete` result so provider runtimes can return tool output to their native tool-call flow.
- The server owns trusted correlation for session URI, turn id, tool call id, tool name, and owning client id. Tool input is not trusted for those fields.
- `session/toolCallComplete`, `session/toolCallContentChanged`, and `session/toolCallResultConfirmed` are accepted only from the active client that owns the server-recorded tool call.
- Optional provider packages map active-client tools to provider-specific tool surfaces, such as Streamable HTTP MCP or runtime-native tool APIs.

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

The package exposes an `ahp-server` executable. The current process slice wires one filesystem store and one or more configured transports. It does not load provider adapters; host applications compose providers explicitly in library mode.

For gRPC over a Unix domain socket:

```bash
AHP_GRPC_UNIX_SOCKET=/tmp/ahp-server/ahp.sock \
AHP_STORAGE_DIR=/workspace-storage/ahp-server \
ahp-server
```

NATS and gRPC can be enabled at the same time by setting both `NATS_URL` and `AHP_GRPC_UNIX_SOCKET`.

Configuration:

- Configure at least one transport:
  - `NATS_URL` for the NATS transport.
  - `AHP_GRPC_UNIX_SOCKET` for the gRPC Unix domain socket transport. `AHP_GRPC_UDS_PATH` is accepted as an alias.
- `AHP_STORAGE_DIR` defaults to `.ahp-server`.
- `AHP_NATS_NAMESPACE` defaults to `ahp` when NATS is enabled.
- `AHP_SERVER_ID` defaults to `server` when NATS is enabled.
- `AHP_CLIENT_ID` defaults to `client` when NATS is enabled.
- `AHP_DEFAULT_DIRECTORY` optionally sets the AHP default directory and packaged-process resource root. Plain paths are converted to `file://` URIs.

When NATS is enabled, the process subscribes and publishes using the documented NATS subject convention for the configured server/client IDs. When gRPC is enabled, the process listens on the configured Unix socket and accepts one AHP client stream per gRPC `Connect` call.

### Library

```ts
import {
  AhpServer,
  FileSystemSessionStore,
  createInProcessAhpClientTransport,
} from '@wyrd-company/ahp-server';
import { createClaudeAgentSdkProvider } from '@wyrd-company/ahp-claude-agent-sdk';
import { createPiCodingAgentProvider } from '@wyrd-company/ahp-pi-agent';
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
    createPiCodingAgentProvider(),
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

const inProcess = createInProcessAhpClientTransport(server);

// Pass `inProcess.transport` to an in-process AHP client, such as an A2A
// adapter running in the same host process. The application still owns the
// server, providers, and external AHP transports.
```

Transport symbols are intentionally imported from `@wyrd-company/ahp-nats` and `@wyrd-company/ahp-grpc`; `@wyrd-company/ahp-server` does not re-export transport packages.

## Development

```bash
npm install
npm run verify
task live:resources
```

`npm run verify` runs:

- TypeScript typecheck
- Node test suite
- Build

Live validation is opt-in because it requires external processes and model access:

```bash
# Validate packaged file resource commands over Docker NATS.
task live:resources

# Start NATS in Docker and discover its container IP.
docker run -d --name ahp-server-nats-validation nats:2.10-alpine -js
docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ahp-server-nats-validation

# Validate AHP over real NATS.
NATS_URL=nats://<container-ip>:4222 node --test --import tsx test/nats-live.test.ts
```

## References

- AHP protocol and TypeScript client: `/workspaces/references/agent-host-protocol`
- VS Code reference AHP server: `/workspaces/references/vscode/src/vs/platform/agentHost/node`
- Pi Agent harness: `/workspaces/references/pi`
- Claude Agent SDK: `/workspaces/references/claude-agent-sdk-typescript`
- NATS TypeScript SDK: `/workspaces/references/nats.js`

## Planned Follow-Up

- Extract remaining built-in adapter packages into sibling repos.
- Full Pi coding-agent runtime/RPC adapter if OpenAI-compatible chat completion is not enough for the desired workflow.
- Cursor SDK risk spike.
