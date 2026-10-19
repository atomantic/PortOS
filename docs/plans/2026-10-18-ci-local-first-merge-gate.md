# Local-first merge gate: make pregate the authority for own-agent PRs

Approved 2026-10-18. Audit of the CI and test patterns behind PR merge latency,
and the six changes that follow from it.

## Findings (measured on the last 80 PR runs, 2026-10-17/18)

| Case | Share of PR runs | Wall time | Bounded by |
| --- | --- | --- | --- |
| Scoped plan | 24 of 32 sampled | ~5 min | server related shards (182 s each), browser suites (196 s), DB (115 s) |
| Full plan | 8 of 32 | 8 to 28 min | Windows shards, 10 to 12 min each |
| Queued behind other runs | frequent | 10 to 47 min with a 5 min longest job | account job concurrency |

- Job setup is 10 to 40 s per job; the time is test execution, not overhead.
- "Scoped" is not scoped: a two-file change to `scripts/run-migrations.js` ran
  775 of ~2,600 server test files, 10 browser suites and 72 DB suites, because
  `server/services/taskPromptDefaults/prompts.js` imports the migration runner
  and hundreds of suites reach that module. Over half of each shard is import.
- ~70 merges a day (peak 135) at 8 to 17 jobs per run saturate the 20-job
  concurrency; 22 of 76 runs were cancelled (supersession or capacity).
- Every full plan in the sample came from a lockfile change, `lib/validation.js`
  or `ci.yml`. A pure-JS lockfile bump ran three Windows shards.
- 11% of green runs needed a flake rerun (#11911). A PR handed to the
  pending-merge coordinator while CI is running waits for the 30-minute sweep.
- 98% of merged branches are this install's own agents (1,030 merges in 14
  days; 8 from Dependabot). This machine has every prerequisite CI has
  (18 cores, `portos_test`, Chromium, ffmpeg), but pregate refuses DB, browser,
  build and smoke by design, so a green pregate is weaker than CI.

Closure-hash simulation over the last 12 merges on main: only 4.7% of server
test closures and 0.03% of client closures changed per merge, against the 25%
to 100% CI ran.

## Changes

1. **Closure-hash test memo** in `scripts/run-ci-tests.js` (`scripts/lib/testMemo.js`).
   Key = content hashes of the test's import closure (static, dynamic literal,
   `vi.mock`), literal-path fixtures, resolved versions of reached packages,
   runner config, Node major, platform, behavior-changing env. Fail closed:
   unresolvable inputs, git-reading tests, `ALWAYS_RUN_TESTS` and tree scanners
   are never memoized. Store at `~/.portos/test-memo/` shared by every worktree;
   CI restores it from the nightly main run and never saves on a PR.
2. **Pregate runs the resource suites** (DB on `portos_test`, browser smoke
   profile, client build, boot smoke) when the plan selects them, and writes
   `.cache/pregate/report.json` bound to the validated tree hash.
3. **Pregate attestation**: after the push, a commit status bound to that tree
   hash is posted on the head; the impact planner honors it only for same-repo
   heads created by the repository owner and skips the attested stages. Fork
   and Dependabot PRs see no change. CI stays the authority for outsiders.
4. **Narrower full-plan triggers**: lockfile changes escalate Windows only when a
   platform-sensitive package changed; `validation.js` stops escalating Windows.
5. **Handed-off PRs are polled** at 60 to 120 s until their checks settle
   instead of waiting for the 30-minute sweep.
6. **Fewer jobs per run**: `prompt-history` and `linux-containment` are
   path-gated like `node-minimum`; the migration-runner import edge is removed.

## Non-goals

- No change to the ruleset: `CI Gate` stays the single required check.
- No Windows coverage locally; CI remains the only Windows proof.
- No weakening of the DB guards in `server/lib/db.js`.
