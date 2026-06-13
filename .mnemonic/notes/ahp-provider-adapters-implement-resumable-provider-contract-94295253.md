---
title: AHP provider adapters implement resumable provider contract
tags:
  - ahp
  - resume
  - provider-abstraction
  - adapters
  - npm
  - release
lifecycle: permanent
createdAt: '2026-06-13T23:24:27.109Z'
updatedAt: '2026-06-13T23:24:27.109Z'
role: summary
alwaysLoad: false
project: github-com-wyrd-company-ahp-server
projectName: ahp-server
memoryVersion: 1
---
All first-party AHP provider adapters now implement the `ResumableAgentProvider` contract from `@wyrd-company/ahp-provider-kit@0.2.0`.

Published releases:

- `@wyrd-company/ahp-codex-app-server@0.2.0`
- `@wyrd-company/ahp-claude-agent-sdk@0.2.0`
- `@wyrd-company/ahp-pi-agent@0.3.0`
- `@wyrd-company/ahp-pi-coding-agent@0.2.0`
- `@wyrd-company/ahp-cursor-sdk@0.2.0`

Each adapter has a filesystem-backed restart test proving `ahp-server@0.2.0` can reconnect to a persisted AHP session, call the provider resume hook, and process a new turn through the reconstructed runtime session.

Resume guarantee: adapters restore the AHP provider runtime from persisted AHP session context. Native transcript or same-provider-session continuity depends on provider-specific durable state. Pi Agent preserves the AHP session URI as Pi `sessionId`; Pi Coding can use durable Pi session options supplied by consumers. Codex, Claude, and Cursor currently reconstruct runtime sessions but do not persist private native thread/query/run state.
