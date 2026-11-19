# Pregate: the local pre-push gate

Run `npm run pregate` (`node scripts/pregate.js` on Windows) before every push
and again after rebasing onto a moved base. It is local evidence only: hosted CI
([GITHUB_ACTIONS.md](GITHUB_ACTIONS.md)) and provider-enforced checks and
reviews stay mandatory.

## What it runs

`scripts/pregate.js` runs CI's planner over the committed, uncommitted and
untracked diff and hands its plan to the same runners. Default `npm run pregate` runs the
hidden-content scan, early server and client structural
guards, lint, and focused unit tests: edited test files, sibling tests for
changed sources, and tests within two import hops of a changed source: a
relative `import`, `import()` or `vi.mock` specifier that resolves to it, or to
a non-test module that does (a suite two modules away, such as a prompt
assembly test reaching a prompt section through its builder). Each hop adds at
most 25 suites per source, the second hop at most 60 per run, nearest hop
first and an importer's own suite before its other referrers; the overflow is
listed under `skipped` in the receipt and left to CI. The second hop never adds the heavy
suites (gate tooling and the pool's exclusive tests, tens of seconds each). Untracked tests count.
A changed non-module file has no import edge (the test memo records loaded
modules, not opened files), so suites that spell its path, or an unambiguous
name, as a quoted string literal are selected too, at most 25 per file and not
the heavy ones; a nested file's bare name counts only while at most 25 suites
spell it. Deeper chains are not selected. Run a focused public-boundary regression for changed behavior that
has no sibling test; automatic selection does not replace engineering
judgment.

## Full plan (`--full`)

`npm run pregate -- --full` opts into the CI-selected broad suites locally:
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
receipt also records `validationMode` (`focused` or `ci`); focused mode marks
server/client results as reduced coverage, and either mode is local evidence
only.

## Structural guards and dependency check

The early guards use the same always-run and diff-selected structural selection
as CI and `--guards-only`. They run before broad tests and resource probes.
Successful guards are reused within this invocation only when the working tree,
index, HEAD and refs remain unchanged; otherwise the broad runner executes them
again. Across invocations, a structural-guard or lint stage that passed earlier
is reused (`⏭️ … reused from <time>`, recorded as the stage's `reusedFrom`) only
when its key matches: the exact working tree (raw bytes where Git normalizes line
endings), tracked paths and modes, Git config, ignored paths outside caches/build
output/`data/`, installed dependency manifests, submodules, base SHA, Node/Git
toolchain, environment and the stage's own command and file list. HEAD is not part
of it, so committing validated content keeps the pass. `--full`, `--guards-only`
and `PORTOS_TEST_MEMO=off` always rerun them. The receipt records guard outcomes, reuse proofs and per-file guard
durations (`fileDurations`). A guard file over the 3s per-file target
(`scripts/lib/guardBudget.js`) gets a `🐢` line naming it, but never fails local
pregate: wall time on a machine running several agent gates measures the host,
not the guard, and a slow pass stays reusable. The scheduled hosted run enforces a 6s budget,
calibrated to its slower runner, on its Linux server job (`CI_GUARD_BUDGET=enforce`), where the always-run guards run
as their own Vitest pass before the rest of the selection; PR, push and release runs
only warn (`CI_GUARD_BUDGET=report`). There are no per-file exceptions. `scripts/ensure-deps.test.js`
is not always-run: it is selected by changes to `ensure-deps.js`, `update.sh`,
`update.ps1` and the lockfiles. Persistent test
memo rules, required stages and worker caps remain the same. Downgraded full
plans and `--guards-only` run the guard selection once; `--full` runs it before
the full suites.

Before lint or tests, pregate checks installed package versions against all
four workspace lockfiles without modifying dependency trees. Stale, missing or
unreadable evidence stops lint/tests with a reconciliation diagnostic. Pregate
requires development dependencies (`npm ci --include=dev` in an owning
workspace); a production-only installation cannot run its checks. A fresh
linked git worktree whose `node_modules` are missing (or hold only cache
directories) is linked from its primary checkout automatically, once, by
`scripts/link-worktree-deps.js` before the check reruns; pregate never runs npm.
A dangling link, stale versions and real directories keep the diagnostic. Ordinary
worktree links must be repaired only in their owning source checkout; a
separate clone with its own locked installs is also suitable for validation.
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
termination. After worker-pool closure, any discovered owned child gets a
bounded report in `.cache/test-process-diagnostics/`; the CI launcher also
retains `processes.json` in its attempt diagnostics. Reports contain
repository-relative suite names, bounded worker IDs and fixed
lifecycle/settlement categories, never raw process arguments, environments,
PIDs or private paths. Suite attribution is captured at child construction and
matched by a hash of the PID and birth identity. Children that bypass the
observer (including grandchildren whose parent already exited) remain
explicitly unattributed. Unknown/unconfirmed settlement retains the run root
and fails the run; a successful signal alone does not authorize removal.
Interrupted-run sweeps retain roots while their deferred escalation is pending.
On POSIX, incomplete process inventories also retain stale roots; a dead runner
does not prove its children exited. Pending identity checks apply to pool-close
cleanup as well as later sweeps.

## Merged-base guard diagnostic

`npm run pregate:merged -- --merged-with <base-ref>` (the same as
`node scripts/pregate.js --guards-only --merged-with <base-ref>`) runs the
structural guards on HEAD merged with a fetched base in an isolated temporary
repository. It is an opt-in diagnostic for investigating an integration break,
not a merge precondition: no PortOS merge path runs it. The pending-merge sweep
and the quality-snapshot publisher merge when the forge reports the PR mergeable
with its required checks green, pinned to the recorded or published head. CI
already tests each pull request on its merge ref, skips every runner for a
`.quality.json`-only change because no guard reads that file, and scheduled CI
on `main` publishes `Full CI Gate` as the post-merge backstop.
