---
title: AHP file resource command slice validated
tags:
  - resources
  - nats
  - validation
  - ahp
  - process
lifecycle: permanent
createdAt: '2026-06-10T05:30:06.167Z'
updatedAt: '2026-06-10T05:30:06.167Z'
role: summary
alwaysLoad: false
project: github-com-wyrd-company-ahp-server
projectName: ahp-server
memoryVersion: 1
---
AHP file resource command slice is implemented and validated.

On 2026-06-10, commit `4b4e35f` added file-backed handlers for these client-to-server AHP commands: `resourceRead`, `resourceWrite`, `resourceList`, `resourceCopy`, `resourceDelete`, `resourceMove`, `resourceResolve`, and `resourceMkdir`.

Validation passed:

- `task verify`: exercises the commands through the published AHP TypeScript client over in-memory transport, including nested `resourceMkdir`, write modes, read/list/resolve/copy/move/delete, stale `ifMatch` conflict handling, outside-root denial, and symlink escape denial.
- `task live:resources`: builds the package, starts Docker NATS when needed, launches packaged `dist/src/cli.js`, and validates resource commands over real NATS.

Resource security model: only `file://` URIs are supported. Library mode can pass `resourceRoots`; packaged process uses `AHP_DEFAULT_DIRECTORY` as both default directory and resource root. If no root is configured, the process working directory is used. Existing targets are checked through `realpath` so symlinks cannot escape allowed roots.

Not implemented in this slice: `resourceRequest` and `createResourceWatch`.
