# macOS “Install out of sync” research

Point-in-time primary-source review on 2026-09-03. This note distinguishes the
documented install/update path from two separate stale-build defects.

## Bottom line

- A fresh, minimal supported install is `npm run setup` followed by `npm start`.
  `npm start` builds the client before starting PM2. `./setup.sh` is the optional
  guided alternative, not an additional required step
  ([README.md:291-309](../../README.md#L291-L309)).
- A managed reconcile is supposed to run the full platform update script. That
  script installs all workspaces, runs setup and migrations, builds the client,
  and restarts PortOS ([update.sh:185-219](../../update.sh#L185-L219),
  [update.sh:293-317](../../update.sh#L293-L317),
  [update.sh:335-340](../../update.sh#L335-L340)).
- There was a real, platform-independent bug in **Apps → PortOS → Git → Update
  app**: it restarted without rebuilding `client/dist`. It was fixed upstream on
  2026-09-02 by [PR #5823](https://github.com/atomantic/PortOS/pull/5823).
- `.DS_Store` was already recognized elsewhere as macOS metadata: it is ignored
  by Git ([.gitignore:39-41](../../.gitignore#L39-L41)) and explicitly excluded
  from backup snapshot enumeration
  ([server/services/backup.js:522-532](../../server/services/backup.js#L522-L532)).
  However, upstream `installState` freshness detection does not consult Git and
  has no `.DS_Store` exclusion as of upstream commit `878468a9c`.

## What the freshness detector actually measures

Issue [#1779](https://github.com/atomantic/PortOS/issues/1779) introduced the
warning on 2026-06-29 to detect a half-update after `git pull` without
`./update.sh`. Its five signals are running-code drift, dependency receipts,
client build time, pending migrations, and submodule drift
([server/services/installState.js:1-28](../../server/services/installState.js#L1-L28)).

The root-file scan was deliberately widened in commit
[`4147b077f`](https://github.com/atomantic/PortOS/commit/4147b077f13b95f0ad2d68a989c05678ff2d18c8)
from three named files to **every file directly under `client/`**, while also
walking `src/` and `public/`. The current upstream implementation uses raw
`readdir`/`stat`; it excludes only the `node_modules`, `dist`, and `.git`
directories. Consequently `.gitignore` has no effect on this calculation
([upstream source at `878468a9c`](https://github.com/atomantic/PortOS/blob/878468a9c7d70d360f44c6ce044dfd68c224cda6/server/services/installState.js#L109-L149)).

**Conclusion:** freshness should inspect actual client build inputs, not merely
Git-tracked files. Untracked files under `src/`/`public/` can affect a Vite build,
and Git-ignored `.env*` files are also Vite inputs
([official Vite env documentation](https://vite.dev/guide/env-and-mode.html#env-files)).
A blanket “ignore every ignored/untracked file” change would therefore create
false negatives. The sound boundary is to exclude known non-input metadata such
as `.DS_Store`, while continuing to inspect real build inputs.

## What most likely caused the reported warning

There are three evidence-backed possibilities, in descending operational
priority:

1. **Known updater defect.** If the source was updated through the managed App
   Git tab before PR #5823 was present, that path omitted the production build.
   The PR description names the exact result: `client/dist` stayed older and
   PortOS immediately reported “Install out of sync.” The fix is already merged
   into upstream and is present in the currently fetched fork `main` history as
   commit [`ff7d35682`](https://github.com/atomantic/PortOS/commit/ff7d35682f4359a0cbb9a0939c329a0aa5b7f306).
2. **Feature-branch reconciliation.** The documented updater always switches to
   `main` before pulling, building, and restarting; dirty feature-branch work is
   stashed and deliberately not restored
   ([docs/SELF_UPDATE.md:17-34](../SELF_UPDATE.md#L17-L34)). Therefore a detector
   patch that exists only on a feature branch cannot fix a warning by clicking
   Reconcile: the reconciliation boots `main`, where that patch is absent.
3. **Finder metadata newer than the build.** If `/api/update/status` identifies
   `staleBuild` as the only active signal and `.DS_Store` is the only file newer
   than `client/dist/index.html`, the upstream raw filesystem scan necessarily
   reports stale even though the build is valid. No upstream issue or merged PR
   found since 2026-08-31 adds an install-freshness `.DS_Store` exclusion; the
   relevant official search result is instead the separate managed-updater fix,
   PR #5823.

A fourth, display-only edge exists: the global banner hook sets out-of-sync state
when its one mount-time status request returns true, but does not clear that
state from a later in-sync response
([client/src/hooks/useUpdateChecker.jsx:38-64](../../client/src/hooks/useUpdateChecker.jsx#L38-L64)).
The normal successful reconcile path reloads the page, so this explains a stale
banner only when that reload did not happen or the browser kept the old session.

## Operational reading

Use the detailed reasons on **Apps → PortOS → Update**, or the
`installState` object from `GET /api/update/status`, before changing code:

- `staleBuild` after a managed App update on old code: update to a revision that
  contains PR #5823, then run the documented reconcile/update path once.
- only `staleBuild`, with the full reconcile completing successfully: identify
  the newest filesystem entry; `.DS_Store` is a detector false positive, while
  `src/`, `public/`, config, or `.env*` is a real rebuild input.
- any other signal: follow that signal (dependencies, migration, boot commit, or
  submodule) rather than treating it as a macOS metadata problem.

For post-install configuration, the maintained walkthrough is also available at
**Settings → Setup** ([README.md:311-324](../../README.md#L311-L324)).
