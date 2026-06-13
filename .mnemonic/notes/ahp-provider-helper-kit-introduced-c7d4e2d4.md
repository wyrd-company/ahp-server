---
title: AHP provider helper kit introduced
tags:
  - ahp
  - adapters
  - provider-abstraction
  - provider-kit
  - npm
  - release
  - codex-app-server
  - cursor-sdk
lifecycle: permanent
createdAt: '2026-06-11T02:31:46.134Z'
updatedAt: '2026-06-13T03:15:03.661Z'
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

Validation: `npm run verify` passed in both `ahp-server` and `ahp-cursor-sdk`. Live Cursor SDK execution remains blocked by the upstream Cursor SDK local-agent validation bug, not by the abstraction.## Extracted to Shared PackageOn 2026-06-12, the provider helper kit was extracted from `ahp-server` into the sibling repo `/workspaces/agent-control-plane/ahp-provider-kit` as package `@wyrd-company/ahp-provider-kit`.Commits:\* `ahp-provider-kit` `31ee407` adds the shared provider/session contract and helper utilities.

- `ahp-codex-app-server` `b729b86` adds the extracted Codex App Server provider package, depending on `@wyrd-company/ahp-provider-kit`.
- `ahp-server` `bfe4546` re-exports the extracted Codex package for compatibility and re-exports provider-kit through its existing `provider-kit` subpath.The extraction avoids a circular dependency by making providers depend on `@wyrd-company/ahp-provider-kit` rather than `@wyrd-company/ahp-server`. `ahp-server` can then depend on extracted provider packages for compatibility/process wiring without those providers depending back on the server package.Validation run:\* `ahp-provider-kit`: `npm run verify` passed.
- `ahp-codex-app-server`: `npm run verify` passed; live CAS validation skipped without `CODEX_APP_SERVER_URL` or `CODEX_APP_SERVER_SOCKET`.
- `ahp-server`: `npm run verify` passed; local tests passed and live tests skipped where environment variables were absent.

## npm Publish Preparation And Plugin Cut

On 2026-06-13, the AHP package set was prepared for npm publishing via semver tag workflows without `v` prefixes.

Package commits:

- `ahp-provider-kit` `2c040d9` adds public npm publish workflow and packaging cleanup.
- `ahp-grpc` `fba34da` adds public npm publish workflow and packaging cleanup.
- `ahp-nats` `41b2b2d` adds public npm publish workflow and packaging cleanup.
- `ahp-server` `860ec2d` cuts the Codex provider out of the server package, removes the `./codex-app-server` export and Codex process wiring/tests/scripts, switches internal Wyrd dependencies to semver, and adds public npm publish workflow.
- `ahp-codex-app-server` `5b895c4` switches from local `file:` references to semver dependencies and adds public npm publish workflow.
- `ahp-cursor-sdk` `6c2ce31` switches provider helper imports to `@wyrd-company/ahp-provider-kit`, removes the obsolete AHP transport wrapper in tests, switches from local `file:` references to semver dependencies, and adds public npm publish workflow.
Policy encoded in workflows:
- Trigger on pushed tags matching `*.*.*`, then validate the tag is semver without a leading `v`.
- Require the tag to exactly match `package.json` version.
- Run `npm install`, `npm run verify`, `npm pack --dry-run`, then `npm publish --access public --provenance` with `NODE_AUTH_TOKEN` from `secrets.NPM_TOKEN`.
- Use `publishConfig.access = "public"` in scoped package manifests.
- Use `prepack = npm run clean && npm run build` to avoid stale `dist` artifacts in tarballs.
- Narrow package `files` to `dist/src` (plus `proto` for `ahp-grpc`) so compiled tests are not published.
First publish order should be: `ahp-provider-kit`, `ahp-grpc`, `ahp-nats`, `ahp-server`, `ahp-codex-app-server`, then `ahp-cursor-sdk`. A2A packages were explicitly out of scope because they are being handled separately.
