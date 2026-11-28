# GitHub Actions

Run [local pregate](PREGATE.md) before pushing. On GitHub, the required check for
`main` and `release` is **CI Gate** on the current head. It passes when every
selected job succeeds. Skipped jobs are allowed and failed or cancelled jobs
block the gate. See the impact job summary for selection and reasons.

| Event | Coverage |
| --- | --- |
| PR into `main` | Impact-selected tests and checks |
| Push to `main` | Full primary suites with [native jobs gated](#native-jobs-on-a-push-to-main) |
| PR into `release` | Full primary and native coverage with the hosted full browser profile |
| Push to `release` | Reuse verified full coverage for the released tree or run full CI |
| Schedule or manual dispatch | Full CI (scheduled at 09:17 and 21:17 UTC) |

## Test selection

`scripts/ci-test-plan.js` and `scripts/lib/ciPlan*.js` own the impact rules.
For a PR, the planner uses the merge-base diff. The runner selects changed tests,
explicit contract and feature tests, and importers of changed behavioral sources
through static, dynamic and mock edges. Test-only and catalog barrel changes
can use exact-file selection. Python sidecars select tests that name those scripts.
Unknown artifacts, unmapped sidecars, deleted executable source, shared roots,
test infrastructure or dependency changes, and broad diffs can require full CI.
DB adapter, schema, migration and restore paths can require the serial database
suite or live restore probe against `portos_test`.

The impact job emits a JSON plan, shard matrices and the DB image. Jobs read
selection from that plan. `scripts/run-ci-tests.js` resolves exact workspace paths
and passes a selection file via `PORTOS_CI_TEST_SELECTION` to avoid shell quoting
and command-line limits. [Test memo](TEST_MEMO.md) can reuse a matching complete
verdict inside the selected set.

Server and client `node_modules` trees are cached separately through
`.github/actions/`. Server cache reuse requires a matching trusted-rebuild stamp.
The setup actions restore the npm download cache only when the workspace needs
`npm ci`. Pull requests can restore these download caches. Other runs can also
save them. Jobs still verify their inputs on a `node_modules` cache hit.

If a selected suite needs the bundled slashdo renderer, the plan enables
shallow initialization of `lib/slashdo`. With `CI_EXPECT_SLASHDO_SUBMODULE`,
the contract suites fail if the submodule is missing. A gitlink change also
selects those contracts.

### Full-suite sharding

`FULL_SUITE_SHARDS` in `scripts/lib/ciPlanOutput.js` sets four server and six
client jobs. `CI_SHARD=<index>/<count>` partitions test files in
`scripts/run-ci-tests.js`, including pins for heavy suites and Chromium setup
costs. The slices are disjoint and cover the selected suite. An empty slice
passes. Server smoke boot runs on shard 1 in a disposable, seeded install
with background integrations disabled. Client lint and production build run
once in separate jobs.

Scoped plans start with one job per selected workspace. Over-budget explicit
or related selections fan out that workspace only (125 server or 400 client
tests). The import graph computes related reach even when only a few files
changed. Full local pregate runs the same server and client slices sequentially.
A matrix uses `fail-fast: false`, so sibling shards finish and their results
remain visible when one fails.

### Browser tests

The browser job owns the server suites in `scripts/lib/browserSuites.js`.
Register a suite that calls `resolveTestChrome()` and use `browserSuiteCanRun()`
so missing required prerequisites fail the browser job. Primary unit runs set
`PORTOS_CI_BROWSER_OWNER=unit` to exclude those suites. The two Chrome shards
own disjoint files. PR smoke excludes cases tagged `[fidelity]`; full hosted CI
runs those cases and still leaves the explicitly tagged `[local-performance]`
case to local fidelity runs. Render settings, tolerances and cleanup assertions
apply in both profiles.

## Native jobs on a push to `main`

Windows runs the curated `WINDOWS_CONTRACT_TESTS` on one runner. They cover
CLI/TUI launch and exact prompt submission, cmd and PowerShell quoting, process
settlement and native path semantics. The real ConPTY regression uses local
stand-ins. Broad functional coverage stays on the primary jobs.

macOS runs `MACOS_NATIVE_TESTS` on `macos-latest` and first probes a real
launchd job with `darwinAgentSupervisor.py --probe`. For a local reproduction
on macOS, run `npm test --prefix server -- --run lib/windowsAgentProcess.darwin.test.js`.
Linux containment uses real bubblewrap. Docker containment and SuperCollider
use native Docker engines, with SuperCollider on amd64 and arm64. Node minimum
coverage installs the workspaces on the oldest supported Node. See the
registries, path rules and live-suite import closures in `scripts/lib/ciPlanRules.js`
and `scripts/lib/ciPlanInputs.js` for the corresponding PR triggers.

A push to `main` runs the primary suite and selects native jobs from the
two-tree diff against the newest green push or scheduled `main` run
(`CI_GATED_BASE_SHA` from `scripts/ci-base-sha.js`). Lookup, fetch or diff
failure selects every native job. A native-gated push produces no
`Full CI Gate`. Scheduled, manually dispatched and release CI run the full
coverage. On `main`, the in-flight push run finishes while only the newest
pending push waits. Scheduled runs have their own concurrency group.

### CI for generated snapshot pushes

A push changing only generated-data paths currently defined in
`GENERATED_DATA_RULES` (`.quality.json`) can run only impact and `CI Gate` when
the newest green run is its first parent. The planner checks the complete
two-tree diff with renames disabled. An empty or unreadable diff, another
changed path or an unverifiable first-parent result keeps the full plan.
A generated-only PR also skips test jobs. These runs publish no
`Full CI Gate` and cannot close a main-health alert.

## Hidden-content gate

The impact job runs `scripts/scan-diff-hidden-content.js` before planning.
It checks added diff lines and filenames for hidden controls, suspicious
encoding, unsafe new symlinks or gitlinks, non-media binary patches and
scriptable markup. The local gate also scans committed, staged, unstaged
and untracked changes. An unreadable diff fails the check. See the scanner
for exemptions. A deliberate local exception uses the visible
`portos-allow-hidden-content` marker on the matching line. External PR
content checked by the model abuse guard cannot grant this exception.

## Guard selection and registration

A new repository-wide scan belongs in the corresponding guard runner:
`server/test/guards/{runtime,modules,repo}.guard.test.js` or
`client/src/test/guards/{a11y,ui}.guard.test.js`. Put the check in the
runner's same-named subdirectory. The runner shares one source corpus and
selecting a changed check selects its runner. Standalone guards use
`*.guard.test.js` and document their reason in `STANDALONE_GUARDS`.
Server guards and explicitly registered cross-install checks and doc-parity
tests run even on ordinary documentation-only PRs. Client guards ride
client JS/JSX changes. The repo-scan guard detects common unregistered
tree scanners. Gate-tooling tests follow their owner paths or relevant
source closures and run in full plans.

The scheduled Linux server job enforces a 4-second per-guard budget.
Other hosted runs warn. The local 2.5-second target is reported in pregate.
Dispatch the hosted enforcement pass with
`gh workflow run ci.yml --ref <branch> -f enforce_guard_budget=true`.

## Diagnosing a run

1. Check the head SHA and the impact summary. A completed impact step only
   establishes that command finished. Its job result also depends on runner
   cleanup and handoff.
2. Open the failed job's summary and test diagnostics. The launcher records
   the invocation, Vitest exit evidence and process-settlement status.
   It enforces a single deadline across passes and the existing worker-crash
   retry, then prints diagnostics and the output tail. On Windows, bounded
   Application Error event 1000 candidates before and after a worker-crash
   retry can narrow the native module involved. Treat missing events,
   incomplete exit evidence, and a green rerun as inconclusive for cause.
3. Rerun failed jobs for a diagnosed transient failure. For complete validation
   use workflow dispatch on the intended ref. `[skip ci]` applies to pushes.
   PR checks still run.

`main-health.yml` opens or updates one alert with failing jobs, a run link and
the merge range since the nearest recorded green run. The most recent
conclusive run attempt governs. Cancellation and capacity-only failures
leave the alert open. Bisect the reported range with the failing suite if
several merges are candidates.

### Release Dependabot CI after review

Dependabot PRs start with admission only. On attempt 1 the impact and
SuperCollider checks stop before dependency installation. Review the diff,
then choose **Re-run all jobs** on the current SHA or use
`gh run rerun RUN_ID`. Repository writers can release the run this way.
A GitHub rerun preserves the original SHA and ref. A new commit requires
fresh review and release of its own run. Bot reruns, labels, PR review state
and rerunning only the gate do not release admission. Tests must pass before
merging.

## Runtime image security (`runtime-image-security.yml`)

This separate workflow inventories pinned pgvector and SuperCollider images
on amd64 and arm64 and the Eidoverse Rapier npm pin. It publishes SBOMs,
vulnerability reports, findings and provenance. Inspect the architecture,
digest, recipe and identified package before changing a pin.

Scanner errors and invalid or incomplete SBOMs fail the workflow. On
scheduled or dispatched runs an actionable pgvector finding can fail it
when a high or critical fix is already in the pinned tag's newest digest.
PRs report these findings while CI Gate remains separate. Native
SuperCollider tests exercise the render boundary.

The independent Eidoverse parent image and lock are a reported coverage
gap. The dependency-update task checks the latest default-branch evidence.
Missing, scanner-failed, unavailable or stale evidence is a gap, including
a recipe mismatch or an artifact older than 14 days.

## Release workflow

Follow [the frozen-candidate procedure](VERSIONING.md#creating-a-release).
`Full CI Gate` mirrors `CI Gate` only when the plan includes full primary
suites, native contracts and hosted full browser coverage.
`scripts/verify-ci-status.js` reuses a successful full check on the pushed
commit or a direct parent whose Git tree equals the pushed tree. Missing,
scoped, failed or unverifiable results trigger complete CI again.

The publisher checks the version and 100 KB limit of `.changelog/RELEASE.md`
and uses its first heading for the release title. A missing file falls back
to commit-derived notes. The tag targets the verified push SHA.
`scripts/verify-release-tag.js` peels an existing annotated tag and requires
the tagged tree to equal the released tree. An invalid target or incomplete
lookup fails publication. The script checks the tag again after publication
and never moves or deletes it.
