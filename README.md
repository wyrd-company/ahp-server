# Agent Host Protocol (AHP) Server

Production-shaped TypeScript implementation of the
[Agent Host Protocol](https://github.com/microsoft/agent-host-protocol) server.

The package target is `@wyrd-company/ahp-server`.

## Current Scope

This repository contains the AHP server library core:

- A transport-agnostic AHP server core.
- Compatibility tests against the published `@microsoft/agent-host-protocol` TypeScript client.
- In-memory and filesystem-backed session stores behind a `SessionStore` interface.
- A pluggable `AgentProvider` interface for optional agent adapters.
- File-backed AHP `resource*` commands constrained to configured local roots.
- Transport adapters are provided by sibling packages, with TypeScript as the first implementation:
  - `@wyrd-company/ahp-nats` for NATS.io JSON-RPC text frames.
  - `@wyrd-company/ahp-grpc` for gRPC bidirectional streaming over Unix domain sockets.
- Optional provider adapters are published as sibling packages and are imported by host applications deliberately. Use `@wyrd-company/ahp-codex-app-server`, `@wyrd-company/ahp-claude-agent-sdk`, `@wyrd-company/ahp-cursor-sdk`, or `@wyrd-company/ahp-pi-agent` when wiring those runtimes.

The normal test suite validates the AHP client/server flow, multiple simultaneous client transports, active-client tool routing, resource commands, and session storage.

## Design Direction

The server is intended to be protocol-compliant with the Microsoft AHP TypeScript client as the compatibility tie-breaker. If protocol documentation and VS Code reference behavior disagree, this project follows the TypeScript client.

Adapters and transports are explicit packages. Users import optional packages and wire them into the server deliberately; runtime package discovery is not part of the first design. NATS and gRPC transports now live in sibling repos so their wire contracts can evolve toward multi-language implementations, with TypeScript as the initial implementation.

State can start in memory for tests and short-lived runs, or use `FileSystemSessionStore` to persist session state into a mounted directory across devcontainer rebuilds. Adapter runtime handles are intentionally not serialized; provider sessions are recreated by adapter/server wiring.

Security is scoped for local devcontainer/Docker-network use first. Remote and multi-tenant security are not implemented, but the transport and provider boundaries should not make that impossible later.

File resource commands only support `file://` URIs. They are constrained to `resourceRoots`. If no root is configured, the current process working directory is used. Existing targets are checked through `realpath` so symlinks cannot escape the allowed root.

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

## Transport Packages

`@wyrd-company/ahp-server` does not include a CLI and does not re-export transport packages. Host applications import the transports they need and pass their `AhpTransport` instances to `AhpServer.accept(...)`.

The NATS transport package uses this subject convention:

```text
<namespace>.server.<serverId>.client.<clientId>.to-server
<namespace>.server.<serverId>.client.<clientId>.to-client
```

The default namespace is `ahp`. Subject tokens are sanitized to NATS-safe token text by `@wyrd-company/ahp-nats`.

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

### User-Owned Host

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
import { connect } from '@nats-io/transport-node';

const natsConnection = await connect({ servers: process.env.NATS_URL });

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
- Pi Agent harness: `/workspaces/references/pi`
- Claude Agent SDK: `/workspaces/references/claude-agent-sdk-typescript`

## Planned Follow-Up

- Remove the temporary `./provider-kit` compatibility re-export once consumers import `@wyrd-company/ahp-provider-kit` directly.
- Create a separate reference host or CLI package if a reusable executable becomes useful.
