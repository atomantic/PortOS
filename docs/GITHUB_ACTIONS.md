# GitHub Actions Workflows

PortOS uses a test-impact-aware CI workflow plus a release workflow that cannot
publish until the complete CI suite has passed on the exact tree being released.

## Release Dependabot CI after review

Dependabot pull requests start with a small checkout/admission check only.
`Plan test impact` fails with a maintainer-release message before dependency
installation or tests, so the required `CI Gate` remains red. The SuperCollider
job inside `ci.yml` repeats the check before installing or building.
Other pull requests, scheduled checks, releases and manual dispatches retain
their existing behavior. No schedule or repository security setting changes.

After reviewing the dependency diff, open the **current commit's** CI workflow
run and choose **Re-run all jobs**, or run `gh run rerun RUN_ID`. GitHub permits
reruns only to repository writers. Re-running failed jobs also reruns their
dependents; re-running only CI Gate cannot release a failed impact check.
Tests still have to pass before merging.

This approval is **commit-bound**: GitHub preserves the original SHA and ref
when rerunning. An older run cannot validate a newer commit. Every subsequent
commit, including a maintainer fix or Dependabot rebase, starts a new run at
attempt 1 and needs review/release again. Repeated reruns are still subject to
the same writer-only GitHub control. Labels and PR approval reviews do not
release CI. Automated bot reruns (including cancellation recovery) cannot
release held updates. Existing runs created before this workflow change keep
the workflow version with which they started.

The existing **Run workflow** dispatch remains an explicit writer-controlled
way to run the full suite on a selected branch/ref. Inspect its exact SHA:
a dispatch on `main` says nothing about a dependency PR, and a later commit
needs its own validation. The normal dependency workflow is the PR rerun above.
No privileged `pull_request_target` execution, writable test token or secrets
are introduced; reruns retain the original actor's restricted token.

See [GitHub's rerun permissions and revision semantics](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs).

## Where the suite actually runs

Every change reaches `main` through a pull request and `main` reaches
`release` through a pull request, but two green PRs can still merge into a red
tree, so `main` is also tested after the merge:

| Event | What runs |
|-------|-----------|
| PR into `main` | Impact-scoped plan (only the surfaces the diff touches) |
| Push/merge to `main` | **Full suite**, native jobs path-gated (see [Native jobs on a push to `main`](CI_NATIVE_JOBS.md#native-jobs-on-a-push-to-main)); the run in flight finishes, and only the newest waiting push runs next |
| PR candidate → `release` | **Full suite**, forced regardless of the diff |
| Push/merge to `release` | Reuses the release PR's green gate; full suite only if it cannot be verified |
| Scheduled 09:17 and 21:17 UTC | Full suite — catches what no commit caused (dependency or runner changes) |
| `workflow_dispatch` | Full suite |

A release therefore pays for one full run (on its PR), not three.

## Branch Strategy

| Branch | Purpose |
|--------|---------|
| `main` | Active development |
| `release` | Merge the frozen candidate into `release` to trigger releases |

## CI Workflow (`ci.yml`)

PRs into `main` use `scripts/ci-test-plan.js` (its path rules, manifest verdicts,
repository inputs and output in `scripts/lib/ciPlan*.js`) to classify the changed files
before installing dependencies. Directory-scoped features add their
same-workspace feature tests, and every behavioral source (nested or flat) uses the
runner's import-graph-aware `related` mode, fed the changed behavioral source
paths plus the planner's explicit test files. The planner deliberately chooses full CI for shared
composition roots, test configuration, dependency manifests, workflow changes,
unknown artifacts, or wide diffs.

PRs into `release` skip the planner entirely and force the full suite: that PR
is the single gate a release ships behind.

### Composite actions

Setup blocks that several `ci.yml` jobs share live once, with their rationale,
as composite actions under `.github/actions/`:

| Action | Used by | Holds |
|--------|---------|-------|
| `setup-server` | `server`, `database`, `browser`, `windows-server`, `macos-native` | Node 26, the cached and stamped `server/node_modules`, the trusted rebuild, the Vitest transform cache |
| `setup-client` | `client`, `lint`, `browser` | Node 26 (unless `setup-node: 'false'`), the cached `client/node_modules` |
| `test-memo` | `server`, `client`, `database`, `browser`, `windows-server` | The memo restore and its key lineage; jobs save with `steps.test-memo.outputs.key` |
| `diff-base` | `server`, `client`, `windows-server` | `scripts/ci-base-sha.js` (the `impact` job wraps the same script in its stage diagnostics) |
| `db-tools` | `database`, `browser` | The APT download cache and `scripts/ci-install-db-tools.sh` for a given `pg-major` |

Every `run:` step in an action names `shell: bash`, as composite actions
require. On `windows-latest` that replaces the pwsh default for the server
install and stamp check too; the trusted rebuild was already pinned to bash for
the fail-fast reason under [Reusing the server install](CI_TEST_SELECTION.md#reusing-the-server-install). Local actions resolve
from each job's own checkout, so `release.yml`'s `workflow_call` of `ci.yml`
runs the actions from the commit it checked out.

The workflow-contract tests read the jobs through
`scripts/lib/ciWorkflowJobs.js`, which expands each local action inline with
its caller's `with:` inputs, so they assert the steps GitHub runs. Its reads are
anchored at `import.meta.url`, which makes `ci.yml` and `.github/actions/` test
memo inputs for every test that uses it. actionlint validates each caller's
inputs against the action's metadata while it lints `ci.yml`;
`server/test/guards/repo/github-actions-pinned.test.js` applies the SHA-pin contract to the
action files, and any change under `.github/actions/` makes the impact plan
full, Windows included.

The hidden-content gate moved to [CI_HIDDEN_CONTENT_GATE.md](CI_HIDDEN_CONTENT_GATE.md).

### The bundled `lib/slashdo` submodule

`server/lib/slashdoLoader.test.js` and `server/lib/slashdoInvocation.test.js`
carry contract suites that exercise the real bundled renderer in
`lib/slashdo` (see AGENTS.md "Slashdo Commands"). A git diff reports only the
gitlink pointer at that path, never the files inside it, so the planner can't
detect a relevant change the way it does an ordinary source edit.
`needsSlashdoSubmodule()` in `ci-test-plan.js` sets the `slashdo` plan key
whenever the plan is full, the gitlink itself changed, or either contract
suite (or the loader/adapter source it exercises) is selected. The `server`
job's "Initialize slashdo submodule" step runs `git submodule update --init
lib/slashdo` only when that key is true, so an unrelated scoped PR pays
nothing for the fetch. When the key is true, the two contract suites fail
the job instead of silently skipping if the submodule still isn't there
(`CI_EXPECT_SLASHDO_SUBMODULE`); outside that signal — a local checkout, or a
CI run that never needed it — they keep the documented skip.

### Local equivalent: `npm run pregate`

`scripts/pregate.js` runs the same planner as CI over the committed, uncommitted
and untracked diff and hands its plan to the same runners. What it selects, its
`--full` plan and receipt, interrupt and Windows behavior, and test process
containment: [PREGATE.md](PREGATE.md).

Test selection, runner tuning and install reuse details moved to [CI_TEST_SELECTION.md](CI_TEST_SELECTION.md).

### Required checks

The `main` ruleset — which also covers `release` — requires exactly one
context: **`CI Gate`**. If a required check is ever added, require
`CI Gate`, never a job name.

The selected work is split across parallel jobs:

- **Server tests** — full, related, or explicit feature test files. Smoke-boots
  the server on the same job when server source changed (the smoke path uses the
  file backend under `NODE_ENV=test` and does not need Postgres). The smoke is
  hermetic (#8343): `scripts/smoke-boot.js` boots against a disposable install
  root seeded like a fresh install, with an allowlisted environment and
  `PORTOS_SMOKE_BOOT=1` so no scheduler, agent recovery, or peer sync starts —
  `npm run smoke` behaves the same on a clean checkout and on a live install. The install
  and the native-addon rebuild are skipped when a `server/node_modules` cache is
  restored and its trusted-rebuild mark checks out. Autofixer tests use the
  server workspace's Express install. The impact job always checks the syntax
  of `server/index.js`, even when the planner skips the server job.
- **Client tests and build** — affected client tests, plus the production build
  whenever client source changed. The build runs on shard 1 only.
- **Lint client** — Biome over the changed client sources, in its own job. It used
  to be a shard-1 step on the client job. Steps within a job run sequentially, so
  that put ~31 s of Biome in front of the slowest shard's tests rather than beside
  them, and it meant a lint-only diff started a whole client test job. It was
  **not** what made shard 1 flaky — see [Client suite time budgets](CI_TEST_SELECTION.md#client-suite-time-budgets). It
  cannot move to a later shard instead: a scoped plan emits `client_shards: [1]`,
  so a second-shard pin would skip lint on every scoped pull request. It shares
  `Cache client node_modules` with the client job, so on a hit it pays no install.
- **DB tests** — provisions only the isolated `portos_test` database and runs
  the serial DB suite when database-sensitive files changed. Before it, outside
  the test memo, `server/services/backupDatabaseDump.restore.live.test.js`
  (`PORTOS_DB_RESTORE_LIVE=1`) makes a real `pg_dump` with the snapshot
  backup's flags in the pinned `pgvector/pgvector` image, checks it with
  `inspectDatabaseDump`, prepares it with `prepareDatabaseReplay`, replays it
  into a `scripts/rehearsal-scratch-db.js` scratch database, and checks the
  startup maintenance-schema probe. A missing Docker engine, image or `psql` fails the step.
- **Browser suites** (their own `browser` job, beside DB tests) — the exact
  `BROWSER_SUITES` registry in `scripts/lib/browserSuites.js` owns these tests.
  Server unit runs exclude that registry whenever `PORTOS_CI_BROWSER_OWNER=unit`
  is exported (Linux server shards, and `npm run pregate` on every platform);
  a server test that calls `resolveTestChrome(` must be registered (the registry
  guard discovers it), and gates on `browserSuiteCanRun(` so a missing Chrome fails there.
  The planner selects affected registered files and the browser job requires
  Chrome, FFmpeg and bundler prerequisites instead of silently skipping them.
  Ordinary PRs run the `smoke` profile: all existing assertions except the
  explicitly tagged `[fidelity]` grading/authoring cases. Scheduled, release,
  and dispatched full runs also execute ordinary fidelity cases. The explicit
  `[local-performance]` playback case runs only in local fidelity, including when
  hosted CI selects `full`. Hosted profiles retain generated Three render/export
  and owned cleanup coverage. Profiles do not change pixels,
  render settings, tolerances, or cleanup assertions.
  They ran after the DB suite on one job until that job set the run's length
  more often than any other; split, each finishes in about the time of its own
  steps.
- **Windows native contracts** — one runner for CLI/TUI execution and prompt
  submission, cmd/PowerShell behavior, process settlement and filesystem/path
  compatibility. Relevant source/tooling changes and explicit full validation
  select it. Application import graphs and platform-neutral product suites stay
  on the primary jobs; see [Windows native contract coverage](CI_NATIVE_JOBS.md#windows-native-contract-coverage).

- **Node minimum compatibility** — installs every workspace and runs the
  runtime gate on the oldest supported Node. On a pull request it runs only
  when a `package.json`, a lockfile, an `.npmrc`, `.nvmrc`, the gate script or
  its `directInvocation.js` import, its drift test or `ci.yml` changed, since nothing else can change its answer
  (`NODE_MINIMUM_PATH_RE`). Non-push full runs always run it; a push gates it.
- **Linux worker containment** — runs `LINUX_CONTAINMENT_TESTS` against real
  bubblewrap namespaces on ubuntu-22.04. On a pull request it runs only when
  the `linux_containment` plan key is true: the diff touches the static import
  closure of those tests and the server Vitest harness, `server/package.json`,
  `server/package-lock.json` or `ci.yml`. The closure is recomputed from the
  head tree on every run, so a new dependency is gated without a list edit.
  Non-push full runs and pull requests into `release` always run it; a push
  gates it. Pregate reports
  it as CI-only.
- **Docker containment live** — runs the opt-in live suite of the Docker
  containment profile (`server/services/dockerContainment.live.test.js`,
  [CONTAINMENT.md](CONTAINMENT.md)) against the ubuntu runner's native Docker
  Engine: non-root user, no host home or Docker socket, no network in the
  validate phase, registry-only egress in the install phase, kill-and-remove on
  timeout, and lifecycle writes kept out of the host worktree. It is part of
  `CI Gate`. On a pull request it runs only when the
  `docker_containment_live` plan key is true: the diff touches the static import
  closure of the live suite and the server Vitest harness,
  `server/package.json`, `server/package-lock.json` or `ci.yml`
  (`DOCKER_CONTAINMENT_LIVE_ENTRIES`, `DOCKER_CONTAINMENT_LIVE_PATH_RE`).
  Non-push full runs and pull requests into `release` always run it; a push
  gates it. Pregate reports
  it as CI-only. CI has no macOS Docker, so Docker Desktop is verified manually.
- **macOS native release-agent supervision** — runs the launchd-coalition
  release-agent suites on `macos-latest`. It is part of `CI Gate` and runs on a
  pull request only when the `macos_native` plan key is true; see
  [macOS native release-agent supervision](CI_NATIVE_JOBS.md#macos-native-release-agent-supervision).
- **SuperCollider native containment** — builds `docker/supercollider/`, runs
  `npm run setup:supercollider` twice and executes the opt-in live suite
  (`server/services/superColliderRender.live.test.js`) against real Docker on
  native amd64 and arm64 runners. It is the only run of the container boundary
  for untrusted generated `sclang` source, and it is part of `CI Gate`: a red
  run blocks the merge, a skipped one passes. On a pull request it runs only
  when the `supercollider_live` plan key is true: the diff touches the static
  import closure of the live test, `scripts/setup-supercollider.js` and the
  server Vitest harness (so the spawn, kill and child-environment helpers it
  depends on select it), `docker/supercollider/`, a `package.json` or
  `package-lock.json`, or `ci.yml` (`SUPERCOLLIDER_LIVE_ENTRIES`,
  `SUPERCOLLIDER_LIVE_PATH_RE` in `scripts/lib/ciPlanRules.js`,
  `collectSuperColliderLiveInputs()` in `scripts/lib/ciPlanInputs.js`). The closure is recomputed from the head tree on
  every run, so a new import is covered without a list edit. Non-push full runs
  and pull requests into `release` always run it, a push gates it; `workflow_dispatch`
  of `CI` is the manual evidence run. Pregate reports it as CI-only.
- **CI Gate** — always reports one stable required-check result and fails if any
  selected job failed or was cancelled. Both block, but the message distinguishes
  them: `scripts/ci-gate-report.js` says *cancelled, not failed* and names the
  cancelled jobs when nothing actually failed — as far as the gate job itself
  runs, which a run-wide cancel prevents. See [External cancellation and one
  automatic retry](CI_NATIVE_JOBS.md#external-cancellation-and-one-automatic-retry). A job the planner skipped
  counts as passing here; the impact summary and `suite_reasons` say which
  ones, and why.
- **Full CI Gate** — published only when the plan chose the complete suite and
  the supported native Windows contracts, with the full browser profile executed in hosted CI.
  Ordinary PR smoke runs cannot publish it, and neither can any run whose plan is not full. It mirrors `CI Gate`'s result. This is the check the release workflow
  looks for; see "Reusing the release PR's CI run" below.

Test selection, runner tuning and install reuse details moved to [CI_TEST_SELECTION.md](CI_TEST_SELECTION.md).

Windows and macOS native job details moved to [CI_NATIVE_JOBS.md](CI_NATIVE_JOBS.md).

Test selection, runner tuning and install reuse details moved to [CI_TEST_SELECTION.md](CI_TEST_SELECTION.md).

### Full CI

The complete server, client, DB, lint, build, and smoke suite runs:

- on every pull request whose base branch is `release` (the release gate);
- on every push to `main`: the run in flight always finishes, and a newer push
  replaces any run still waiting behind it (GitHub cancels a pending run when a
  newer one joins the concurrency group). With merges minutes apart, cancelling
  the run in flight meant almost no push run finished, so `main` went untested
  and the memo records that related selection narrows with were never saved
  (#16424). A miss is caught by the next run that completes, which covers every
  merge since the previous one started;
- on the schedule, 09:17 and 21:17 UTC, in a concurrency group of its own so a
  push to `main` never replaces a scheduled run waiting behind it;
- from manual workflow dispatch;
- as a reusable workflow called by a release whose tree has no verifiable gate.

Windows and macOS native job details moved to [CI_NATIVE_JOBS.md](CI_NATIVE_JOBS.md).

### Failures do not cancel other jobs

A failing job does not cancel its siblings, and every matrix sets
`fail-fast: false`. The run finishes with the failing job concluded `failure`
and the rest concluded on their own results, so **Re-run failed jobs** repeats
only the red shard. Runners on this public repository are not billed, so the
siblings that keep running cost concurrency, not money.

**The launcher bounds itself.** A step timeout did not end a hung Windows test run
on 2026-11-24 and the job log was lost (#18636). `scripts/run-ci-tests.js` therefore reads
`PORTOS_CI_TEST_DEADLINE_MINUTES` (Windows 20, Linux server 25, client 25, DB 15, each below
its step or job limit). One deadline covers every pass and the crash retry; when it expires the launcher
logs the deadline, ends the test process tree, prints the diagnostics and the Vitest output tail,
and exits non-zero even if a detached descendant holds a handle. The step and job timeouts stay
as the outer fallback, and the browser job keeps its own watchdog. A runner that stops executing
entirely cannot be reported by any in-process deadline.

**Cancelled is not mergeable.** Every consumer allowlists green results:
branch protection requires `CI Gate` to conclude `success`; the gate accepts
only `success` or `skipped` per job; `scripts/verify-ci-status.js` accepts a
`Full CI Gate` only at `success`; and PortOS's auto-merge watcher
(`server/services/prWatcher.js`) counts only `SUCCESS`/`NEUTRAL`/`SKIPPED` as
green.

Windows and macOS native job details moved to [CI_NATIVE_JOBS.md](CI_NATIVE_JOBS.md).

Test selection, runner tuning and install reuse details moved to [CI_TEST_SELECTION.md](CI_TEST_SELECTION.md).

## Runtime image security (`runtime-image-security.yml`)

Generates an SBOM (syft) and a vulnerability scan (grype, OS packages and
language dependencies) for the pinned runtime recipes that the npm/Python
audits cannot see (#15656). It is separate from `ci.yml`, is **not** part of
`CI Gate`, and never blocks an unrelated PR on a new upstream advisory. It is
the security inventory; `supercollider-live` stays functional evidence.

| Target | Subject | Architectures |
| --- | --- | --- |
| `pgvector` | the digest-pinned image in `docker-compose.yml`, pulled by digest | amd64, arm64 |
| `supercollider` | `docker/supercollider/` built with the product's own build argv (same labels and recipe hash) | amd64, arm64 |
| `eidoverse-rapier` | the inline `npm:@dimforge/rapier3d-compat` pin in `docker/eidoverse-video/Dockerfile`, resolved to a lockfile at scan time | one run |

Targets are derived from the recipes by `scripts/runtime-image-security.js`, so a
digest or pin change moves the scan with it and a recipe that loses its digest
fails the run. Each run uploads `runtime-image-security-<target>-<arch>`
(90 days): `sbom.syft.json`, `sbom.cdx.json`, `vulnerabilities.grype.json`,
`grype-db-status.json`, `findings.json` and `provenance.json` (image ref, image
ID and repo digests, recipe path and hash, commit, run, architecture, syft/grype
versions, vulnerability DB identity). Scanner binaries are pinned by version and
archive SHA-256, actions by commit SHA; the vulnerability DB is recorded, not pinned.

Triggers: weekly, `workflow_dispatch`, and pull requests touching
`docker-compose.yml`, `docker/`, the helper script or the supercollider runtime
constants. The job summary lists **every** finding by severity with its fix
state; findings are reported, not gated. The run fails on exactly three things:

- a scanner error or an unparseable scan;
- an empty or malformed SBOM, or a missing OS or npm package ecosystem (a scanner
  that did not run is never zero findings);
- an **actionable** finding: High or Critical severity, a fix available, and absent
  from the scan of the newest digest of the pinned tag, so bumping the pin removes
  it. The failure names the image and the digest to adopt.

Pull request runs report an actionable finding without failing. Only `pgvector`,
pinned as `repo:tag@digest`, has a newest digest to compare against;
`supercollider` and `eidoverse-rapier` findings are always reported only. A finding that is unfixed upstream, or
fixed but not yet in the newest digest, is a report line, never a failure: no PortOS
action clears it (the review ledger that recorded this was retired in #16425).

The fix path is a digest bump: weekly `docker-compose` (`/`) and `docker`
(`/docker/*`) Dependabot entries propose newer pins. The pgvector digest lives only
in `docker-compose.yml`; `dbImage.js` and the `ci.yml` DB service derive it, and
`server/test/guards/repo/dbImageDigestPin.test.js` rejects a second copy. Do not move the Debian
snapshot or an image digest merely to silence a scanner.

**Known coverage gap.** The `eidoverse:render` parent image and the
`deno.json`/`deno.lock` build context are built from the independent
eidoverse-video checkout and do not ship here, so they cannot be inventoried by
this repository. The `unavailable` job reports them in every run's summary (and a
`runtime-image-security-unavailable` artifact) with the owning project; it
never counts as a pass. Closing it needs the pinned parent digest and lock from
that project's build.

The scheduled `dependency-updates` task reads the latest default-branch run of
this workflow and its artifacts, and reports a missing, scanner-failed, over-14-days-old,
stale-recipe or `unavailable` target as a coverage gap, not a clean result.

## Release Workflow (`release.yml`)

Triggers on push to `release` branch. Steps:

1. Runs `scripts/verify-ci-status.js` to look for a full CI run that already
   covered this exact tree (see below).
2. Calls `ci.yml` with `full: true` **only if** step 1 found nothing.
3. Reads version from `package.json`.
4. Checks if the git tag already exists (skips release creation if so).
5. Reads `.changelog/RELEASE.md`, failing the step when its heading's version
   differs from `package.json` or the file exceeds 100 KB (never truncated).
   Only a missing file falls back to a changelog generated from commit messages.
6. Creates the GitHub release with tag `v{version}`.
   The first changelog heading should be `# Release v{version} - {Fun Name}`;
   the workflow uses that complete heading without `# ` as the GitHub release
   title, with `Release v{version}` as the backward-compatible fallback for
   older unnamed notes.
7. Nothing is archived afterwards; GitHub Releases and the tags are the archive,
   and `release` remains pinned to the verified tree.

Capture and resume candidates using [the release procedure](VERSIONING.md#creating-a-release).
Concurrent development merges do not change the candidate or its CI inputs.

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

The ordinary release merge satisfies this when the frozen candidate contains
the captured `release` base: the merge commit's tree equals the candidate head
that full CI validated. The current `main` tip is irrelevant.

Everything else fails closed and runs the complete suite again: a direct push to
`release`, a hotfix committed on `release` that changes the merge tree, a
missing, failed, or merely impact-scoped gate, or an unreachable checks API.

### Pinning the release tag to the verified tree

The release action creates a missing tag at the repository default branch
unless told otherwise, and main may have advanced since CI verified the release
push. `release.yml` therefore passes `target_commitish: ${{ github.sha }}`, and
`scripts/verify-release-tag.js` covers the case the input cannot: a tag that
already exists is peeled (annotated tags included) and its commit's tree must
equal the released tree. A different tree, a non-commit target, or any lookup
GitHub does not answer fails the job; the script is read-only and never moves
or deletes a tag. It runs again after publication to confirm the new tag landed
on the verified tree.

## Working with CI

### Skip CI

Add `[skip ci]` to push commit messages for generated documentation-only
changes. Auto-generated commits from the release workflow include this
automatically. Pull-request checks ignore this marker so a PR cannot bypass its
required CI gate.

### Force Full CI

Use the workflow-dispatch button for an immediate full run. A PR also chooses
full CI automatically when its impact cannot be classified safely.

### Before Push

Fetch the intended base and inspect the branch and working tree before pushing:

```bash
git fetch origin main
npm run pregate
```

Commit intended changes and push to the branch's verified remote destination.
Integrate the fetched base when there is an actual conflict, an enforced
up-to-date policy, or evidenced semantic overlap; rerun pregate after a rebase.
A moving main alone does not require a new head or another hosted CI run.
Managed merges follow the hosting-provider eligibility and pinned-head policy
in the root AGENTS.md; combined-tree guards remain available for investigation.

## Adapting for Sub-Projects

1. Copy `.github/workflows/ci.yml`, `.github/workflows/release.yml` and the
   composite actions under `.github/actions/`
2. Update installation and build commands for your project structure
3. For monorepos, add package.json update steps for each workspace
4. Update the changelog file path pattern if different

### Impact job command and finalization evidence

The `impact` job records the fixed stages `admission`, `base`, `hidden-content`,
`import-case`, `plan`, and `syntax`
through `scripts/ci-impact-diagnostics.js`. Each stage logs its start and direct
child `exit`/`close` status and elapsed milliseconds. Its original stdout, GitHub
command files, environment inputs and nonzero status pass through; a signal or
spawn failure remains a failure. No additional provider calls or retries occur.

A random marker inherited only by that stage's command lets Linux `/proc` scans
count surviving same-user owned processes after close and at the final
`always()` checkpoint. The scan is limited to 4,096 process entries and one second
per snapshot. Public evidence contains only fixed stage names, numeric statuses,
signals, elapsed time, counts and coverage. Markers, PIDs, host paths, environment
values and raw command lines are not published. Private per-stage records stay
under the runner's temporary directory; they are not uploaded as artifacts.

`coverage=partial|unavailable`, missing records, or missing events mean unknown,
not clean. Even complete coverage is a point-in-time observation of processes
that retained their inherited marker; it cannot prove the absence of work that
removed its marker. Nonzero owned counts are evidence to investigate, not
permission to kill a process. The observer signals/deletes nothing and does not
claim to repair an orphan. A settlement change needs a reproduced owner and a
causal negative control first.

The final checkpoint precedes checkout post-actions and the runner's own
finalization. Interpret the first unconfirmed boundary in order: stage start →
command exit → command close → owned-process snapshot → checkout post-action →
runner `Complete job` → overall job result. A successful repository checkpoint
cannot attest the later runner/result-service handoff. Keep the ten-minute impact
timeout, and fail-closed `CI Gate`.

#### Retained evidence rule

An impact job whose last retained log line is runner orphan cleanup, with every
step later read back as successful, proves nothing about the runner/job-result
handoff: that boundary stays unconfirmed. Neither a repository-created orphan nor
a specific upstream incident has been proved. Preserve the cancelled attempt; a
recurrence needs the fixed-stage evidence plus the runner's completion, queue and
transport diagnostics (sensitive fields redacted) before changing lifecycle
behavior or attributing a GitHub incident.

## Test runs report every failure

`npm run test:ci` and `test:db:ci` run Vitest without `--bail`, so one CI round names
every failing test file instead of stopping at the first. This applies to every run
alike: ordinary PRs, release PRs, nightly and local. A red run still writes no
test-memo entry, and the launcher's one-file retry of a native worker crash is kept
(a recovered crash never masks a real failure elsewhere in the same run). Each attempt's
`invocation.json`, `run.json`, `failures.json` and `processes.json` stay in the job's
diagnostics directory for the failure summary. Job timeouts bound a badly broken PR.
