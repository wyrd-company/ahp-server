---
title: AHP provider adapters persist provider-native resume state
tags:
  - ahp
  - resume
  - provider-abstraction
  - adapters
  - npm
  - release
lifecycle: permanent
createdAt: '2026-06-13T23:24:27.109Z'
updatedAt: '2026-06-14T00:06:23.982Z'
role: summary
alwaysLoad: false
project: github-com-wyrd-company-ahp-server
projectName: ahp-server
memoryVersion: 1
---
AHP resume now includes provider-native durable resume state, not only AHP wrapper reconstruction.

Published releases:

- `@wyrd-company/ahp-provider-kit@0.3.0`
- `@wyrd-company/ahp-server@0.3.0`
- `@wyrd-company/ahp-codex-app-server@0.3.0`
- `@wyrd-company/ahp-claude-agent-sdk@0.3.0`
- `@wyrd-company/ahp-pi-agent@0.4.0`
- `@wyrd-company/ahp-pi-coding-agent@0.3.0`
- `@wyrd-company/ahp-cursor-sdk@0.3.0`

The provider-kit contract added `ProviderResumeState`, `ResumableAgentSessionContext.resumeState`, and optional `AgentSession.getResumeState()`. `ahp-server` persists the provider-owned resume-state blob in `FileSystemSessionStore`, passes it into `resumeSession`, and refreshes it after create, resume, and each turn.

Provider-native behavior:

- Codex App Server stores CAS `threadId` and resumes with `thread/resume`.
- Claude Agent SDK stores SDK `session_id` and resumes with `options.resume`.
- Pi Agent stores Pi `sessionId` and passes it back through `AgentOptions.sessionId`.
- Pi Coding Agent stores Pi `sessionFile` and `sessionId`, then resumes with `SessionManager.open(sessionFile)`; if only a session id is available, it creates a session manager with that id.
- Cursor SDK stores local Cursor `agentId` and resumes with `Agent.resume(agentId, ...)`.

Known caveat: adapters do not replay a half-streamed provider run after process death. They preserve the native provider session/thread/agent identity for subsequent turns. Cursor live local validation remains blocked by the upstream Cursor SDK free-user local model validation bug; fake-runtime tests cover the adapter path.
