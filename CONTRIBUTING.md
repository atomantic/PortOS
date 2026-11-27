# Contributing to PortOS

PortOS is a personal project that prioritizes its author's workflow. Bug fixes,
documentation corrections, and small quality-of-life improvements are good places
to start. Discuss larger changes in an issue before investing time. Read
[ETHOS.md](ETHOS.md) for the design commitments and [AGENTS.md](AGENTS.md) for
repository instructions, including the single-user security model and conventions
for coding agents.

## Claim an issue before starting

1. Search existing issues and PRs. Open an issue if you have a clear reproduction
   or a scoped proposal without an existing match. The `help wanted` and
   `good first issue` labels are good starting points.
2. Choose an open issue with no assignee or `in-progress` label. Check recent
   comments for coordination already underway.
3. Comment with a brief outline of your proposed approach and wait for the
   maintainer to assign you before implementing it.

If you can no longer work on a claimed issue, leave a comment so the maintainer
can make it available again.

## Platform support and issue triage

macOS is the primary interactive app and browser target. Windows is secondary.
For browser reports, include the OS and browser versions, rendering engine, and
whether the failure occurs interactively or in a headed or headless test.
If the only reproduction is on a Linux browser, establish either a reproduction
on macOS or Windows or an impact on shared code, server behavior, security, or
data integrity before claiming it. Include redacted reproduction evidence and
the affected code or check. Investigate headless Linux CI failures for shared
regressions or broken test contracts, and preserve required checks.

## Development setup

Use Git 2.43 or newer and check the `engines` field in [package.json](package.json)
for supported Node.js and npm versions. See [the Setup Guide](docs/SETUP.md) for
PostgreSQL prerequisites. For a fresh install, start Docker
with Compose for the default PostgreSQL backend or set `PGMODE=native` in the root
`.env` for native PostgreSQL. Unset a conflicting exported `PGMODE`. If you already
run PortOS, retain the backend holding your records.

```bash
git clone --recurse-submodules https://github.com/atomantic/PortOS.git
cd PortOS
npm run install:all
npm run dev
```

Vite serves the development UI on port 5554. PM2 runs the local API and workers.
`npm run dev` preserves an active CoS worker and its agent sessions. To
intentionally restart the worker, use `npm run dev -- --restart-cos`.
For an existing clone with missing submodules, run
`git submodule update --init --recursive`. See [Troubleshooting](docs/TROUBLESHOOTING.md)
if setup fails.

## Testing

Run the checks from the repository root.

```bash
npm test # Server, then client
npm test --prefix server -- services/creativeDirector/videoAssembly.test.js
```

Report focused runs as coverage of the selected tests. See [Pregate](docs/PREGATE.md)
for the focused plan, coverage limits, and full CI plan.

For DB-backed checks, provision the isolated test database and run the DB suite
after the server and client suites finish.

```bash
npm run setup:db:test
npm run test:db
```

Only run DB-backed tests against `portos_test`. The runner serializes DB suites
across worktrees and requires at least 2 GiB free on each observable PostgreSQL
data and write-ahead log volume.

### Repairing a test database whose extensions were dropped

If a legacy test run removed `vector` or `pgcrypto`, connect to `portos_test` on
the configured test cluster as a database administrator, then run
`CREATE EXTENSION IF NOT EXISTS vector;` and
`CREATE EXTENSION IF NOT EXISTS pgcrypto;`. Re-run `npm run setup:db:test` as the
ordinary application role. Keep that role's existing privileges.

### Test Strategy: Value Over Assertion Count

- Test changed behavior at the highest practical public boundary. Cover success
  and materially different failure or compatibility cases.
- Use focused unit tests for contracts a higher-level test would cover poorly,
  such as parsers, security and data-isolation guards, migrations, and timing.
- Test what a boundary owns. For a route, assert validation, defaults, response
  shaping, or emitted events as applicable. Keep the underlying behavior in
  service tests. Prefer a real service when it is cheap and isolated.
- Name the regression a test catches. Keep repository-wide scans in the
  [structural guard runners](docs/GITHUB_ACTIONS.md#guard-selection-and-registration).

## Submit a pull request

- Work in a feature branch in your fork and target `main`.
- Link the issue, explain the change and how you verified it, and include
  screenshots when they help review a visible change. Use descriptive
  conventional commits. Release notes are generated from commits.
- Run `npm run pregate` before pushing and again after rebasing. On Windows,
  use `node scripts/pregate.js`. Report testing limits and address review
  feedback. Required hosted CI checks must pass before merge.

The maintainer assesses contributions for project fit, correctness, scope, and
validation. Claiming an issue or passing CI does not guarantee acceptance.
