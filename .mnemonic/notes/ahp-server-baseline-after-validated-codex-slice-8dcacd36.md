---
title: AHP server baseline after validated Codex slice
tags:
  - validation
  - storage
  - ahp
lifecycle: permanent
createdAt: '2026-06-09T15:20:31.011Z'
updatedAt: '2026-06-09T15:20:31.011Z'
role: summary
alwaysLoad: false
project: github-com-wyrd-company-ahp-server
projectName: ahp-server
memoryVersion: 1
---
AHP server now has a repeatable production-shaped baseline after the validated Codex vertical slice.

Commits:

- `245891c` added `Taskfile.yml`, `scripts/validate-live-vertical.sh`, and `npm run test:live:vertical`. The live task starts Docker NATS and Codex App Server over a private Unix socket when endpoints are not supplied, runs `test/live-vertical-slice.test.ts`, and cleans up.
- `8e8e1a1` added `FileSystemSessionStore`, exported it from the package root, persisted session state as JSON under a mounted directory, and routed server session reducer writes through `SessionStore.updateSession` so durable stores receive lifecycle and turn updates.
- `b8cb908` changed provider startup failures to reject `createSession` while still publishing `session/creationFailed`, and added compatibility coverage for completed-turn `fetchTurns` behavior.

Validation on June 9, 2026:

- `task verify` passed: typecheck, local tests, and build.
- `task live:vertical` passed against a real Docker NATS broker plus a real Codex App Server Unix socket using model `gpt-5.5`.
