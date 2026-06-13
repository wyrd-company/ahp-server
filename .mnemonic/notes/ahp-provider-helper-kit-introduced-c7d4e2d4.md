---
title: AHP provider helper kit introduced
tags:
  - ahp
  - adapters
  - provider-abstraction
  - provider-kit
  - npm
  - release
  - github-packages
  - github-actions
  - codex-app-server
  - cursor-sdk
  - claude-agent-sdk
lifecycle: permanent
createdAt: '2026-06-11T02:31:46.134Z'
updatedAt: '2026-06-13T03:54:26.394Z'
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

## Dual Registry Publishing And GitHub Releases

Also on 2026-06-13, the semver-tag publish workflows were updated to publish each package to both npmjs and GitHub Packages, then create a GitHub Release with generated notes.

Workflow commits:

- `ahp-provider-kit` `1895432`
- `ahp-grpc` `d13e91e`
- `ahp-nats` `1f5108b`
- `ahp-server` `181de74`
- `ahp-codex-app-server` `93bc276`
- `ahp-cursor-sdk` `84d5893`
  The workflows now require `contents: write`, `packages: write`, and `id-token: write`; publish to npmjs with `NPM_TOKEN` and provenance; switch the registry to `https://npm.pkg.github.com` and publish to GitHub Packages with `GITHUB_TOKEN`; then run `gh release create "$GITHUB_REF_NAME" --generate-notes` with a release title of `<package-name>@<version>`. Bob confirmed `NPM_TOKEN` is org-wide and plans to switch npmjs packages to trusted publishing after the first push.

## Workflow Naming Preference

Bob prefers the package release workflow file to be named `.github/workflows/cd.yml` with workflow display name `CD`. On 2026-06-13, the AHP package publish workflows were renamed accordingly.

Rename commits:

- `ahp-provider-kit` `ad58b3e`
- `ahp-grpc` `c4858d9`
- `ahp-nats` `38be716`
- `ahp-server` `96573b4`
- `ahp-codex-app-server` `312866b`
- `ahp-cursor-sdk` `db2d734`

## Claude Agent SDK Provider Extracted

On 2026-06-13, the Claude Agent SDK adapter was extracted from `ahp-server` into the sibling repo `/workspaces/agent-control-plane/ahp-claude-agent-sdk` as package `@wyrd-company/ahp-claude-agent-sdk`.

Commits:

- `ahp-claude-agent-sdk` `aca3246` adds the provider package, Streamable HTTP MCP active-client tool bridge, unit/live tests, package metadata, and `CD` semver-tag publishing workflow for npmjs, GitHub Packages, and GitHub Releases.
- `ahp-server` `a4be15d` removes the built-in Claude provider, `./claude-agent-sdk` export, Claude process wiring, Claude live scripts/tests, and stale Claude/MCP runtime dependencies from the core server package.

The extracted package depends on `@wyrd-company/ahp-provider-kit` for provider/session contracts and helper utilities, and keeps `@wyrd-company/ahp-server` as a peer/dev dependency only for tests and host integration.

Validation run:

- `ahp-server`: `npm run verify` passed and `npm pack --dry-run` succeeded.
- `ahp-claude-agent-sdk`: `npm run verify` passed and `npm pack --dry-run` succeeded.
- `ahp-claude-agent-sdk`: `npm run test:live` was executed after sourcing `ahp-server/.env`; the test skipped because `CLAUDE_AGENT_SDK_ENABLED` was not set.

After this cut, `ahp-server` packaged process wiring only includes the built-in Pi Agent provider. Claude can still be wired in library mode by importing `createClaudeAgentSdkProvider` from `@wyrd-company/ahp-claude-agent-sdk`.
