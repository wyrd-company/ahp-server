---
title: 'AHP server initial direction: production-shaped Codex vertical slice over NATS'
tags:
  - architecture
  - ahp
  - codex-app-server
  - nats
  - adapters
lifecycle: permanent
createdAt: '2026-06-09T06:27:49.742Z'
updatedAt: '2026-06-09T06:58:24.793Z'
role: decision
alwaysLoad: false
project: github-com-wyrd-company-ahp-server
projectName: ahp-server
memoryVersion: 1
---
AHP server initial direction is production-shaped development toward an end-to-end demo using a real adapter, with Codex App Server as the first adapter and Pi Agent next.

Key decisions and constraints from Bob:

- First useful milestone is an end-to-end demo with a real adapter, preferably Codex App Server.
- The preferred demo path is `NATS client -> AHP server -> CAS Unix socket -> streamed Codex response -> NATS client`; integration tests using local sockets or websockets are acceptable if needed.
- Docker-out-of-docker is installed, and a NATS server can be run for validation by inspecting container IPs and adjusting networking as needed.
- Codex App Server proves the architecture first; Claude Agent SDK and Cursor SDK are expected to carry greater risk later.
- Intended package shape is a core `@wyrd-company/ahp-server` package with independent sibling adapter/plugin packages, though a monorepo/workspace spike is acceptable if it accelerates startup.
- If adapters will eventually move out, consider starting them in sibling repos from the beginning.
- The goal is a protocol-compliant TypeScript AHP server; reuse or port from the VS Code reference implementation only when useful.
- If the AHP protocol docs and VS Code reference behavior disagree, compatibility with the AHP TypeScript client is the tie-breaker.
- NATS is the priority client/transport for the designed system, though local/websocket transport can be used to speed testing and validation.
- MVP should be a vertical slice of the intended full protocol direction rather than a throwaway partial design.
- Initial deployment is a devcontainer or local Docker network accessed over NATS.io; remote/multi-tenant security is not the priority but should not be blocked by design.
- The Codex App Server adapter connects to an already-running Unix socket; it does not launch or own the CAS process initially.
- Initial state may be in-memory, but durable storage will be needed because devcontainers are rebuilt; storage will likely be bind-mounted or volume-mounted. Storage design is delegated to the implementer.
- Agent adapters should be independent plugins chosen by the user. Bob expects a devcontainer agent feature to install the AHP server with Codex, Claude, Cursor, and Pi Agent, and a separate container image running AHP server with Pi Agent.
- Explicit adapter imports and server wiring are acceptable and preferred for the first vertical slice; optional packages do not need runtime package discovery.
- NPM scope is `@wyrd-company`, for example `@wyrd-company/ahp-server`.
- Work should be production-shaped, with spike work permitted as needed in `/workspaces/worktrees/agent-control-plane/*`; this is a shared volume and other worktrees may exist.
- GitHub Project status does not need to be considered for this effort.

Implementation outcome on 2026-06-09:

- Added package scaffold for `@wyrd-company/ahp-server` with TypeScript build, typecheck, test, and verify scripts.
- Implemented a transport-agnostic AHP server core with in-memory session storage and explicit `AgentProvider` plugin wiring.
- Implemented the minimum AHP TypeScript-client-compatible surface: `initialize`, `ping`, snapshot `reconnect`, `subscribe`, `unsubscribe`, `listSessions`, `resolveSessionConfig`, `createSession`, `disposeSession`, `fetchTurns`, `completions`, and `dispatchAction`.
- Added a Codex App Server adapter boundary and socket client. CAS uses WebSocket text frames over a Unix socket and JSON-RPC-lite without `jsonrpc: "2.0"`; the adapter initializes CAS, starts a CAS thread per AHP session, maps AHP user turns to `turn/start`, and maps CAS text/completion notifications to AHP `session/responsePart`, `session/delta`, and `session/turnComplete` actions.
- Added NATS server/client transport adapters and initial subject convention: `<namespace>.server.<serverId>.client.<clientId>.to-server` and `.to-client`.
- Added tests against the published Microsoft AHP TypeScript client, a fake CAS client, and a fake NATS broker.
- `npm run verify` passed after implementation.
- Created local commits through `92d47b5 chore: simplify NATS transport publish path`; branch was ahead of origin and not pushed.
