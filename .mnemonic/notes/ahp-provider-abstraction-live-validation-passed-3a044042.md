---
title: AHP provider abstraction live validation passed
tags:
  - ahp
  - validation
  - provider-abstraction
  - codex-app-server
  - claude-agent-sdk
  - pi-agent
  - a2a-ahp
lifecycle: permanent
createdAt: '2026-06-11T02:33:47.567Z'
updatedAt: '2026-06-11T02:33:47.567Z'
role: summary
alwaysLoad: false
project: github-com-wyrd-company-ahp-server
projectName: ahp-server
memoryVersion: 1
---
AHP provider abstraction live validation passed on 2026-06-11 after introducing the provider helper kit.

Validated from `/workspaces/agent-control-plane/ahp-server`:

- `npm run verify` passed: 22 non-live tests passed, 9 live tests skipped by gates, typecheck and build passed.
- `npm run test:live:vertical` passed: live Codex App Server over live NATS broker.
- `npm run test:live:process` passed: packaged AHP server process streaming a live Codex App Server turn.
- `npm run test:live:pi` passed: live Pi Agent OpenAI-compatible turn and packaged AHP server process turn.
- `CLAUDE_AGENT_SDK_ENABLED=1 npm run test:live:claude` passed: live Claude Agent SDK turn and packaged AHP server process turn.

The sibling `/workspaces/agent-control-plane/a2a-ahp` bridge project was also checked after installing dependencies locally: `npm run verify` passed with 17 tests, typecheck, and build. Its worktree already had uncommitted/untracked project files and was not committed by this pass.

Conclusion: `ahp-server` is ready for `a2a-ahp` to begin integration testing against the current local server package/API, with Cursor SDK remaining the only provider on upstream hold.
