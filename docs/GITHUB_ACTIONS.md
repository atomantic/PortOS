# GitHub Actions Workflows

PortOS uses a test-impact-aware CI workflow plus a release workflow that cannot
publish until the complete CI suite passes.

## Branch Strategy

| Branch | Purpose |
|--------|---------|
| `main` | Active development |
| `release` | Push `main` to `release` to trigger releases |

## CI Workflow (`ci.yml`)

PRs to `main`/`release` use `scripts/ci-test-plan.js` to classify the changed
files before installing dependencies. Directory-scoped features run their
server and client feature tests; flat modules fall back to Vitest's
import-graph-aware `--changed` mode. The planner deliberately chooses full CI
for shared composition roots, test configuration, dependency manifests,
workflow changes, unknown artifacts, or wide diffs.

A short always-run list (`ALWAYS_RUN_TESTS` in the planner) is added to every
plan, so no impact scope can drop it — currently
`server/services/taskPromptDefaults.test.js` (cross-install prompt-upgrade) and
`scripts/changelogFragments.test.js` (release-note fragment parse). A
documentation-only PR therefore still runs the server job with those files
selected.

The selected work is split across parallel jobs:

- **Server tests** — full, related, or explicit feature test files. Smoke-boots
  the server on the same job when server source changed (the smoke path uses the
  file backend under `NODE_ENV=test` and does not need Postgres). Always-run-only
  plans skip the native-addon rebuild.
- **Client tests and build** — affected client tests; production build whenever
  client source changed; client lint on the same install so Biome does not pay a
  second `npm ci`.
- **DB tests** — provisions only the isolated `portos_test` database and runs
  the serial DB suite when database-sensitive files changed.
- **Windows server tests** — the same server selection, but only on full CI
  (push to `main`, nightly, release, workflow dispatch) or when a
  Windows-sensitive surface changed (`.ps1` / `.cmd` spawn, PowerShell BOM,
  `bufferedSpawn`, `cos-runner`, shell/PM2, etc.). Docs-only and ordinary
  Linux-faithful PRs skip this job. `pinPlatform('win32')` tests still run on
  Linux.
- **lint** — historical required-check name. The real lint step lives in the
  client job; this job only mirrors that result.
- **CI Gate** — always reports one stable required-check result and fails if any
  selected job failed or was cancelled.

Targeted `files` / `related` plans run **one** Vitest process for the union of
planner-selected files and Vitest's `--changed` import graph. The two sets are
listed then merged — they cannot share one argv, because Vitest ANDs
`--changed` with path selectors.

No third-party change-filter action is used. The planner passes test paths as a
JSON argument array to `spawnSync`, never through shell interpolation.

### Full CI

The complete server, client, DB, lint, build, and smoke suite runs:

- after every push to `main`;
- nightly at 09:17 UTC;
- from manual workflow dispatch;
- as a reusable workflow called by every release.

Changes to CI/test configuration also force the full suite on their own PR.
`[skip ci]` remains honored for push events only; PR CI always runs.

### Impact-planner safety rules

- A directory feature such as `server/services/sprites/` selects tests carrying
  the same feature segment across server and client, plus every test Vitest's
  import graph relates to the changed files.
- Directly changed tests and co-located sibling tests are always included.
- Barrel/catalog guards are added when reusable `lib`, `hooks`, or `utils`
  directories change; JSX changes include the global accessibility convention
  guard.
- Database adapters, DB scripts, and relevant migrations add the complete
  serial DB suite.
- Unmapped executable files use related-test mode. Unclassified artifacts,
  shared roots/config, more than 30 executable changes, or more than 120
  selected tests fail safe to full CI.

## Release Workflow (`release.yml`)

Triggers on push to `release` branch. Steps:

1. Calls `ci.yml` with `full: true` and waits for the complete CI gate.
2. Reads version from `package.json`.
3. Checks if the git tag already exists (skips release creation if so).
4. Looks for a changelog file:
   - First: `.changelog/v{version}.md` (exact match)
   - Then: `.changelog/v{major}.{minor}.x.md` (pattern match, replaces placeholders)
   - Fallback: generates changelog from commit messages
5. Creates the GitHub release with tag `v{version}`.
6. If a pattern changelog file (`.changelog/v{major}.{minor}.x.md`) was used,
   archives it on `main` (renames `.x.md` to the exact version).
7. If the archive step ran, fast-forwards `release` to match `main`.

## Working with CI

### Skip CI

Add `[skip ci]` to push commit messages for generated documentation-only
changes. Auto-generated commits from the release workflow include this
automatically. Pull-request checks ignore this marker so a PR cannot bypass its
required CI gate.

### Force Full CI

Use the workflow-dispatch button for an immediate full run. A PR also chooses
full CI automatically when its impact cannot be classified safely.

### Rebase Before Push

Since CI may auto-commit changelog archives, always rebase before pushing:

```bash
git pull --rebase --autostash && git push
```

## Adapting for Sub-Projects

1. Copy `.github/workflows/ci.yml` and `.github/workflows/release.yml`
2. Update installation and build commands for your project structure
3. For monorepos, add package.json update steps for each workspace
4. Update the changelog file path pattern if different
