---
title: AHP provider helper kit introduced
tags:
  - ahp
  - adapters
  - provider-abstraction
  - active-client-tools
  - cursor-sdk
  - claude-agent-sdk
  - pi-agent
  - codex-app-server
lifecycle: permanent
createdAt: '2026-06-11T02:31:46.134Z'
updatedAt: '2026-06-11T02:31:46.134Z'
role: summary
alwaysLoad: false
project: github-com-wyrd-company-ahp-server
projectName: ahp-server
memoryVersion: 1
---
AHP provider helper kit introduced in `ahp-server` on 2026-06-11.

Commit `d39459d` adds `src/provider-kit.ts` and exports shared provider-side helpers from the root package surface:

- `singleModelAgentInfo` for consistent one-model `AgentInfo` construction.
- `resolveModelId` and `uriToPath` for repeated session setup logic.
- `MarkdownTurnEmitter`, `markdownPart`, and `markdownPartId` for AHP markdown response part and delta emission.
- `ActiveClientToolRouter` for provider-side active-client tool state and `ActiveClientToolSink.reportInvocation` calls.

Built-in Codex App Server, Pi Agent, and Claude Agent SDK providers now use the helper kit where it fits. Claude keeps its Streamable HTTP MCP bridge for active-client tools because that is the provider-specific integration point.

The external `ahp-cursor-sdk` package consumes the helper kit through the public `@wyrd-company/ahp-server` root export in commit `1017d04`, proving optional provider packages can share this abstraction across the package boundary.

Validation: `npm run verify` passed in both `ahp-server` and `ahp-cursor-sdk`. Live Cursor SDK execution remains blocked by the upstream Cursor SDK local-agent validation bug, not by the abstraction.
