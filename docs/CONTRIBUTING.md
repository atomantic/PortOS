# Contributing Guide

## Development Setup

```bash
# Clone and install
git clone https://github.com/atomantic/PortOS.git
cd PortOS
npm run install:all

# Start development
npm run dev

# Or with PM2
pm2 start ecosystem.config.cjs
```

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

> **Note:** Some older code or automation notes may still reference a `dev` branch workflow. The `main`→`release` workflow described here is the current source of truth.

### Commit Messages

Use conventional commit format:

```
feat: add new feature
fix: resolve bug
build: version/CI changes
docs: documentation updates
refactor: code restructuring
```

## Project Structure

```
PortOS/
├── client/           # React + Vite frontend (port 5554)
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

# Watch mode
cd server && npm run test:watch
```

## API Documentation

See [API.md](./API.md) for the complete REST API and WebSocket event reference.
