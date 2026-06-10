---
title: Claude Agent SDK live slice validated
tags:
  - claude-agent-sdk
  - nats
  - validation
  - ahp
  - adapters
lifecycle: permanent
createdAt: '2026-06-10T03:59:57.044Z'
updatedAt: '2026-06-10T03:59:57.044Z'
role: summary
alwaysLoad: false
project: github-com-wyrd-company-ahp-server
projectName: ahp-server
memoryVersion: 1
---
Claude Agent SDK adapter slice is implemented and validated over AHP and real NATS.

On 2026-06-10, `CLAUDE_AGENT_SDK_ENABLED=1 task live:claude` passed. The task built the package, started Docker NATS when `NATS_URL` was absent, and ran both live tests:

- `test/claude-agent-sdk-live.test.ts`: in-process AHP server with the Claude Agent SDK adapter streamed a turn successfully.
- `test/claude-agent-sdk-process-live.test.ts`: packaged `dist/src/cli.js` server process streamed a Claude turn over real NATS and persisted the completed turn.

Commits:

- `cf6298e` adds the `@anthropic-ai/claude-agent-sdk` dependency.
- `1d181c5` adds the Claude Agent SDK adapter, process env wiring, `task live:claude`, unit tests, live tests, and README updates.

The adapter is configured in the process with `CLAUDE_AGENT_SDK_ENABLED=1`; optional env includes `CLAUDE_AGENT_SDK_MODEL`, `CLAUDE_AGENT_SDK_EXECUTABLE`, and `CLAUDE_AGENT_SDK_PERMISSION_MODE`.
