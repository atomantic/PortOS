# Contributing to PortOS

PortOS is a highly opinionated, personal project — a single developer's "everything app," built and maintained for that developer's own machine and workflow. It's MIT-licensed and open to the public, but it is **not** built or governed as a general-purpose open source project: there's no roadmap vote, no maintainer team, and no commitment to stability for anyone else's deployment. Read this before opening a PR so expectations are clear going in.

## Before you open a PR

- **The project prioritizes the author's own needs first.** A PR that's a great idea in the abstract may still be declined or reworked if it doesn't fit how the author actually uses PortOS.
- **Breaking changes ship without warning.** There's no deprecation cycle for external consumers. If you're running a fork, expect to reconcile changes yourself on each pull.
- **Small, focused PRs are far more likely to land than large ones.** If you're proposing a new feature area rather than a fix, consider opening an issue first to check it's a direction the project wants, before investing significant time.
- **Bug fixes, docs corrections, and small quality-of-life improvements are the easiest path in.**

## Getting set up

```bash
npm run install:all   # installs both workspaces + git submodules
npm run setup:db      # provisions PostgreSQL (mandatory — see docs/STORAGE.md)
```

See the root [`CLAUDE.md`](./CLAUDE.md) for the full command reference, architecture notes, and the security/storage model this codebase assumes (private Tailscale network, single-user trust model — see [GOALS.md](./GOALS.md#non-goals) for what's deliberately out of scope). [`docs/README.md`](./docs/README.md) indexes the rest of the docs, including [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) and [`docs/API.md`](./docs/API.md).

Requires Node.js `>=22.12.0`.

## Code conventions

These are enforced by review, not just style preference — see `CLAUDE.md` for the full list. The load-bearing ones:

- **Functional programming, no classes.** React uses hooks; server code uses plain functions.
- **No try/catch**, except at boundaries outside the Express request lifecycle (PTY/child-process/timer callbacks) — everything else bubbles to centralized error middleware.
- **All route input is validated with Zod** via `server/lib/validation.js`.
- **Shell execution is allowlisted** (`server/lib/commandSecurity.js`) — no arbitrary command execution.
- **Single-line, emoji-prefixed server logs** with interpolated values, not full JSON blobs.
- **New pages/routes register in the nav manifest** (`server/lib/navManifest.js`) so they're reachable from ⌘K and voice — see the `portos-add-page` skill notes in `CLAUDE.md` if you're using Claude Code.
- **On-disk data-format changes need a migration** under `scripts/migrations/`, tracked in `data/migrations.applied.json` — PortOS is distributed software; other people's installs update independently and must not corrupt on upgrade.

## Tests

```bash
npm test                # both workspaces
cd server && npm test   # Vitest (node) — also globs ../scripts, ../lib, ../autofixer
cd client && npm test   # Vitest (jsdom)
npm run test:db         # DB-backed suites — ONLY ever run against portos_test, never your real data
```

All tests must pass before a PR is merged. Never run `npm run test:db` against your development database — the suites `DELETE FROM`/`INSERT` whole tables (see the Security Model section of `CLAUDE.md`).

## Commit and PR conventions

- Commit subjects/bodies are written for a human release-note reader — `/do:release` synthesizes release notes from commit messages, so a vague `fix stuff` commit becomes a vague release note.
- No per-branch changelog files — the commit log is the record.
- No AI-attribution lines (`Generated with`, `Co-Authored-By`, links to AI chat sessions) in commits, PR descriptions, or issue text.
- Never commit real personal data, machine identity (hostnames, Tailscale names, IPs), or credentials — see the Sensitive Data & Privacy section of `CLAUDE.md` if you're working against a live instance.

## Reporting bugs / proposing features

Open a GitHub issue. There's no formal triage SLA — this is a side project run by one person — but clear repro steps or a concrete, scoped proposal are much more likely to get picked up than a vague one.

## License

MIT — see [`LICENSE`](./LICENSE).
