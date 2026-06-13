---
title: AHP transports split into NATS and gRPC sibling packages
tags:
  - ahp
  - transport
  - nats
  - grpc
lifecycle: permanent
createdAt: '2026-06-10T14:13:40.647Z'
updatedAt: '2026-06-13T17:08:13.517Z'
role: summary
alwaysLoad: false
project: github-com-wyrd-company-ahp-server
projectName: ahp-server
memoryVersion: 1
---
# AHP transports split into NATS and gRPC sibling packages

On 2026-06-10, the AHP transport slice moved transport implementations out of `ahp-server` and into sibling repos:

- `/workspaces/agent-control-plane/ahp-nats` commit `f75545e` added `@wyrd-company/ahp-nats`, a TypeScript NATS transport package.
- `/workspaces/agent-control-plane/ahp-nats` commit `2b4b67d` preserved the original NATS subject-token validation behavior.
- `/workspaces/agent-control-plane/ahp-grpc` commit `219d4ea` added `@wyrd-company/ahp-grpc`, a TypeScript gRPC-over-Unix-domain-socket transport package with proto contract `proto/wyrd/ahp/transport/v1/transport.proto`.
- `/workspaces/agent-control-plane/ahp-server` commit `f12ea8e` switched the server to consume the sibling packages via local file dependencies and added gRPC/multi-transport process support.

The server process now accepts at least one configured transport: `NATS_URL`, `AHP_GRPC_UNIX_SOCKET`, or both. NATS and gRPC clients can connect to the same `AhpServer` instance simultaneously.

Validation completed: `task verify` passed in `ahp-nats`, `ahp-grpc`, and `ahp-server`. `task live:resources` passed in `ahp-server`, exercising the packaged server process over a real Docker NATS broker after the package split.

## Transport Contract And NATS V3 Consolidation

On 2026-06-11 the AHP/A2A transport stack was consolidated in two committed phases.

Phase 1 adopted the upstream `@microsoft/agent-host-protocol/client` transport contract. Commits: `8030437` in `ahp-grpc`, `71557aa` in `ahp-nats`, `750b08a` in `ahp-server`, and `f67c69c` in `a2a-ahp`. The local `ServerTransport` name remains only as a compatibility type alias to upstream `AhpTransport`; duplicate JSON-RPC transport declarations were removed. `ahp-server` now consumes `TransportFrame` and explicitly handles `parsed`, `text`, and `binary` frames by decoding binary as UTF-8 JSON. gRPC and NATS bindings continue to emit text frames because their AHP wire payload is JSON text bytes. `createInMemoryTransportPair` remains as a compatibility helper but delegates to upstream `InMemoryTransport.pair()`. The `a2a-ahp` in-process adapter no longer uses `asAhpTransport`.

Phase 2 migrated AHP NATS usage to `@nats-io/transport-node` v3. Commits: `3c3a3dc` in `ahp-nats` and `5aa1098` in `ahp-server`. `nats` v2 was removed from both package manifests and lockfiles. `StringCodec` was replaced with direct `TextEncoder` and `TextDecoder` usage. `ahp-nats` now matches `a2a-nats`'s `NatsConnectionLike` / `NatsMsgLike` / `NatsRequestOptions` shape exactly, while keeping `MsgLike` as a backward-compatible alias; the definitions remain separate to avoid coupling the two sibling transport packages through a shared runtime dependency.

Validation passed: `npm run verify` in `ahp-grpc`, `ahp-nats`, `ahp-server`, `a2a-nats`, and `a2a-ahp`. Live NATS validation also passed against a temporary Docker NATS broker for `ahp-server` `test/nats-live.test.ts` and `a2a-nats` `test/nats-docker.test.ts`, including JetStream and KV tests.## Server Transport Re-Export RemovedOn 2026-06-13, `ahp-server` commit `21566ef` removed the `./nats` and `./grpc` package subpath exports and deleted the `src/nats/index.ts` and `src/grpc/index.ts` re-export shims. Consumers now import transport symbols directly from `@wyrd-company/ahp-nats` and `@wyrd-company/ahp-grpc` when composing an AHP host. The packaged server process still composes those transport packages internally, but the core server package no longer presents them as part of its public library barrel.Validation passed after the cleanup: `npm run verify` in `ahp-server`, `ahp-nats`, and `ahp-grpc`; `npm pack --dry-run` in `ahp-server` confirmed the package no longer includes `dist/src/nats` or `dist/src/grpc`. Live NATS tests in `ahp-server` were skipped because `NATS_URL` was not set.
