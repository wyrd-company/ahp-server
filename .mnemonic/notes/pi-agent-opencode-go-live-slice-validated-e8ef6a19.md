---
title: Pi Agent OpenCode Go live slice validated
tags:
  - pi-agent
  - opencode-go
  - nats
  - validation
  - ahp
lifecycle: permanent
createdAt: '2026-06-10T03:47:40.841Z'
updatedAt: '2026-06-10T03:47:40.841Z'
role: summary
alwaysLoad: false
project: github-com-wyrd-company-ahp-server
projectName: ahp-server
memoryVersion: 1
---
Pi Agent OpenCode Go live slice is validated over AHP and real NATS.

On 2026-06-10, `task live:pi` passed using the repository `.env` with `OPENCODE_API_KEY` and `PI_AGENT_MODEL=deepseek-v4-flash`. The task built the package, started Docker NATS when `NATS_URL` was absent, and ran both live tests:

- `test/pi-agent-live.test.ts`: in-process AHP server with Pi adapter streamed a turn successfully.
- `test/pi-agent-process-live.test.ts`: packaged `dist/src/cli.js` server process streamed a Pi turn over real NATS and persisted the completed turn.

Commit `13ad1f8` aligned the Pi slice with Pi's native OpenCode Go provider convention: default `PI_AGENT_PROVIDER=opencode-go`, default base URL `https://opencode.ai/zen/go/v1`, `OPENCODE_API_KEY` support, and `PI_AGENT_API_KEY` as an override for custom OpenAI-compatible endpoints.
