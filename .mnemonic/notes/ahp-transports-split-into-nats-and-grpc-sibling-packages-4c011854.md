---
title: AHP transports split into NATS and gRPC sibling packages
tags:
  - ahp
  - transport
  - nats
  - grpc
lifecycle: permanent
createdAt: '2026-06-10T14:13:40.647Z'
updatedAt: '2026-06-10T14:13:40.647Z'
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
