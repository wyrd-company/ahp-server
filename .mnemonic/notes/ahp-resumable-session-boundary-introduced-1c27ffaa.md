---
title: AHP resumable session boundary introduced
tags:
  - ahp
  - resume
  - provider-abstraction
  - storage
lifecycle: permanent
createdAt: '2026-06-13T22:57:28.618Z'
updatedAt: '2026-06-13T22:57:28.618Z'
role: summary
alwaysLoad: false
project: github-com-wyrd-company-ahp-server
projectName: ahp-server
memoryVersion: 1
---
AHP resumable session support now uses `@wyrd-company/ahp-provider-kit@0.2.0` as the provider-facing contract boundary.

`ResumableAgentProvider.resumeSession(context)` receives trusted persisted AHP `SessionState` plus recovered working directory, model, config values, active-client tools, and the server-owned active-client tool sink. `ahp-server@0.2.0` lazily attempts resume for persisted sessions during `initialize` initial subscriptions, `reconnect`, `subscribe`, and before processing a new turn. Reconnect/subscribe still return persisted snapshots if a provider cannot resume; a subsequent turn emits `session/error` with `errorType: "provider.resumeSession"`.

Validated with filesystem-backed restart tests covering successful provider resume and unsupported provider fallback.
