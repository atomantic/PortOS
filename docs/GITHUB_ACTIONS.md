# GitHub Actions Workflows

PortOS uses a test-impact-aware CI workflow plus a release workflow that cannot
publish until the complete CI suite has passed on the exact tree being released.

## Where the suite actually runs

Every change reaches `main` through a pull request, and `main` reaches
`release` through a pull request, so the suite runs once per gate rather than
once per event:

| Event | What runs |
|-------|-----------|
| PR into `main` | Impact-scoped plan (only the surfaces the diff touches) |
| Push/merge to `main` | **Nothing** — no push trigger; the PR gate already passed |
| PR `main` → `release` | **Full suite**, forced regardless of the diff |
| Push/merge to `release` | Reuses the release PR's green gate; full suite only if it cannot be verified |
| Nightly 09:17 UTC | Full suite — the `main`-branch health signal |
| `workflow_dispatch` | Full suite |

A release therefore pays for one full run (on its PR), not three.

## Branch Strategy

| Branch | Purpose |
|--------|---------|
| `main` | Active development |
| `release` | Merge `main` into `release` to trigger releases |

## CI Workflow (`ci.yml`)

PRs into `main` use `scripts/ci-test-plan.js` to classify the changed files
before installing dependencies. Directory-scoped features run their server and
client feature tests; flat modules fall back to Vitest's import-graph-aware
`related` mode, fed the changed behavioral source paths plus the planner's
explicit test files. The planner deliberately chooses full CI for shared
composition roots, test configuration, dependency manifests, workflow changes,
unknown artifacts, or wide diffs.

PRs into `release` skip the planner entirely and force the full suite: that PR
is the single gate a release ships behind.

An always-run list (`ALWAYS_RUN_TESTS` in the planner) is added to every plan,
so no impact scope can drop it. A documentation-only PR therefore still runs the
server job with those files selected. Two kinds of test qualify:

- **Cross-install contract snapshots** — `server/services/taskPromptDefaults.test.js`
  pins the prompt-upgrade contract, and nothing else in the suite notices when
  it breaks.
- **Repo-hygiene guards that enumerate the tracked tree** with `git grep` /
  `git ls-files` and assert over files they never import. Impact selection is
  import-graph-driven, so it has no edge that can reach them — the violating
  file is always some *other* file the guard sees only as a path string. Left
  off the list they are structurally unselectable and can sit red on `main`
  while every PR reports green (issue #5055).

`scripts/repo-scan-guards.test.js` keeps the second half honest: it re-derives
the scanner set from the tree and fails when a new scanner is added without
being registered, either in `ALWAYS_RUN_TESTS` or in its own
`STRUCTURALLY_SELECTED` map naming the selector that already reaches it.

### Vitest runner tuning

On GitHub Actions, `CI=true` caps the server Vitest runner at `maxWorkers: 4`
(`scripts/vitestCiPool.js`, spread into `server/vitest.config.js` and
`client/vitest.config.js`). Standard Linux runners for public repositories are
[4 vCPU / 16GB](https://docs.github.com/en/actions/reference/runners/github-hosted-runners);
uncapped forks oversubscribe those cores during transform. Local `npm test`
is unbounded. The jsdom-heavy client retains its proven two-worker override:
four workers made its async rendering assertions timing-dependent under CI
contention. File-level parallelism stays on; the DB suite already serializes
files because those tests share one Postgres.

Each test job restores Vite/Vitest transform artifacts
(`node_modules/.vite`, `node_modules/.vitest`) **after** the install — `npm ci`
wipes `node_modules`, so a restore ordered ahead of it is lost.
`scripts/run-ci-tests.js`
writes Vitest wall time to the job summary so later runs can be compared
against the pre-change full-suite job wall on `main` (2026-08-16, run
`31951919659`): server ~300s, client+build ~467s, Windows ~463s.

### Reusing the server install

Three jobs install the server workspace — `server`, `database`, and
`windows-server`. `setup-node`'s `cache: npm` only preserves `~/.npm`, the
tarball cache, so `npm ci` still wipes and repopulates a ~570 MB
`node_modules` on each of them. Two changes cut that.

**Skip the CUDA execution provider.** onnxruntime-node bundles its CPU binaries
in the npm tarball, but its postinstall *downloads* the CUDA EP — several
hundred MB — on linux-x64 whenever `libonnxruntime_providers_cuda.so` is
absent. `server/.npmrc` pins `ignore-scripts=true`, so that runs inside
`scripts/trusted-rebuilds.js`, on the `server` and `database` jobs, every run.
No hosted runner has an NVIDIA GPU to use it with. Setting
`ONNXRUNTIME_NODE_INSTALL_CUDA=skip` on the rebuild step removes the download
outright, and inference is unaffected. This is the largest single saving here,
and it costs no cache budget.

**Cache the installed tree**, keyed on `runner.os`, `runner.arch`, the Node
major, and a hash of `server/package-lock.json`, `server/package.json`,
`server/.npmrc`, and `scripts/trusted-rebuilds.js`. On a hit the install and
the rebuild are both skipped. `scripts/ci-base-sha.test.js` guards the
contract; the parts that are not obvious:

- **Install and rebuild share one condition.** `ignore-scripts=true` means npm
  alone leaves the allowlisted packages un-built, so whenever a job builds the
  tree it will cache, it must build a rebuilt one. (The `server` job used to
  skip the rebuild for always-run-only plans; that condition is narrower, so it
  is gone — along with the planner's `server_native` output, which had no other
  consumer.)
- **A restored tree is checked by a mark, not by importing things.**
  `scripts/trusted-rebuild-stamp.js` writes
  `node_modules/.portos-trusted-rebuild.json` in the same `run:` block as the
  rebuild, recording the allowlist hash, platform, arch, and
  `NODE_MODULE_VERSION`. A cache hit reads it back and reinstalls on any
  mismatch.

  That step is pinned to `shell: bash`, which is load-bearing rather than
  stylistic. `windows-server` would otherwise default to pwsh, where a
  *native* command's non-zero exit neither throws nor stops the block
  (`$PSNativeCommandUseErrorActionPreference` is false) and only the last
  command's code becomes the step result — so a failed rebuild would write the
  mark anyway, exit 0, and publish a green, marked, un-rebuilt entry. Under
  `bash -e` the block stops at the rebuild and the job fails, and
  `actions/cache` declares `post-if: success()`, so nothing is saved.

  It has to be an extrinsic mark because "was this rebuilt?" is not answerable
  by inspecting the tree. With today's versions the rebuild is close to a
  no-op: node-pty and sharp ship prebuilt bindings inside their tarballs (there
  is no `build/` directory even in a fully rebuilt tree), onnxruntime-node
  bundles its CPU binaries, and protobufjs only regenerates a bundle nothing
  requires. `require()`-ing those packages therefore succeeds on a
  never-rebuilt tree and proves nothing. That is a property of the current
  versions, not a guarantee — a release that drops a prebuild for the runner's
  platform, or an install under `npm_config_build_from_source` (which makes
  node-pty's install script *delete* the prebuilds), puts the rebuild back on
  the critical path, and the mark still discriminates.
- **A bad entry is survived, not repaired.** The check is
  `continue-on-error`, and the install and rebuild key off
  `steps.server-modules-usable.outcome != 'success'` — one expression covering
  all three cases, since the step is `skipped` on a miss. The entry itself is
  not replaced: cache keys are immutable and `actions/cache` skips its save on
  an exact hit, so it keeps costing each run a reinstall until the key moves.
  It will not age out on its own either — GitHub's 7-day eviction is keyed on
  *access*, and an entry every run restores is accessed every run. Purging it
  would mean granting the workflow `actions: write`, which is not worth it when
  the worst case is already just the pre-cache cost.

  Two residual cases are accepted rather than defended. A rebuild in which only
  a `fatal: false` group failed exits 0, so a partially-rebuilt tree is marked
  and shared — where before, each job rebuilt from scratch and a transient
  failure degraded exactly one run. Today that is inert: with the CUDA download
  skipped onnxruntime-node's script early-exits, and protobufjs only
  regenerates a bundle nothing requires. And the dependency entry physically
  contains `node_modules/.vite`, so those artifacts are stored in both entries;
  `!` exclusions do not fix it, because `@actions/cache` resolves `path` with
  `implicitDescendants: false` — a bare directory pattern is archived whole and
  a sibling negation has nothing to subtract.
- **No `restore-keys` on this entry**, because the install is skipped on a hit
  and a near-miss restore would run the suite against a different lockfile's
  `node_modules`. The transform-artifact cache is the opposite case — its
  contents are revalidated rather than trusted — so it keeps its own key and its
  own restore-keys, and stays warm across a lockfile bump that misses here.
- **The key pins the Node major, not the resolved patch.**
  `NODE_MODULE_VERSION` is stable across patch releases, so keying on
  `steps.node.outputs.node-version` would discard the entry on every Node 24.x
  release for no ABI benefit; the mark carries the exact ABI as a backstop. A
  test compares the literal against the job's own `node-version:` pin.
  `server/package.json` is in the hash alongside the lockfile so that skipping
  `npm ci` does not also skip its manifest-vs-lockfile agreement check.

Hit rate comes from the nightly full run. There is no push trigger on `main`, and
a cache written by a pull request is visible only to that branch — so the 09:17
UTC schedule is what seeds the entries on the default branch, the one scope every
PR branch can read. A PR that changes the lockfile misses by design.

Two entries exist per key state (Linux, shared by `server` and `database`, plus
Windows) at roughly 570 MB each, against GitHub's 10 GB per-repo cache budget.
Eviction is LRU, so the constantly-read `main` entries outlive the PR-scoped ones
— but a burst of lockfile-churning PRs can still push out the transform caches
and `~/.npm`. If that starts showing up as unexplained cold runs, the dependency
cache is the part to drop: the CUDA skip above carries most of the saving on its
own.

### Shallow checkouts

No job clones full history. `actions/checkout` runs at `fetch-depth: 2`,
which on a pull request is the merge ref plus both of its parents — and the
first parent *is* the base-branch commit the pull request is diffed against.
`scripts/ci-base-sha.js` reads it (`HEAD^1`) and exports `CI_BASE_SHA` for the
rest of the job, so the planner's `git diff <base>...HEAD` resolves without
deeper history. The planner passes the resulting source paths directly to
`vitest related`; Vitest no longer performs its own Git diff.

Reading the base off the checkout rather than `github.event.pull_request.base.sha`
is also more correct: GitHub rebuilds the merge ref when the base branch moves,
so the payload value can name a commit the tested tree was never merged with.

Non-pull-request runs (nightly, dispatch, release fallback) force the complete
suite, need no diff at all, and get no base.

### Required checks

The `main` ruleset — which also covers `release` — requires exactly one
context: **`CI Gate`**. The workflow used to carry two extra jobs solely to
publish historical required-check names (`lint`, which echoed the client job's
result, and `test (24.x)` on the server job); both are retired. If a required
check is ever added, require `CI Gate`, never a job name.

The selected work is split across parallel jobs:

- **Server tests** — full, related, or explicit feature test files. Smoke-boots
  the server on the same job when server source changed (the smoke path uses the
  file backend under `NODE_ENV=test` and does not need Postgres). The install
  and the native-addon rebuild are skipped when a `server/node_modules` cache is
  restored and its trusted-rebuild mark checks out.
- **Client tests and build** — affected client tests; production build whenever
  client source changed; client lint on the same install so Biome does not pay a
  second `npm ci`.
- **DB tests** — provisions only the isolated `portos_test` database and runs
  the serial DB suite when database-sensitive files changed.
- **Windows server tests** — the same server selection, but only on full CI
  (the `main` → `release` PR, nightly, release, workflow dispatch) or when a
  Windows-sensitive surface changed (`.ps1` / `.cmd` spawn, PowerShell BOM,
  `bufferedSpawn`, `cos-runner`, shell/PM2, etc.). Docs-only and ordinary
  Linux-faithful PRs skip this job. `pinPlatform('win32')` tests still run on
  Linux.
- **CI Gate** — always reports one stable required-check result and fails if any
  selected job failed or was cancelled.
- **Full CI Gate** — published only when the plan chose the complete suite, and
  mirrors `CI Gate`'s result. This is the check the release workflow looks for;
  see "Reusing the release PR's CI run" below.

Targeted `files` plans run the planner's exact test files once. `related` plans
run `vitest related` once with changed behavioral source paths and the cheap
structural/repository contract files as inputs. Vitest treats a test-file input
as directly selected, so contracts and changed tests share the import-graph run
without being repeated in a second process.
There is no buffered discovery pass: the old `vitest list --changed` path could
spend minutes printing every test name, overflow Node's buffer, discard the
result, and rerun the same graph.

No third-party change-filter action is used. The planner passes test paths as a
JSON argument array to `spawnSync`, never through shell interpolation.

### Full CI

The complete server, client, DB, lint, build, and smoke suite runs:

- on every pull request whose base branch is `release` (the release gate);
- nightly at 09:17 UTC;
- from manual workflow dispatch;
- as a reusable workflow called by a release whose tree has no verifiable gate.

There is **no push trigger on `main`**. A merge commit on `main` re-tests a
tree whose PR gate is already green, so the run was pure duplication; the
nightly full run is what catches a semantic conflict between two independently
green PRs, and the `main` → `release` PR catches it before a release ships.

Changes to CI/test configuration also force the full suite on their own PR.
`[skip ci]` remains honored for push events only; PR CI always runs.

### Fail-fast sibling cancellation

Each selected leaf job (`server`, `client`, `database`, and
`windows-server`) ends with an `if: failure() && github.event_name ==
'pull_request'` step that asks GitHub to cancel the current pull-request
workflow run. The event guard is important because the same workflow is reused
by the release workflow: a failing reusable `full-ci` job must not cancel its
parent release run before that workflow can report the release failure. The
request uses the repository-owned
`scripts/cancel-current-ci-run.js` helper and the standard workflow-run cancel
endpoint. The helper accepts no repository or run arguments: it validates and
uses only `GITHUB_REPOSITORY` and `GITHUB_RUN_ID` supplied by Actions, with the
step-scoped `GITHUB_TOKEN`.

The leaf jobs request only `contents: read` and `actions: write`, and check
out with `persist-credentials: false` so a token that can now cancel runs is
not left in `.git/config` for the test suite's own subprocesses to read. The
token is present in the environment only for the cancellation step, and no
third-party action or long-lived secret is involved. The failing test/build
step runs before cancellation, so its annotations and logs remain the evidence
for the failure. A successful cancellation returns `202`; a `409` means the run
is already terminal and is treated as a no-op.

`release.yml`'s `full-ci` job must grant `actions: write` to the workflow it
calls even though the cancellation step never fires there — a called workflow's
jobs cannot hold a permission the calling job lacks. See the comment on that
job; `scripts/ci-fail-fast.test.js` pins it.

Cancellation is deliberately best-effort. Fork pull requests and other
read-only-token runs may receive a permission failure, and transient API or
network failures are also possible. The helper logs the unavailable
cancellation and exits normally, preserving the original failed step and its
failed job result when the API is unavailable. It imports only Node builtins,
so it still runs from a job that failed before `npm ci`
(`scripts/pre-install-entrypoints.test.js` enforces that).

**Canceled is not mergeable.** A run-wide cancellation lands on the requesting
job and on `CI Gate`, which is usually still waiting on its `needs` and so ends
`cancelled` rather than running its comparison. Every consumer treats that as a
non-pass, by allowlisting the green results rather than denylisting the red
ones:

- Branch protection requires the `CI Gate` context to conclude `success`;
  `cancelled` does not satisfy it, and a gate that never publishes leaves the
  required context unreported, which also blocks.
- If the gate job does run, it accepts only `success` or `skipped` per job, so
  the failed leaf (or its own `cancelled` result) fails the gate.
- `scripts/verify-ci-status.js` accepts a `Full CI Gate` only at
  `conclusion === 'success'`, so a canceled run can never let a release skip
  the full suite.
- PortOS's own auto-merge watcher (`server/services/prWatcher.js`) counts only
  `SUCCESS`/`NEUTRAL`/`SKIPPED` as green.

The consequence to expect in the UI: on a fail-fast run the required check
reads *canceled*, not *failed*. The failing step's log and annotations are
still the diagnosis. The target is for siblings to become canceled within 30
seconds of the first failing job completing, while the existing workflow-level
`concurrency.cancel-in-progress` continues to handle superseded runs
independently — the two are orthogonal, one canceling this run by id and the
other canceling an older run when a newer commit arrives. Scheduled, manually
dispatched, and release-called runs skip this sibling cancellation so their
aggregate diagnostics and cache post-steps can complete normally.

### Impact-planner safety rules

- A directory feature such as `server/services/sprites/` selects tests carrying
  the same feature segment across server and client.
- Flat/shared behavioral modules use Vitest's import graph, driven by their
  exact changed source paths. Directly changed tests are always included.
- Barrel/catalog guards are added when reusable `lib`, `hooks`, or `utils`
  directories change, and catalog-only barrels are excluded from import-graph
  expansion. JSX changes include the global accessibility convention guard.
- A deleted executable source cannot be handed to `vitest related`, so that
  case fails closed to the complete suite.
- Database adapters, DB scripts, and relevant migrations add the complete
  serial DB suite.
- Unmapped executable files use related-test mode. Unclassified artifacts,
  shared roots/config, more than 30 executable changes, or more than 120
  selected tests fail safe to full CI.

## Release Workflow (`release.yml`)

Triggers on push to `release` branch. Steps:

1. Runs `scripts/verify-ci-status.js` to look for a full CI run that already
   covered this exact tree (see below).
2. Calls `ci.yml` with `full: true` **only if** step 1 found nothing.
3. Reads version from `package.json`.
4. Checks if the git tag already exists (skips release creation if so).
5. Looks for a changelog file:
   - First: `.changelog/v{version}.md` (exact match)
   - Then: `.changelog/v{major}.{minor}.x.md` (pattern match, replaces placeholders)
   - Fallback: generates changelog from commit messages
6. Creates the GitHub release with tag `v{version}`.
7. If a pattern changelog file (`.changelog/v{major}.{minor}.x.md`) was used,
   archives it on `main` (renames `.x.md` to the exact version).
8. If the archive step ran, fast-forwards `release` to match `main`.

### Reusing the release PR's CI run

`scripts/verify-ci-status.js` decides whether the push already has a green
gate. Two independent conditions must hold, because each alone is forgeable:

1. **Content, not SHA.** A commit vouches for this push only when its git tree
   is byte-identical to the tree being released. It considers the pushed commit
   itself and its direct parents.
2. **Fullness.** The gate must be `Full CI Gate`, a check run `ci.yml`
   publishes *only* when the impact plan chose the complete suite. The
   aggregate `CI Gate` cannot serve here — an impact-scoped PR run turns it
   green too, so it cannot distinguish "the full suite passed on this tree"
   from "some subset of it did".

The ordinary release merge satisfies this — `release` is strictly behind
`main`, so the merge commit's tree equals the `main` tip it merged, and that
tip is exactly the SHA the release PR ran full CI on.

Everything else fails closed and runs the complete suite again: a direct push to
`release`, a hotfix committed on `release` that changes the merge tree, a
missing, failed, or merely impact-scoped gate, or an unreachable checks API.

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
