---
title: Packaged AHP server process slice validated
tags:
  - process
  - validation
  - codex
  - ahp
lifecycle: permanent
createdAt: '2026-06-10T03:19:18.136Z'
updatedAt: '2026-06-10T03:19:18.136Z'
role: summary
alwaysLoad: false
project: github-com-wyrd-company-ahp-server
projectName: ahp-server
memoryVersion: 1
---
The packaged AHP server process slice is implemented and validated.

Commits:

- `5fc407a` adds the runnable `ahp-server` process foundation: env-derived config, NATS connection, `FileSystemSessionStore`, Codex App Server provider wiring, package `bin`, and corrected package exports pointing to `dist/src`.
- `b5370ac` fixes a live reducer compatibility bug: Codex CAS turn IDs must not replace the AHP client turn ID in emitted AHP session actions. The server now passes the AHP turn ID into `AgentSession.sendUserMessage`, and the Codex adapter uses CAS turn IDs only for backend cancellation/tracking.
- `48c21e4` adds `task live:process`, `scripts/validate-live-server-process.sh`, and `test/server-process-live.test.ts`. The live test launches `dist/src/cli.js` as a child process, drives it over real NATS with the TypeScript AHP client, streams a real Codex turn through CAS over Unix socket, and verifies filesystem storage recorded a completed turn.

Validation on June 10, 2026:

- `task verify` passed.
- `task live:process` passed against Docker NATS plus Codex App Server over a private Unix socket using model `gpt-5.5`.

Operational note: the process slice currently supports one configured NATS route (`AHP_NATS_NAMESPACE`, `AHP_SERVER_ID`, `AHP_CLIENT_ID`) and one Codex provider. This matches the current subject convention and is sufficient for the devcontainer feature baseline.
