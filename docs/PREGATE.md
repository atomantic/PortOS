# Pregate: the local pre-push gate

Run `npm run pregate` (`node scripts/pregate.js` on Windows) before every push
and again after rebasing onto a moved base. It is local evidence only: hosted CI
([GITHUB_ACTIONS.md](GITHUB_ACTIONS.md)) and provider-enforced checks and
reviews stay mandatory.

## What it runs

`scripts/pregate.js` builds the focused plan in process from the committed,
uncommitted and untracked diff. Default `npm run pregate` runs the hidden-content
scan, early server and client structural
guards, lint, and focused unit tests: edited test files, sibling tests for
changed sources, and tests within two import hops of a changed source: a
relative `import`, `import()` or `vi.mock` specifier that resolves to it (read
through the planner's module graph, `scripts/lib/moduleGraph.js`), or to
a non-test module that does (a suite two modules away, such as a prompt
assembly test reaching a prompt section through its builder). Each hop adds at
most 25 suites per source, the second hop at most 60 per run, nearest hop
first and an importer's own suite before its other referrers; the overflow is
listed under `skipped` in the receipt and left to CI. The second hop never adds the heavy
suites (gate tooling and the pool's exclusive tests, tens of seconds each). The
selector overlaps up to 32 file reads and keeps its ranking independent of
read completion order. Untracked tests count.
A changed non-module file has no import edge (the test memo records loaded
modules, not opened files), so suites that spell its path, or an unambiguous
name, as a quoted string literal are selected too, at most 25 per file and not
the heavy ones; a nested file's bare name counts only while at most 25 suites
spell it. Deeper chains are not selected. Run a focused public-boundary regression for changed behavior that
has no sibling test; automatic selection does not replace engineering
judgment. Focused mode reports directly identifiable resource coverage. Hosted CI
uses import closures and dependency analysis to determine its complete selection.

## Full plan (`--full`)

`npm run pregate -- --full` runs CI's planner and opts into its selected broad suites locally:
server and client tests, the client build, the
boot smoke, browser suites (smoke profile, prerequisites required rather than
skipped), and the serial `portos_test` DB suite last and alone. Each stage
receives the environment the matching job sets. A suite the machine cannot run
(no reachable test Postgres; no Chrome, ffmpeg or client bundler), or one left to CI with
`--skip-db`, `--skip-browser`, `--skip-build` or `--skip-smoke`, is reported
as not run — in the summary and in the receipt `.cache/pregate/report.json`,
which records the plan, stage outcomes and durations, the skipped suites, the
base and HEAD SHAs, and the hash of the exact working tree validated. The
Windows job and the Linux worker-containment job are the two suites only CI
can prove. The
receipt records the tree before and after validation. A change between the two
snapshots fails pregate and leaves a receipt with `treeStable: false`. It also
records `validationMode` (`focused` or `ci`); focused mode marks server and client
results as reduced coverage.

With a resolved remote default or explicit base, focused planning and receipt
verification use four Git calls for a stable clean checkout and six for a stable
dirty checkout whose temporary index is byte-identical at both ends. Dirty
snapshots each stage into a fresh copy of the live index. A different snapshot
index triggers `git write-tree` to check the resulting tree, since stat changes
can alter the index without altering tracked content. Stage subprocesses run
their own checks, including the hidden-content scan.

## Structural guards and dependency check

The early guards run before broad tests and resource probes. Use
`node scripts/pregate.js --guards-only` to run just the structural checks.
Focused runs execute each workspace's selected guards and focused tests in
one stage and run lint on every invocation.
Full runs perform the early checks and keep the CI planner's broad selections.
The receipt records guard outcomes and per-guard wall times (`guardDurations`):
each structural guard runner's checks, and every other guard file whole. A guard
over the 2.5s per-guard target (`scripts/lib/guardBudget.js`) gets a `🐢` line
naming it. Local runs, PRs, pushes and releases warn about slow guards.
The scheduled Linux server job enforces a 4s budget
(`CI_GUARD_BUDGET=enforce`) and runs the always-run guards in a separate Vitest
pass. When selected, the prompt-stage call-site manifest test gets its own
budgeted pass so its source scan does not compete with the other scanners or the
broader test shard. Its selection on PRs and pushes follows the usual impact plan.
`scripts/ensure-deps.test.js` is selected by changes to `ensure-deps.js`,
`update.sh`, `update.ps1` and the lockfiles. Persistent test memo rules and
worker caps still apply.

Before lint or tests, pregate checks installed package versions against all
three workspace lockfiles without modifying dependency trees. A Git worktree
with linked dependencies can continue with a warning when the only discrepancies
are package version mismatches and the combined branch and working-tree diff
leaves npm manifests and lockfiles untouched. Its results reflect the installed
versions. Dependency edits with drift, drift in owned installs, and missing or
unreadable dependency evidence stop lint and tests with a reconciliation
diagnostic. Pregate requires development dependencies (`npm ci --include=dev`
in an owning workspace). A fresh linked worktree whose `node_modules` are
missing (or hold only cache directories) is linked from its primary checkout by
`scripts/link-worktree-deps.js` before the check reruns; pregate never runs npm.
Reconcile shared installs in their owning source checkout when idle. A separate
clone with its own locked installs is also suitable for validation.
`--plan-only` prints the plan without checking installed dependencies.

## Interrupting pregate

Interrupting pregate (Ctrl-C or SIGTERM) does not leave tests running behind
it: the running stage — including the test runner's npm and Vitest
processes, which share that stage's process group — gets the signal and a
5-second grace, then the group is killed until no member remains. Only then
does pregate write an incomplete receipt (`passed: false`) and exit by the
same signal. After every stage, on POSIX, pregate also kills anything still
left in that stage's group, with a warning, so no stage's processes run into
the next one or past pregate.

On POSIX, `npm run pregate` is `exec node scripts/pregate.js`, so no shell
wrapper sits between npm and pregate: a SIGTERM sent to the whole process group
(a CI cancel, `kill -TERM -<pgid>`) cannot kill the wrapper and let npm return
while pregate is still settling its stage. On Windows, where `cmd.exe` has no
`exec`, the repository-root `exec.cmd` shim can run the same command when
cmd's current-directory lookup is enabled. Hardened agent environments may set
`NoDefaultCurrentDirectoryInExePath=1`, which prevents cmd from finding that
shim; run `node scripts/pregate.js` directly instead (or
`node scripts/pregate.js --full` for CI's plan). This Windows form does not
change the POSIX signal behavior.

## Test process containment

Test process containment keeps signal delivery separate from verified
termination. After worker-pool closure, the runner gives its Vitest watchdog
a brief window to exit on IPC disconnect. Owned children that require
containment are logged to stderr; the CI launcher passes
`PORTOS_TEST_PROCESS_DIAGNOSTICS_PATH` to retain a bounded `processes.json` in
its attempt diagnostics. Reports contain
fixed process-kind/settlement categories, never raw process arguments,
environments, PIDs or private paths. Clean teardown takes a single post-close
process-table inventory (the run owner's exit hook skips it once the root is
removed). Unknown/unconfirmed settlement retains the run root
and fails the run; a successful signal alone does not authorize removal.
Interrupted-run sweeps read the process table only when a root has a dead or
long-unknown owner, and retain roots while their deferred escalation is pending.
On POSIX, incomplete process inventories also retain stale roots; a dead runner
does not prove its children exited. Pending identity checks apply to pool-close
cleanup as well as later sweeps.
