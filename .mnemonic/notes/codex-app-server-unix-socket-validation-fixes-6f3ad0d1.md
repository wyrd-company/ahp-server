---
title: Codex App Server Unix socket validation fixes
tags:
  - codex
  - unix-socket
  - validation
lifecycle: permanent
createdAt: '2026-06-09T15:09:38.555Z'
updatedAt: '2026-06-09T15:09:38.555Z'
role: summary
alwaysLoad: false
project: github-com-wyrd-company-ahp-server
projectName: ahp-server
memoryVersion: 1
---
Codex App Server Unix socket validation now works for AHP server when two conditions are met.

Evidence from June 9, 2026 validation:

- `codex app-server --listen unix:///tmp/...` failed because Codex prepares the socket parent as a private directory and attempted `chmod("/tmp", 0700)`, which fails for non-root users.
- Starting CAS under a private directory such as `/tmp/ahp-cas/app-server-control.sock` with parent mode `0700` succeeds.
- The Node `ws` client default permessage-deflate offer made Codex's Unix socket `tokio_tungstenite::accept_async` path close the connection with `incorrect header sec-websocket-extensions`; setting `perMessageDeflate: false` fixes the handshake.
- After disabling compression, the direct CAS Unix socket request passed, `test/codex-live.test.ts` passed over `CODEX_APP_SERVER_SOCKET`, and `test/live-vertical-slice.test.ts` passed over Docker NATS plus CAS Unix socket using model `gpt-5.5`.

Commit `9e9d746` implemented the client fix and README live-validation instructions.
