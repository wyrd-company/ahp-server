---
title: Cursor SDK adapter spike reached credential-gated validation
tags:
  - ahp
  - cursor-sdk
  - spike
lifecycle: permanent
createdAt: '2026-06-10T13:51:05.403Z'
updatedAt: '2026-06-10T13:51:05.403Z'
role: research
alwaysLoad: false
project: github-com-wyrd-company-ahp-server
projectName: ahp-server
memoryVersion: 1
---
# Cursor SDK adapter spike reached credential-gated validation

On 2026-06-10, the Cursor SDK risk spike was committed on branch `spike/cursor-sdk` at commit `a40e56d` in `/workspaces/worktrees/spikes/ahp-cursor-sdk-spike`.

The spike installed `@cursor/sdk@1.0.18`, added `scripts/spike-cursor-sdk.ts`, and documented findings in `docs/spikes/cursor-sdk.md`. The public SDK surface supports the adapter shape needed by AHP: `Agent.create()`, `agent.send()`, `run.stream()`, `run.wait()`, `run.cancel()` when supported, and `agent[Symbol.asyncDispose]()`.

Validation results: `task verify` passed. Running the spike without `CURSOR_API_KEY` fails cleanly before SDK use. Running with a dummy key reaches Cursor authentication during `Agent.create()` and fails with `AuthenticationError`, `status: 401`, `operation: Agent.create`, proving a real Cursor API key is required before live local-run validation can proceed.

Important packaging observation: `@cursor/sdk` brings native optional packages and `sqlite3`, so the production adapter should remain an explicit optional adapter boundary rather than silently increasing core server dependency weight.
