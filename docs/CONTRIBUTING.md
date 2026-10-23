# Contributing Guide

Before starting work, read [how to claim an issue and submit a PR](../CONTRIBUTING.md).
Issues labeled `in-progress` or assigned to someone are not available to claim.

PortOS is a highly opinionated, personal project — a single developer's "everything app," built and maintained for that developer's own machine and workflow. It's MIT-licensed and open to the public, but it is **not** built or governed as a general-purpose open source project: there's no roadmap vote, no maintainer team, and no commitment to stability for anyone else's deployment. Read this before opening a PR so expectations are clear going in.

## Before You Open a PR

- **The project prioritizes the author's own needs first.** A PR that's a great idea in the abstract may still be declined or reworked if it doesn't fit how the author actually uses PortOS.
- **Breaking changes ship without warning.** There's no deprecation cycle for external consumers. If you're running a fork, expect to reconcile changes yourself on each pull.
- **Small, focused PRs are far more likely to land than large ones.** If you're proposing a new feature area rather than a fix, consider opening an issue first to check it's a direction the project wants, before investing significant time.
- **Bug fixes, docs corrections, and small quality-of-life improvements are the easiest path in.**

## Development Setup

Choose the PostgreSQL backend before running `npm run install:all`: install and start Docker with Compose for the default Docker backend, or set `PGMODE=native` in the repository-root `.env` for a fresh native install. Preserve existing settings and check for a conflicting exported `PGMODE`. Existing installs must retain the backend holding their records; see [SETUP.md](./SETUP.md) before changing it.

```bash
# Clone and install
git clone https://github.com/atomantic/PortOS.git
cd PortOS
npm run install:all

# Start development, including Vite on :5554
npm run dev
```

`npm run dev` executes `scripts/dev-start.js` to initialize PostgreSQL, stop any existing PM2 processes, and start the full development process set defined in `ecosystem.config.cjs` (`portos-server`, `portos-cos`, `portos-ui`, `portos-autofixer`, `portos-autofixer-ui`, `portos-browser`) while tailing logs.

**PostgreSQL is a mandatory dependency** — the server fails fast at boot without a healthy database. `npm run install:all` runs `npm run setup:db`, which provisions either the system PostgreSQL (`:5432`) or a Docker container (`:5561`, via `docker-compose.yml`). See [STORAGE.md](./STORAGE.md) and the [Postgres ADR](./decisions/2026-06-07-postgres-as-primary-datastore.md).

For DB-backed tests, provision the separate test database first (`npm run setup:db:test`) and run them via `npm run test:db` — never against the real `portos` database.

## Code Guidelines

### Findings and lint

Resolve every accepted finding, including warnings and nits; severity only sets
work order. Both lint trees fail on warnings. Enable useful rules as errors and
invest effort in high-quality fixes. Difficulty alone is not an exemption.
Previously accepted rules can be reassessed: retire rules that are no longer
useful or have no current solution worth pursuing, recording a concise rationale.
Retired rules stay off, never at warning level. Do not weaken tests or suppress useful
checks to obtain a green result. Follow [the accepted-findings policy](../AGENTS.md#resolve-every-accepted-finding)
for genuine blockers and tracked deferrals.

### General

- Favor functional programming over classes
- Keep code DRY (Don't Repeat Yourself)
- Follow YAGNI (You Aren't Gonna Need It)

### Frontend (React)

- Use functional components and hooks
- Use Tailwind CSS for all styling
- **No `window.alert` or `window.confirm`** - Use inline confirmation components or toast notifications
- **Linkable routes for all views** - Tabbed pages, sub-pages, and forms should have distinct URL routes for bookmarking/sharing

### Routing Pattern

```jsx
// Good - linkable routes
/devtools/history
/devtools/runner
/devtools/processes

// Bad - state-based tabs (not linkable)
/devtools (with local state for active tab)
```

### Backend (Express)

- Use Zod for request validation
- No shell interpolation - use spawn with arg arrays
- Command execution uses allowlist for security

## Git Workflow

See [VERSIONING.md](./VERSIONING.md) for full details.

### Quick Reference

1. Work on `main` branch (or feature branches merged to `main`)
2. PRs to `main` trigger CI tests
3. Follow the [frozen candidate procedure](./VERSIONING.md#creating-a-release): capture `main` at kickoff, validate an isolated candidate, then merge it into `release` to publish
4. Before pushing, follow [Regular Development](./VERSIONING.md#regular-development): verify your branch/upstream and working-tree state, preserve unrelated work, and explicitly fetch the intended base for comparison (the tracking branch may differ); integrate it only for conflicts, enforced branch policy, or evidenced integration risk. Run `npm run pregate` after any rebase and before every push. See [AGENTS.md's Git Workflow](../AGENTS.md#git-workflow) for the full contract.

Pregate first checks installed package versions against all four workspace lockfiles without modifying dependency trees. Stale, missing, or unreadable evidence stops lint/tests with a reconciliation diagnostic. Pregate requires development dependencies (`npm ci --include=dev` in an owning workspace); a production-only installation cannot run its checks. Ordinary worktree links must be repaired only in their owning source checkout; a separate clone with its own locked installs is also suitable for validation. `--plan-only` prints the plan without checking installed dependencies.

Test process containment keeps signal delivery separate from verified termination.
After worker-pool closure, any discovered owned child gets a bounded report in
`.cache/test-process-diagnostics/`; the CI launcher also retains `processes.json`
in its attempt diagnostics. Reports contain repository-relative suite names,
bounded worker IDs and fixed lifecycle/settlement categories, never raw process
arguments, environments, PIDs or private paths. Suite attribution is captured at
child construction and matched by a hash of the PID and birth identity. Children
that bypass the observer (including grandchildren whose parent already exited)
remain explicitly unattributed. Unknown/unconfirmed settlement retains the run
root and fails the run; a successful signal alone does not authorize removal.
Interrupted-run sweeps retain roots while their deferred escalation is pending.
On POSIX, incomplete process inventories also retain stale roots; a dead runner
does not prove its children exited. Pending identity checks apply to pool-close
cleanup as well as later sweeps.

Pregate proves only the stages it runs, and it says which it did not. A scoped
plan runs every suite CI would run for it, in CI's dependency order and with
CI's environment: the hidden-content scan, early structural guards, lint,
server and client tests, the
client build plus the API Explorer bundle pin, the boot smoke, the
cross-workspace browser suites (smoke profile), and the serial `portos_test`
DB suite last and alone — never concurrently with the other suites, and never
against `portos` (both `PGDATABASE` and `PGTESTDATABASE` are pinned and
`TEST_DB_OK` is removed from the stage's environment). A full-suite plan runs
only the always-run guards unless `--full` is supplied, which runs everything
above as well.

A suite stays with CI, and is named as not run in the summary, when:

- you pass `--skip-db`, `--skip-browser`, `--skip-build` or `--skip-smoke`;
- a full plan was downgraded (no `--full`);
- a prerequisite is missing — no Postgres answering at the resolved endpoint
  (exported `PG*`, then the checkout's `.env`, then `localhost:5432`), or no
  Chrome, ffmpeg or client bundler for the browser suites. The line names the
  remedy; the run continues.

The shipped prompt-history guard (CI's `prompt-history` job) runs locally
when the planner selects it. The Windows job and the Linux worker-containment
job (bubblewrap namespaces) are the two suites only CI can prove; both are
named as not run. Every run writes a receipt to
`.cache/pregate/report.json` (gitignored): the plan, each stage's outcome and
duration, the suites not run and why, the base and HEAD SHAs, the Node
version, platform and worker budget, and the hash of the exact working tree
that was validated — untracked and uncommitted files included, so a later
commit of that state yields the same `HEAD^{tree}`. A green summary never
claims a suite it skipped; required CI checks still apply.

Always-run and diff-selected structural guards run before broad test stages
and browser/database prerequisite probes. Their successful results are reused
only within that run while the working tree, index, HEAD and refs are unchanged;
the receipt records guard outcomes and reuse proofs. This leaves the persistent
test memo's stricter rules intact. `--guards-only` and downgraded full plans
run that same guard selection once.

Interrupting pregate (Ctrl-C or SIGTERM) does not leave tests running behind
it: the running stage — including the test runner's npm and Vitest
processes, which share that stage's process group — gets the signal and a
5-second grace, then the group is killed until no member remains. Only then
does pregate write an incomplete receipt (`passed: false`) and exit by the
same signal. After every stage, on POSIX, pregate also kills anything still
left in that stage's group, with a warning, so no stage's processes run into
the next one or past pregate.

`npm run pregate` is `exec node scripts/pregate.js`, so no shell wrapper sits
between npm and pregate: a SIGTERM sent to the whole process group (a CI
cancel, `kill -TERM -<pgid>`) cannot kill the wrapper and let npm return while
pregate is still settling its stage. On Windows, where `cmd.exe` has no
`exec`, the repository-root `exec.cmd` shim (found first in the working
directory) runs the same command.

After the push (and, when you open the pull request yourself, before
`gh pr create`), `node scripts/pregate-attest.js` posts that receipt as a
`pregate` commit status on the pushed head, bound to the validated tree and
naming the platform and Node it ran on, and the pull request's impact planner
skips the stages it attests to (only stages that ran and passed; never
Windows, Linux containment, SuperCollider live containment or the Node-minimum check; and, per stage, never
one that a change `main` gained since the branch forked could reach). It
refuses — saying what to rerun — when the receipt did not pass, the tree
changed after pregate, the commit is not on the upstream remote yet, or
nothing attestable ran, and it attests no server, client or lint stage from
a receipt planned with `--base` against something other than the default
branch's merge base; a refusal just means CI runs everything as before.
`--dry-run` prints the status without posting it; `--revoke "<reason>"`
withdraws every earlier attestation on the commit. Only a repository writer
can create the status and only the repository owner's newest one counts, so
fork and Dependabot pull requests are unaffected. Contract and inspection:
[Pregate attestation](GITHUB_ACTIONS.md#pregate-attestation).

PRs run the browser suites' smoke profile; the `[fidelity]` cases run nightly
and on the release PR. To check them on a rendering PR before merging, run
`node scripts/browser-fidelity.js --pr NUMBER` from the clean published head. See
[Browser fidelity cases](GITHUB_ACTIONS.md#browser-fidelity-cases).

### Checkout-owned development caches

Vite dev mode stores reusable dependency data in `client/.cache/vite`. Vitest
uses `client/.cache/vitest`, `server/.cache/vitest`, and the separate
`server/.cache/vitest-db` for DB suites. These ignored directories are anchored
to the config file, including the server's derived capture projects, so shared
`node_modules` links and a different invocation directory do not share writers.
They are reused across runs and removed with their checkout; temporary test
roots retain their separate teardown lifecycle. CI caches the same owned paths.

Interrupted test runs reclaim individually identified processes under their run
roots, including non-browser fixtures. Linux reads same-user `/proc` records;
macOS uses the existing `/usr/bin/python3` with standard-library `ctypes` to read
NUL-delimited arguments and selected test environment fields. No Python install
is performed. If that optional reader is unavailable, macOS retains the legacy
browser-profile cleanup only. Process identity, caller ancestry and run-owner
liveness are rechecked before termination and escalation; unrelated process
groups are never signalled. Unknown ownership is left alone.

The npm Vite/Vitest commands, PM2's `portos-ui` launcher, and subprocess fixtures
use `--configLoader runner` to load ESM configs without writing bundles into shared
`node_modules/.vite-temp`.
For a direct CLI invocation, include that flag too. Vite's default `bundle`
loader writes unique temporary config files into the nearest dependency tree
before config options can redirect caches, so explicitly selecting that loader
opts back into shared scratch. Existing shared caches are left in place.

### Changelog

Nothing to write here — there is no per-branch changelog file or fragment.
`/do:release` synthesizes the release notes from the commit log when it runs,
so write commit subjects/bodies for a human release-note reader (see Commit
Messages below). See [`.changelog/README.md`](../.changelog/README.md) for
details.

> **Note:** Some older code or automation notes may still reference a `dev` branch workflow. The frozen-candidate→`release` workflow described here is the current source of truth.

### Line Endings on Windows

`.gitattributes` pins `eol=lf` for text files across all platforms. To normalize
tracked files in an older Windows clone, first commit or stash unrelated work
(including staged changes). Then run from the repository root:

```bash
git add --renormalize .
git diff --cached --stat
git diff --cached
```

This reapplies the current attributes to tracked files in the index without
overwriting working files. It also stages any other tracked edits or deletions,
which is why unrelated work must be saved first. Commit only if the reviewed
diff contains the intended normalization changes; an empty diff needs no commit.
Do not use `git reset --hard` for this repair: it discards uncommitted tracked
changes.

### Commit Messages

Use conventional commit prefixes with a human-readable subject — a future reader of `git log --oneline` should understand the change without opening the diff:

```
feat: add a --dry-run flag to the backup CLI
fix: daily log no longer double-saves on blur
docs: point the API allowlist at commandSecurity.js
```

## Project Structure

```
PortOS/
├── client/           # React + Vite frontend (Vite dev server on port 5554 under npm run dev)
│   └── src/
│       ├── components/
│       ├── pages/
│       └── services/
├── server/           # Express.js API (port 5555)
│   ├── routes/
│   ├── services/
│   └── lib/
├── data/             # Runtime data (gitignored)
├── docs/             # Documentation
└── .github/workflows # CI/CD
```

## Testing

Run these commands from the repository root:

```bash
# Run server tests (Vitest, node environment)
npm test --prefix server

# Run client tests (Vitest, happy-dom environment)
npm test --prefix client

# Provision and run the isolated DB-backed suites (portos_test only)
npm run setup:db:test
npm run test:db
```

Every worktree shares one `portos_test`, and some DB suites restore a whole-database
dump, so `test:db` takes a session-level Postgres advisory lock for the run
(`server/test/dbRunExclusivity.js`). A second run from another worktree prints
`Another DB test run holds portos_test` and waits for the first to finish.

### Repairing a test database whose extensions were dropped

The application role cannot create extensions. `backup.db.test.js` used to
rebuild `portos_test` with `DROP SCHEMA public CASCADE`, which dropped `vector`
and `pgcrypto`; it now removes only application objects and leaves them
installed, and refuses to start (before changing anything) if they are missing.
A test database an older checkout already stripped needs a one-time repair by a
superuser, after which `npm run setup:db:test` works with the ordinary role:

```bash
psql -d portos_test -c 'CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto;'
npm run setup:db:test
```

Do not grant the application role superuser to avoid this step.

Supported full local validation uses the CI worker budget. An unbounded
`npm test` can oversubscribe a loaded machine: real media, prompt-catalog,
and nested-worker cases then hit their existing budgets. A green focused
file run is evidence for that file only, not a full-suite result.

```bash
# Server, then client. Workers derive from the CoS max-concurrent-agents setting
# (cores / agents, capped at 4; client stays at 2). Lower it in the app to ease host load.
npm test

# Focused evidence for one file:
npm test --prefix server -- services/creativeDirector/videoAssembly.test.js
```

`npm run pregate` runs the DB suite itself when the plan selects it, after
every other stage, against `portos_test` only. For release validation by
hand, run `npm run test:db` after the server and client
suites finish rather than alongside them. A concurrent run is supported —
the database restore suite drains a timed-out case before the next one touches
`portos_test` — but its per-case budgets assume an
unloaded machine, so a concurrent run can time out cases a sequential run
passes.

For server watch mode, run this alternative from the repository root:

```bash
npm run test:watch --prefix server
```

`npm run pregate` (and CI, through the same runner) also consults the test
memo: a selected test file whose every input — the modules it loads, the
fixtures and package versions it reaches, the Node major and platform, and
the gating environment variables — is byte-identical to a run that already
passed is skipped, and new green results are recorded under
`~/.portos/test-memo/`. Tree-wide scanners and anything that reads repository
state are never memoized. `PORTOS_TEST_MEMO=off` disables it, and
`PORTOS_TEST_MEMO_VERBOSE=1` lists the skipped files; see
[GITHUB_ACTIONS.md](./GITHUB_ACTIONS.md#test-memo).

Pull requests into `main` run the tests for affected feature directories, with
conservative fallbacks to the runner's related-test mode or the complete suite; a
same-repository pull request whose pushed head carries a pregate attestation
skips the stages that receipt proved (see the Git Workflow section). The
pull request into `release`, nightly CI, and manual CI runs always run the
complete server, client, DB, lint, build, and smoke checks. Pushes to `main`
run nothing — the pull request gate already covered that tree. Release
publication is blocked until a full CI gate has succeeded on the exact tree
being released. See [GITHUB_ACTIONS.md](./GITHUB_ACTIONS.md).

## API Documentation

See [API.md](./API.md) for the complete REST API and WebSocket event reference.

## Reporting Bugs / Proposing Features

Open a GitHub issue. There's no formal triage SLA — this is a side project run by one person — but clear repro steps or a concrete, scoped proposal are much more likely to get picked up than a vague one.

## License

MIT — see [LICENSE](../LICENSE).
