# CI Native Jobs (Windows and macOS)

Windows and macOS CI jobs, their failure evidence and cancellation rules. Split out of [GITHUB_ACTIONS.md](GITHUB_ACTIONS.md); the workflow overview stays there.

## What a full plan costs the Windows job

Windows CI covers the supported native boundary: CLI/TUI launch and prompt
submission, cmd/PowerShell execution and quoting, process cancellation/settlement,
and filesystem/path semantics. It runs the explicit `WINDOWS_CONTRACT_TESTS`
registry on one Windows runner. It does not follow the application import graph
or duplicate platform-neutral application suites, including on full, scheduled
and release validation. Full primary server/client/browser/database coverage is
unchanged. Worker concurrency remains two and existing deadlines remain intact.

Native changes and Windows-installed dependency/tooling changes select the native
job. Client-only configuration, known platform-neutral schema/package changes
and ordinary application changes do not select it. An explicit full run includes
it. A missing native inventory fails plan publication instead of producing a
successful empty Windows job. Required `CI Gate` still waits for every selected
job. `Full CI Gate`, used for release reuse, requires a full primary plan and the
selected native Windows contract set, with a successful aggregate gate.

## Primary functional coverage and secondary compatibility

Run the functional suite once on the primary environment. Secondary OS/browser
coverage consists of basic app/runner smoke checks and focused compatibility
regressions. A Safari-specific report should yield a generic compatibility
contract where possible, or a small WebKit regression when the engine is
necessary, rather than a second full application suite.

The current browser job uses Chrome/Chromium via `scripts/lib/testChrome.js`.
Its two jobs are disjoint file shards selected by `CI_SHARD`; they are not two
browser engines or duplicate executions of every suite. Each selected browser
file runs once. No Firefox/WebKit full-suite matrix exists to remove. Existing
browser suites retain their distinct substantive assertions; this audit adds no
speculative cross-browser matrix.

## Windows native contract coverage

The canonical registry is `WINDOWS_CONTRACT_TESTS` in `scripts/lib/ciPlanRules.js` (25 files):

| Boundary | Retained suites |
| --- | --- |
| CLI launch, lookup, environment and cwd | `allowedCommands`, `agentGuard/index`, `bashResolver`, `bufferedSpawn`, `cliProviderRun`, `detachedSpawn`, `processEnv`, `processEnv.spawnOptions`, `spawnCwd` |
| Shell dialects and TUI submission | `shellCd`, `shellExit`, `shellLivenessProbe`, `shellReadinessProbe`, `tuiPromptRunner`, `shell.windows` |
| Native cancellation, ownership and filesystem safety | `execGit`, `windowsAgentProcess`, `windowsGitProcess`, `windowsGitProcess.protocol`, `gitRepositoryIdentity`, `worktreeOwnership`, `staticImportGraph`, `nativeTrash`, `nativeTrash.smoke` |

`server/services/shell.windows.test.js` uses real ConPTY with cmd and PowerShell,
a tiny local CLI stand-in and synthetic prompt/reply files. It verifies exact
prompt submission, child environment and working-directory handling with spaces,
metacharacters and literal brackets. It also checks native path casing and
separator containment. It calls no provider and loads no model.

Application routes, PM2 parsing/standardization, media and ML jobs, provider
selection policy, static source pins and broad Git-history/archive workflows
remain covered in the primary jobs. No migration, data-integrity, security,
ownership, cleanup or cancellation assertion is deleted for this selection
change. In particular, `primaryCheckoutGuard.test.js` and `worktreeReap.test.js`
still test shipping ownership/retirement behavior on the primary runner. Their
broad real-Git histories/configuration fixtures are not native CLI contracts.
Native Git child ownership and settlement remain independently exercised on
Windows; a failure there must still be fixed, not hidden by this boundary.

## macOS native release-agent supervision

macOS is the primary interactive target, and release agents there run under
the launchd-coalition supervisor (`server/lib/darwinAgentSupervisor.py`). Its
real-process boundary suite, `server/lib/windowsAgentProcess.darwin.test.js`,
skips on every other platform. The `macos-native` job (`macos-latest`) runs that
file (`MACOS_NATIVE_TESTS` in `scripts/lib/ciPlanRules.js`), so native supervision
remains a required check. Release pre-flight uses platform-neutral Git/GitHub
checks and also runs in the Windows contract set.

macOS runners are the scarcest hosted capacity, so the job is gated by an
explicit path list (`MACOS_NATIVE_PATH_RE`), not an application import closure. On a pull request the
`macos_native` plan key is true only when the diff touches
`server/lib/windowsAgentProcess*.js`, `server/lib/darwinAgentSupervisor.py`,
the server Vitest harness
(`server/vitest.config.js`, `server/vitest.setup.js`,
`scripts/vitestTempRootSetup.js`), the install inputs
(`server/package.json`, `server/package-lock.json`, `server/.npmrc`,
`scripts/trusted-rebuilds.js`) or `ci.yml`. A push gates it the same way; non-push
full runs and pull requests into `release` always run it. It is part of `CI Gate`; a skipped run passes.

Before the suites, the job runs the supervisor's own `--probe`: a real
single-use launchd job round trip. A runner whose user domain refuses
`launchctl bootstrap` fails that named step rather than an assertion inside
the suite. Pregate reports the job as CI-only; on a Mac, run
`npm test --prefix server -- --run lib/windowsAgentProcess.darwin.test.js`.

## Windows selection for mixed changes

Windows source changes select the curated contracts directly, with no related
application consumers. Linux retains the complete diff-selected server coverage.
The representative `windowsGitProcess.protocol.test.js` plus `zodCompat.js` diff
therefore retains the schema's primary-platform coverage while selecting the
native Windows set on one runner.

Pipeline/full plans select one Windows job over the native suites (the curated set
can grow as native contracts are added). This is a selection/setup reduction, not
an execution-time or runner-minute speedup claim. The actual rendered API Explorer
contracts and production client build remain.

## Windows full-suite capacity

Windows full-run timing is not a controlled before/after measurement and does not
establish a startup cause or a runtime improvement from selection changes. The
Metal profile cache persistence test (130 concurrent learn updates against a
temporary JSON cache) keeps its value on the primary platform and does not justify
a native Windows media suite. The native TUI fixture writes only a small script
and synthetic reply per shell, with no repository/dependency copy, media payload
or model data; cleanup waits for actual ConPTY exit before removing it.

## Native jobs on a push to `main`

A push to `main` runs the complete primary suites. The six native job
families (SuperCollider, Windows, macOS, Linux and Docker
containment, Node minimum) follow the tree diff since the last green `main`
run, decided as a pull request with that diff would be. `scripts/ci-base-sha.js`
(opted in by `CI_GATED_BASE_LOOKUP`, never on a release `workflow_call`) makes
one Actions API call for the newest successful `push` or `schedule` run of
`ci.yml` on `main`, fetches its head at depth 1 and exports
`CI_GATED_BASE_SHA`; the planner diffs it against `HEAD` (two-dot,
`--no-renames`). Any lookup, fetch or diff failure runs every native job.
Scheduled, dispatched and release runs are unchanged. A gated push publishes no `Full CI Gate`
(`native_gated`): it is not complete-run evidence for release reuse.
Snapshot-only pushes: [CI_SNAPSHOT_PUSHES.md](CI_SNAPSHOT_PUSHES.md).

A merge commit on `main` is tested because a PR gate only proves the PR
against the base it was built on: two PRs that were each green can merge into a
red result, and a direct push skips the gate. There is no merge coordinator (#12247
and #14185 built and removed one).

`main-health.yml` runs `scripts/ci-nightly-report.js` after main CI pushes and
schedules. It needs its own workflow because release.yml calls `ci.yml` without
`issues: write`.

A red verdict creates or updates one "main is red" issue with jobs, range and
run link. It uses `bug`, `area:ci`, `model:medium` and `effort:medium`.
The summary lists merges since the nearest older green run and flags an unknown
range. To bisect, rerun the failing suite at the midpoint merge. A green verdict closes the issue and appends the run link.
Cancellation and runner-capacity-only failures leave the issue as it was.

Before writing, the reporter orders recent `ci.yml` push and scheduled runs by
GitHub run number. A newer run's latest conclusive attempt supersedes older
events. Pending and inconclusive retries preserve prior verdicts. An event
must match its own run's current attempt, so a green retry can close that
run's alert. Green events with no alert skip the lookup. An unreadable verdict
fails the reporter and leaves the issue untouched. Issue read or write
failures also fail the reporter.

Changes to CI/test configuration also force the full suite on their own PR.
`[skip ci]` remains honored for push events only; PR CI always runs.

## Windows native worker crash evidence

When Vitest reports a worker exit with a crashed test filename, the test
launcher queries Windows Application Error event 1000 before the existing
single-file retry, and again if that retry crashes. Each query is limited to
the failed invocation's time window, 32 events and 10 seconds. Logs and the
step summary retain at most ten Node event candidates: Node/module versions,
module basename, exception code and fault offset. Raw event messages, paths,
machine identity and memory dumps are excluded. Diagnostic failures do not
change the test result or add retries.

These events can narrow the native module involved; they do not establish
causality or identify the triggering operation. A missing or unavailable
event is explicitly inconclusive. Correlate candidates with the crashed
test and a minimal Windows reproduction before changing production metadata
handling (#8152). Microsoft documents these fields in its
[application crash troubleshooting guide](https://learn.microsoft.com/en-us/troubleshoot/windows-server/performance/troubleshoot-application-service-crashing-behavior).

## Final test process exit evidence

The run report retains the exit-code snapshot from Vitest's normal hooks and
adds the later Node `exit` event code and `process.exitCode` in a synchronous,
best-effort write. The invocation report records the observed command boundary
(`direct npm process`, or `cmd.exe -> npm.cmd` when a batch wrapper is needed), its child `exit` and `close`
events, and the launcher's effective status. Collection prints only bounded
numeric status and allowlisted boundary names. Missing exit evidence stays an
explicit diagnostic gap; diagnostic I/O never changes the original result.

An exit event is later evidence, not proof of a cause or of every subsequent
exit listener's behavior. When a Windows batch wrapper is needed, npm's own process exit is still not
observed independently of `cmd.exe`; a passing Vitest exit with a failing
command boundary narrows the remaining investigation to that boundary. Forced
termination can prevent any exit-event write. Preserve the first failing job
and compare these observations on a hosted recurrence rather than classifying
a green rerun or a synthetic fixture as a causal fix (#12536).

## External cancellation and one automatic retry

Not every cancel comes from this repository. When several PRs build at once,
GitHub itself cancels in-flight runs — no job fails, and **no successor run exists for the branch** (issue 7437).
That last property is the whole diagnosis: a `cancel-in-progress` supersession
always leaves a newer run for the same PR, and an external cancel leaves none.

`.github/workflows/ci-cancel-recovery.yml` listens for completed CI runs.
Only first-attempt cancelled PR runs allocate a recovery runner, and an
eligible run is re-dispatched exactly once. `scripts/ci-retry-cancelled-run.js`
retries only when every one of these holds:

| Guard | Why |
| --- | --- |
| conclusion is `cancelled` | A failure is a failure. |
| event is `pull_request` | Nightly, dispatch, and release-called runs are not ours to re-drive. |
| `run_attempt == 1` | The retry budget. `POST /rerun` makes attempt 2, whose cancel sees attempt 2 and stops — one retry per run, and a PR run is one run per head SHA. |
| no job concluded `failure`/`timed_out` | A run cancelled while one job was already red *looks* cancelled. Retrying it would re-run the suite on a broken tree. |
| no job hit its own `timeout-minutes` | GitHub reports a timed-out job as `cancelled`; only its check-run annotation ("exceeded the maximum execution time") tells it from an external cancel (#11910). A re-run would time out again, so it skips as `job-timed-out`. |
| no newer run for the branch | That is a supersession; the newer run already covers this code. |

Any API lookup that cannot be completed skips the retry rather than assuming a
guard passed — a missed retry costs one manual re-run, a wrong one loops.

**The re-dispatch waits 60 seconds first** (`RETRY_DELAY_MS`). This gives
cancellation records time to settle while limiting the time a hosted runner
sits idle. The recovery job's timeout leaves headroom above `MAX_RUNTIME_MS`,
which covers the delay and two worst-case guard passes. The workflow wiring
test checks that the job timeout exceeds that bound.

Every API-backed guard in the table is evaluated **twice**: once before the wait
and once after it. A push or a human re-run that lands during the delay
therefore still wins, and the post-wait job listing is the more reliable one —
a failing job's step records can still be settling when a cancel lands.

The two passes are **not** equal in authority. The post-wait pass is the reading
the re-dispatch is made on, and it fails CLOSED as before. The pre-wait pass is
only an optimization — it exists so an obviously ineligible run skips without
holding a runner idle — so **only a definitive `skipped` verdict short-circuits
there.** An `unavailable` reading before the wait is not evidence of
ineligibility, and a saturated GitHub is exactly when a transient 5xx is
likeliest, so it falls through to the wait and lets the post-wait pass decide.
Forfeiting the retry on a blip would lose the very case the delay was added to
win.

The step summary records `phase: before-wait | after-wait` and the `delay` it
used, so the Actions history can be read back as evidence when the constant is
tuned — under the delay that actually produced each outcome, not today's value.

Deliberately **not** chosen: polling `GET /actions/runs?status=in_progress` and
retrying only once the repository is quiet. On a busy repo that can mean never
retrying, which is worse than retrying into a cancel.

**Why the failing-job guard reads the jobs' own conclusions** rather than a
marker a failing job writes: a marker fails OPEN. A lost write makes a red run
look externally cancelled, and it gets retried. Reading conclusions fails CLOSED: an unreadable listing is
`jobs-unavailable` and skips the retry. Do not "simplify" this into a marker.

**This is also the only layer that can explain a run-wide cancel.** `if:
always()` on the gate defeats an upstream failure, not a cancellation of the
whole run — so in the external-cancel case the gate is cancelled too and never
prints its verdict. The recovery run is a separate run, so it survives; its
step summary records which guard applied.

That summary lives on the recovery run, which nobody finds from the pull
request, so the workflow also **publishes the verdict back onto the cancelled
head SHA as a check run** named `CI cancel recovery` (issue #7438). It carries
the same fixed reason code the step summary renders — `superseded`,
`job-failed`, `job-timed-out`, `re-dispatched`, `retry-budget-exhausted`, `run-state-moved-on`,
or one of the `*-unavailable` lookup failures — plus one sentence saying what
to do about it.

The check's conclusion is **always `neutral`, and that is load-bearing**.
Branch protection requires `CI Gate` alone, so a `failure` here would block a
merge the repository allows; and `success` would read as a passing gate —
PortOS's own auto-merge watcher (`server/services/prWatcher.js`) counts
`NEUTRAL` as green. Neutral is the only conclusion that stays informational to
a human and to that watcher alike. Publishing is best-effort for the same
reason the retry is: a recovery job must never turn red on top of an
already-cancelled run, so a rejected or failed publish is logged and swallowed
and the job still exits 0. The only extra grant this needs is `checks: write`;
a `contents:`/`pull-requests: write` token on a `workflow_run` workflow is what
would turn an informational job into a push surface.

One known limit, filed: a retry re-runs the whole suite — Windows shards
included — so if the cause is the spending limit then recovery spends more of
it. Reducing the billable minutes of a full run is the complementary root-cause
lever (#7440).

Because the trigger is `workflow_run`, the recovery workflow runs the
**default branch's** copy of itself with writable `actions` and `checks`
tokens, and never checks out, installs, or executes the pull request's head.
The only PR-derived values it touches are validated run ids and one
URL-encoded branch name.

Reader-facing symptoms, the `gh` commands that tell an external cancel from a
supersession, and the account-billing check that confirms the upstream cause
are in [TROUBLESHOOTING.md](TROUBLESHOOTING.md) under "CI cancelled with no
successor run".
