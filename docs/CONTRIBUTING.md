# Contributing Guide

PortOS is a highly opinionated, personal project — a single developer's "everything app," built and maintained for that developer's own machine and workflow. It's MIT-licensed and open to the public, but it is **not** built or governed as a general-purpose open source project: there's no roadmap vote, no maintainer team, and no commitment to stability for anyone else's deployment. Read this before opening a PR so expectations are clear going in.

## Before You Open a PR

- **The project prioritizes the author's own needs first.** A PR that's a great idea in the abstract may still be declined or reworked if it doesn't fit how the author actually uses PortOS.
- **Breaking changes ship without warning.** There's no deprecation cycle for external consumers. If you're running a fork, expect to reconcile changes yourself on each pull.
- **Small, focused PRs are far more likely to land than large ones.** If you're proposing a new feature area rather than a fix, consider opening an issue first to check it's a direction the project wants, before investing significant time.
- **Bug fixes, docs corrections, and small quality-of-life improvements are the easiest path in.**

## Development Setup

```bash
# Clone and install
git clone https://github.com/atomantic/PortOS.git
cd PortOS
npm run install:all

# Start development
npm run dev

# Or with PM2 directly
pm2 start ecosystem.config.cjs
```

`npm run dev` executes `scripts/dev-start.js` to initialize PostgreSQL, stop any existing PM2 processes, and start the complete PM2 process ecosystem defined in `ecosystem.config.cjs` (`portos-server`, `portos-cos`, `portos-ui`, `portos-autofixer`, `portos-autofixer-ui`, `portos-browser`) while tailing logs.

**PostgreSQL is a mandatory dependency** — the server fails fast at boot without a healthy database. `npm run install:all` runs `npm run setup:db`, which provisions either the system PostgreSQL (`:5432`) or a Docker container (`:5561`, via `docker-compose.yml`). See [STORAGE.md](./STORAGE.md) and the [Postgres ADR](./decisions/2026-06-07-postgres-as-primary-datastore.md).

For DB-backed tests, provision the separate test database first (`npm run setup:db:test`) and run them via `npm run test:db` — never against the real `portos` database.

## Code Guidelines

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
3. Push `main` to `release` branch to trigger GitHub Release workflow
4. Push pattern: `git pull --rebase --autostash && git push`

### Changelog

Nothing to write here — there is no per-branch changelog file or fragment.
`/do:release` synthesizes the release notes from the commit log when it runs,
so write commit subjects/bodies for a human release-note reader (see Commit
Messages below). See [`.changelog/README.md`](../.changelog/README.md) for
details.

> **Note:** Some older code or automation notes may still reference a `dev` branch workflow. The `main`→`release` workflow described here is the current source of truth.

### Line Endings on Windows

`.gitattributes` pins `eol=lf` for text files across all platforms. If you have an existing repository clone on Windows from before this setting landed, run:

```bash
git rm --cached -r .
git reset --hard
```

to re-index files with LF line endings.

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

```bash
# Run server tests
cd server && npm test

# Run client tests
cd client && npm test

# Provision and run the isolated DB-backed suites
npm run setup:db:test
npm run test:db

# Watch mode
cd server && npm run test:watch
```

Pull requests run the tests for affected feature directories, with conservative
fallbacks to Vitest related-test mode or the complete suite. Pushes to `main`,
nightly CI, manual CI runs, and releases always run the complete server, client,
DB, lint, build, and smoke checks. Release publication is blocked until that
full CI gate succeeds.

## API Documentation

See [API.md](./API.md) for the complete REST API and WebSocket event reference.

## Reporting Bugs / Proposing Features

Open a GitHub issue. There's no formal triage SLA — this is a side project run by one person — but clear repro steps or a concrete, scoped proposal are much more likely to get picked up than a vague one.

## License

MIT — see [LICENSE](../LICENSE).
