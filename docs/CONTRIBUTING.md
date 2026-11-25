# Contributing Guide

Git 2.43 or newer is required for merge validation, detached-checkout retirement and branch-presence checks (`git show-ref --exists`).
The capability check requires both `git merge-tree --write-tree` and `--merge-base`
([Git 2.40 documentation](https://github.com/git/git/blob/v2.40.0/Documentation/git-merge-tree.txt)).
Run `node scripts/checkGitVersion.js` before setup or contribution work; setup and
`npm run doctor` also check it. Upgrade Git (Git for Windows on Windows), ensure
that the running process resolves the upgraded executable first on PATH, and
restart that process if its PATH changed. Unsupported Git fails closed before
merged-tree cloning; structural guards and retirement proofs are never skipped.

Before starting work, read [how to claim an issue and submit a PR](../CONTRIBUTING.md).
Issues labeled `in-progress` or assigned to someone are not available to claim.

PortOS is a highly opinionated, personal project — a single developer's "everything app," built and maintained for that developer's own machine and workflow. It's MIT-licensed and open to the public, but it is **not** built or governed as a general-purpose open source project: there's no roadmap vote, no maintainer team, and no commitment to stability for anyone else's deployment. Read this before opening a PR so expectations are clear going in.

## Before You Open a PR

- **The project prioritizes the author's own needs first.** A PR that's a great idea in the abstract may still be declined or reworked if it doesn't fit how the author actually uses PortOS.
- **Breaking changes ship without warning.** There's no deprecation cycle for external consumers. If you're running a fork, expect to reconcile changes yourself on each pull.
- **Small, focused PRs are far more likely to land than large ones.** If you're proposing a new feature area rather than a fix, consider opening an issue first to check it's a direction the project wants, before investing significant time.
- **Bug fixes, docs corrections, and small quality-of-life improvements are the easiest path in.**

## Platform support and issue triage

macOS is the primary target for the interactive app and browser experience;
Windows is secondary. Linux interactive browser compatibility is not a support
target. Linux server support is unchanged.

Run functional coverage once on the primary environment. Secondary operating
systems and browsers use small smoke checks for basic app/runner failure plus
focused compatibility regressions. For a Safari-specific failure, first express
the generic compatibility contract at the narrowest useful boundary; retain a
small WebKit check when the engine itself is necessary. Do not multiply the full
application suite across browsers or operating systems. Distinct assertions
remain covered even when redundant environment executions are removed.

Native Windows CI targets CLI/TUI launch and prompt submission, cmd/PowerShell
execution and quoting, process cancellation/settlement, and filesystem/path
semantics. Platform-neutral application, media and Git-history workflows run in
the primary server/client jobs. Full, scheduled and release validation retain
the same Windows native contract set; they do not duplicate the application
suite on Windows. Keep native data-ownership and safe-deletion checks intact.

For browser reports, record OS/version, browser/version, rendering engine, and
whether the failure occurs interactively or in a headed/headless test. Include
redacted reproduction evidence and the affected code or check. Before claiming
work whose only reproduction is a Linux browser, establish either reproduction
on macOS or Windows, or concrete impact on shared code, server behavior, security,
or data integrity. If evidence shows the report is confined to unsupported Linux
interactive browser compatibility, close it as not planned and explain that scope.
An inconclusive reproduction does not establish unsupported-only scope.

A headless Linux CI failure may reveal a shared regression or a broken test
contract. Investigate the cause and affected behavior; Linux CI alone is not a
reason to dismiss it. Preserve required checks and report their actual results;
do not skip or weaken them to apply this support policy.

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

`npm run dev` executes `scripts/dev-start.js` to initialize PostgreSQL, stop any existing PM2 processes, and start the full development process set defined in `ecosystem.config.cjs` (`portos-server`, `portos-cos`, `portos-ui`, `portos-autofixer`, `portos-browser`) while tailing logs.

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

1. Work on a branch cut from a freshly fetched `origin/main` (a feature branch or a linked worktree), never directly on `main`
2. PRs to `main` trigger CI tests
3. Follow the [frozen candidate procedure](./VERSIONING.md#creating-a-release): capture `main` at kickoff, validate an isolated candidate, then merge it into `release` to publish
4. Before pushing, follow [Regular Development](./VERSIONING.md#regular-development), then run `npm run pregate` (`node scripts/pregate.js` on Windows) after any rebase and before every push; add `-- --full` (`--full` with `node`) for CI's plan

What pregate runs, its receipt, interrupt and Windows behavior, and test process containment: [PREGATE.md](PREGATE.md). The full shipping contract: [AGENTS.md's Git Workflow](../AGENTS.md#git-workflow) and the [portos-ship skill](../.claude/skills/portos-ship/SKILL.md).

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
groups are never signalled. Unknown ownership is left alone. Owner stamps use
OS-reported birth time rather than wall time minus uptime: a clock adjustment
between process start and configuration must not make a live runner look like a
reused PID. When birth time cannot be read, a signalable owner is retained; a
proven dead owner still permits individually verified descendant cleanup.

The npm Vite/Vitest commands, PM2's `portos-ui` launcher, and subprocess fixtures
use `--configLoader runner` to load ESM configs without writing bundles into shared
`node_modules/.vite-temp`.
For a direct CLI invocation, include that flag too. Vite's default `bundle`
loader writes unique temporary config files into the nearest dependency tree
before config options can redirect caches, so explicitly selecting that loader
opts back into shared scratch. Existing shared caches are left in place.

On Windows, trusted task CLI environments set `TORCHINDUCTOR_CACHE_DIR` to
`<task-cwd>/.cache/torchinductor` unless explicitly configured. Their restricted
projection intentionally need not carry an account name; PyTorch's default
compiler-cache resolver otherwise calls `getpass.getuser()` and can fail before
loading any model. Native Python validation launched from a task inherits this
cache too. Public-content review projections omit it.

Production image/video Python runners use `hfChildEnv`/`safeChildProcessEnv`,
which inherit the server environment rather than the restricted CLI projection.
A normally launched Windows server therefore retains `USERNAME`; the task-only
reproduction does not establish a production failure. These media environments
also default to `<install-root>/data/cache/torchinductor` for servers launched
without account identity. Explicit compiler-cache settings take precedence;
no username is synthesized and no credential allowlist is expanded.

### Changelog

Nothing to write here — there is no per-branch changelog file or fragment.
`/do:release` synthesizes the release notes (the single `.changelog/RELEASE.md`)
from the commit log when it runs,
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

Both DB commands require at least 2 GiB available on each observable PostgreSQL
data and write-ahead log (WAL) volume before schema or fixture writes. The
runner checks after acquiring the run lock. It verifies the connected cluster's
local data directory and follows `pg_wal` to its actual volume, independently
of the checkout or test temp directory. If a known volume is too full, free
space there or target a disposable PostgreSQL cluster with adequate storage.
Remote databases, container filesystems, and directories hidden by permissions
may be unobservable. The commands report any unchecked storage and continue,
including for the hosted CI service. Check capacity on the database host in
those cases.

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

`npm run pregate -- --full` on POSIX or `node scripts/pregate.js --full` on
Windows runs the DB suite when the plan selects it, after every other stage,
against `portos_test` only. When running the DB suite by
hand, run `npm run test:db` after the server and client
suites finish rather than alongside them. A concurrent run is supported —
the database restore suite drains a timed-out case before the next one touches
`portos_test` — but its per-case budgets assume an
unloaded machine, so a concurrent run can time out cases a sequential run
passes.

For the intermittent synthetic gallery-page timeout investigation (#13369),
`PORTOS_DB_PHASE_DIAGNOSTICS=1 npm run pregate -- --full` on POSIX (or the
Windows equivalent with `PORTOS_DB_PHASE_DIAGNOSTICS=1` set in the shell before
running `node scripts/pregate.js --full`) adds wall/CPU timings
for fixture construction, seeding, public calls, EXPLAINs and result
serialization when the plan selects the DB suite. To obtain
the complete serial DB workload regardless of test-memo reuse, run
`PORTOS_DB_PHASE_DIAGNOSTICS=1 npm run test:db` after the earlier validation
stages finish. The observer reads only `portos_test` session state, waits,
transaction ages and run-lock ownership: no query text, network addresses or
record contents. It samples about once a second while a phase is slow (fast
phases need no SQL), at most 32 snapshots per phase, caps each snapshot at 16
sessions, and uses a separate connection with a 500 ms statement timeout.
Opt-in diagnostics add observation work; original test deadlines stay intact.
Failure messages retain bounded phase evidence even with quiet reporting; without
the opt-in they still name the active phase and per-phase elapsed time.
A passing run without a reproduced slow phase does not resolve the timeout.

### Test Strategy: Value Over Assertion Count

- **Default to the highest practical public boundary** (route, service workflow, store adapter, socket exchange, rendered interaction): success plus materially different failure/compatibility paths, not every branch. Don't unit-test a helper a stable caller already exercises, add coverage-only tests, or table-drive permutations proving one outcome.
- **Focused unit tests earn their place** where a higher-level test can't pin behavior precisely or cheaply: parsers/algorithms with a real input matrix; security, privacy, data-isolation and destructive-action guards; migrations and cross-version compatibility; serialization/schema boundaries; retry, timeout and process-lifecycle state machines; edge cases ambiguous through integration. Real timeout behavior gets one fake-time contract test, never repeated production sleeps.
- **Name the regression a new test uniquely catches** before adding it. In review, remove tests that duplicate a stronger assertion, mirror implementation details, only verify mocks calling mocks, or cover impossible states. Count and coverage are diagnostics; CI time, determinism and regression-detection value are the goals.
- **Route tests assert what the route owns, not what it forwards.** With the service mocked that is: refusals (4xx and the service never reached), arguments the route derives (defaults, coercion, clamping, stripped keys, identity from the session or peer headers, which service function a flag selects), error-to-status mapping, response shaping and emitted socket events.
- **No test whose only proof is that a request value reached the mock, or that the body equals what the mock returned.** One success-path test per endpoint may check the identifying argument (the `:id`, the owner) so a swapped parameter fails; the rest of a pass-through belongs to the service suite. One normaliser gets its input matrix once, on the helper or schema, not as N route cases.
- **Pin the argument, not the argument list.** Assert the positions and keys the route owns (`expect(fn.mock.calls[0][0]).toBe(id)`, `expect.objectContaining({ limit: 50 })`). Exact whole-call equality is for cases where absence is the contract (unknown keys stripped, no mass assignment). An optional argument added later must not break an unrelated suite.
- **Prefer the real service when it is cheap.** A file-backed service runs behind the route over `lazyTempDataRoot` + `makePathsProxy` (`server/routes/storyboards.test.js`), asserted through follow-up requests. Mock it when it reaches Postgres, a subprocess, a provider or the network.
- **A router with no validation and no derivation needs no suite of its own.** List it in `UNTESTED_ALLOWLIST` (`server/test/guards/repo/routeTestCoverageConventions.test.js`), naming the service suite that covers it.
- **A test that scans the tracked tree is a structural guard check.** Put it in the `server/test/guards/<subject>/` directory whose subject it scans (`runtime`, `modules`, `repo`; a client scan goes in `client/src/test/guards/{a11y,ui}/`); that subject's `<subject>.guard.test.js` runner loads it, CI and pregate run every server runner on every push and the client runners on any client source change, and the test memo never skips one. Read the tree through `scripts/lib/guardCorpus.js` (and `server/test/guardSources.js`) so the runner lists and reads it once. Keep behavioural tests out of a check, since everything in it runs on every push; when a suite needs one scan, move the scan into a check. `server/test/guards/repo/repo-scan-guards.test.js` fails a scanner outside a guard directory ([how guards are selected](./CI_HIDDEN_CONTENT_GATE.md#guard-selection-and-registration)).

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
[TEST_MEMO.md](./TEST_MEMO.md).

Pull requests into `main` run the tests for affected feature directories, with
conservative fallbacks to the runner's related-test mode or the complete suite; a
pull request into `release`, nightly CI, and manual CI runs always run the
complete server, client, DB, lint, build, and smoke checks. Pushes to `main`
run the full primary CI suite with path-gated native jobs (see
[GitHub Actions](./CI_NATIVE_JOBS.md#native-jobs-on-a-push-to-main)). Release
publication is blocked until a full CI gate has succeeded on the exact tree
being released. See [GITHUB_ACTIONS.md](./GITHUB_ACTIONS.md).

## API Documentation

See [API.md](./API.md) for API conventions and the route-domain index; the complete endpoint list is the API Explorer (`/api-reference/catalog`).

## Reporting Bugs / Proposing Features

Open a GitHub issue. There's no formal triage SLA — this is a side project run by one person — but clear repro steps or a concrete, scoped proposal are much more likely to get picked up than a vague one.

## License

MIT — see [LICENSE](../LICENSE).
