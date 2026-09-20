# AGENTS.md

Guidance for every AI coding agent working in this repository — Claude Code, Codex, Antigravity (`agy`), grok, cursor-agent, OpenCode, and the local-model providers that front them.

`AGENTS.md` is the canonical file. The `CLAUDE.md` beside it is a one-line `@AGENTS.md` import (Claude Code hardcodes that filename) — an import rather than a symlink so it survives a Windows checkout and a CLI that reads both names doesn't ingest the body twice. Both files exist at the root and at each nested location below. **Edit `AGENTS.md`; never put content in a `CLAUDE.md`.**

## Commands

Non-obvious invocations only — everything else is in `package.json` scripts.

```bash
npm run install:all   # includes git submodule update --init --recursive

# Root `npm test` runs both workspaces in sequence (server, then client). Run them
# per workspace to scope to one — both are Vitest, with different environments:
cd server && npm test            # Vitest (node) — ALSO globs ../scripts, ../lib, ../autofixer
cd client && npm test            # Vitest (happy-dom) — component/unit tests
# No NODE_ENV prefix needed: server/vitest.config.js FORCES NODE_ENV=test (#4554),
# because PortOS runs under PM2 with NODE_ENV=development and a suite that
# inherits it aims at the real Postgres.
npm run test:db                  # DB-backed suites → portos_test ONLY (see Security Model)

npm run pregate                  # BEFORE EVERY PUSH — runs what CI will run on this branch
```

**`npm run pregate` is the pre-push gate.** It asks CI's own planner (`scripts/ci-test-plan.js`) what this branch's diff selects, then runs that plan through CI's own runners — so a green pregate means the Linux lint and test jobs are green for the same reasons, not a second opinion that can drift. It takes seconds on a scoped diff, and it is the only local command that reaches the tree-wide guards nothing imports: the import budget (`server/lib/importScoping.test.js`), server→client import purity, union-merged catalog rows, generated-manifest drift. Those are the failures that otherwise cost a push and a CI round to discover — and the ones that reproduce only *after* a rebase, so **run it again after every rebase onto a moved `main`**, not just once before the first push.

It plans from **committed** work only and says so when the tree is dirty; commit, then re-run. A diff big enough to force CI's full suite runs the always-run guards here instead (`--full` opts into everything). It never runs the DB suites, the Windows job, the client build, or the boot smoke — it names the ones your diff implicated and leaves them to CI, which is the only honest answer for a check this machine cannot perform.

## Test Strategy: Value Over Assertion Count

- **Default to the highest practical public boundary** — an Express route, service workflow, persisted-store adapter, socket exchange, or rendered user interaction. Cover the success path plus the materially different failure/compatibility paths; do not enumerate every internal branch because it exists.
- **Don't unit-test a helper a stable caller already exercises.** No test that only raises coverage for a deterministic helper. When a helper's signature and every caller would change together, prefer the caller's integration contract and delete redundant helper-level examples. Table-driven permutations that all prove the same product outcome are duplication.
- **Focused unit tests stay valuable where a higher-level test cannot pin behavior precisely or cheaply:** parsers and algorithms with a real input matrix; security, privacy, data-isolation, and destructive-action guards; migrations and cross-version compatibility; serialization/schema boundaries; retry, timeout, and process-lifecycle state machines; pure edge cases whose failure would be ambiguous through an integration test. Real timeout behavior gets one contract test with injected/fake time — never repeated production sleeps.
- **Name the regression a new test uniquely catches** before adding it. In review, remove tests that duplicate a stronger boundary assertion, mirror implementation details, only verify mocks called other mocks, or cover impossible states.
- Test count and line coverage are diagnostics; CI time, determinism, and regression-detection value are the goals.

## Security Model

**Trust model (within one install).** Each install serves exactly one human, on a private network behind Tailscale VPN, never exposed to the public internet — one server process, one user. Concurrent *request* races, mutex locking on file I/O, and atomic-write patterns as defenses against competing actors are unnecessary; do not add or flag them. Simple re-entrancy guards (per-account sync locks against duplicate in-flight operations; serializing two write paths that mutate the same record) are fine and expected. PortOS intentionally omits CORS restrictions, rate limiting, and full concurrency controls — non-issues here. **"Single-user" means: do not defend against multiple competing humans inside one install. It does NOT mean "assume only one install exists."**

**Authentication and HTTPS exist, but are OPT-IN and OFF by default.** Do not assume they are absent:

- **Auth** — an optional instance password (`server/services/auth.js`, enforced by `server/services/authGate.js`) gates all of `/api/*` and `/data/*` when set, with a small always-public set (`/api/auth/status`, `/api/system/health`). Peers reach a password-gated instance via a per-peer Basic credential on the peer record, attached to every outbound hop by `peerFetch` (`server/lib/peerHttpClient.js`). **A PortOS-spawned agent authenticates with `PORTOS_API_TOKEN`** — a loopback session token the server mints and injects into the agent's environment (`server/services/agentApiAuth.js`). Any `curl` you write against this install's own API carries `-H "Authorization: Bearer ${PORTOS_API_TOKEN:-}"`; a bare `401 AUTH_REQUIRED` means the header was dropped, not that the endpoint is down. The variable is empty when no password is set (the gate ignores it) and is never given to a public-content review stage.
- **HTTPS** — provisioned by `npm run setup:cert`; `:5555` flips to TLS with a loopback-only HTTP mirror on `:5553`. Peer hops set `rejectUnauthorized: false` ("Tailnet is the trust boundary"): between two tailnet nodes WireGuard supplies mutual auth, but a non-tailnet peer (plain LAN IP / non-`.ts.net` host, see `peerRequiresTailscale()`) gets no server authentication.

Because both are off by default, **never treat "the password is set" as an available guarantee** — gate on it explicitly, or design for the default posture.

**Federation trust boundary.** PortOS supports the user sharing their own data across machines they own/control on their private network. **Personal or private record content is not, by itself, a reason to prohibit that sync.** Brain records, including tracked-topic threads derived from assigned issues or tickets, may travel through the established Brain sync channel between those machines. Preserve the configured peer/category controls and each domain's wire contract; network reachability or an inbound peer announcement alone is not permission to publish data to other people. See ADR [federation between user-controlled machines](docs/decisions/2026-09-19-user-controlled-federation.md).

**Keep record sync, configuration, and other audiences distinct.** Credentials, tokens, encryption keys, and machine-local execution/sync settings stay in their existing local stores. A documentation clarification does not add sync support to a currently local-only store: Privacy Center, message mirrors, provider configuration, and other guarded stores retain their current implementation until a scoped change supplies their sync semantics. The [Privacy Center ADR](docs/decisions/2026-08-08-privacy-records-machine-local.md) describes those implementation boundaries; it is not a blanket ban on personal records crossing to the user's own machines. Status/capability endpoints retain their bounded projections rather than becoming an alternate record-export path. Sharing with a non-self peer, guest, public world, or external service follows that surface's explicit audience and admission controls: [visual prompts](docs/decisions/2026-08-20-federated-visual-prompts.md), [media conditioning](docs/decisions/2026-08-22-federated-media-input-assets.md), [Eidoverse guest chat](docs/decisions/2026-09-05-eidoverse-guest-chat.md), and [promoted foundations](docs/decisions/2026-09-18-federated-eidoverse-foundations.md). The Sensitive Data & Privacy rules below still prohibit publishing live instance data in code, logs, issues, or PRs.

**Distribution model (across installs).** PortOS is distributed software: many independent people each run their own install, upgrading on their own schedule, and a single user commonly runs **several machines federated as sync peers**. Backward/forward compatibility across installs and versions is first-class:

- **Never delete or skip migration / compatibility code on the grounds that "there's only one install."** Other people and other machines run this code and update it independently.
- On-disk format changes need a migration in `scripts/migrations/` (applied-list tracked per install in `data/migrations.applied.json`). Seed files ship in `data.reference/`.
- **A migration that DERIVES `data/<x>` from an install's existing records ships NO `data.reference/<x>` seed, and gates on the presence of its INPUT — never the absence of its output.** `setup-data.js` runs before `run-migrations.js` and copies every `data.reference/` file the install lacks, so a seed lands first; a migration that skips because its output already exists then leaves shipped defaults where the user's data was, and the next write destroys the original. Declare such a path in `scripts/lib/migrationOwnedPaths.js` (its test fails if a seed reappears). The applied-list already provides re-run safety. This replaced CoS settings with shipped defaults on installs crossing #6182 — see `scripts/migrations/340-cos-config-seed-repair.js`.
- Prompt-default changes are two steps: bump the prompt's `PROMPT_VERSIONS` entry, then run `node scripts/regen-prompt-integrity-snapshot.js`. The tool retires the outgoing default's hash into `server/services/taskPromptDefaults/integrity.snapshot.json` — how other installs recognize a stored prompt as a shipped default and auto-upgrade it (`promptMatchesShippedDefault`) — and refuses a body change with no bump. Retired bodies live only in git history; never paste one back as recognition data (the one literal in `taskPromptDefaults/retiredPromptFixtures.js` is a test fixture).
- Cross-machine sync payloads stay version-gated (`server/lib/schemaVersions.js`) so a newer peer can't corrupt an older one.
- The self-update path stays fork-aware — other users run forks. **Never add `--force` to the server-side `gh repo sync`** (it would discard a user's fork commits; the 409 `FORK_DIVERGED` message points them at running it themselves). Don't re-hardcode the upstream slug outside `server/lib/gitRemote.js`, and new UI claiming "you are running PortOS" must read `remoteInfo.isUpstream`, not just `currentVersion`. Mechanism: [docs/SELF_UPDATE.md](docs/SELF_UPDATE.md).

**The default database password `portos`** (in `ecosystem.config.cjs`, `docker-compose.yml`, `.env.example`) is an intentional backward-compatible fallback for local development. Do not remove it or flag it. Production overrides it via `PGPASSWORD`.

**Storage backend policy.** PostgreSQL (system `:5432` or Docker `:5561`) is a **mandatory** dependency for every install and every federated peer, provisioned by `npm run setup:db` (ADR `docs/decisions/2026-06-07-postgres-as-primary-datastore.md`, `docs/STORAGE.md`). **`MEMORY_BACKEND=file` is a development/test-only escape hatch, NOT a supported deployment mode** — the creative catalog/pgvector, federation, and backup all assume Postgres. When `MEMORY_BACKEND` is unset, `server/services/memoryBackend.js` requires a healthy DB and fails fast with no silent fallback. That is **intentional**: do not "fix" it, re-add a file choice to `scripts/setup-db.js`, or treat the file backend as a fallback. The file path stays runnable only because `NODE_ENV=test` selects it.

**Third-party API keys for free, non-monetary services are not security findings.** PortOS calls a few free external APIs (e.g. CivitAI model downloads) with an API key in a query parameter or header. Host-allowlisting the URL before attaching the key, stripping it across redirects, and similar are won't-fix: leaking that key to an unintended host costs nothing beyond quota abuse against a free service. (The key is still a secret under Sensitive Data & Privacy — never commit or log it.) This does NOT extend to paid/quota-billed providers or keys gating money-bearing or destructive actions. Precedent: issue #2200 (`applyDownloadToken` in `server/services/loras.js#installFromCivitai`).

**Never run DB-backed tests against the real `portos` database.** There is ONE Postgres per install, shared by every git worktree (including CoS-agent worktrees). The `*.db.test.js` suites `DELETE FROM`/`INSERT` whole tables, so running them against `portos` corrupts the user's real data. They are gated to skip on a non-test DB and run only via `npm run test:db` (→ `portos_test`, provisioned by `npm run setup:db:test`). The gate in `server/lib/db.js` keys on `isTestRunner()` (`NODE_ENV==='test'` **OR** `process.env.VITEST`, so a wrapper that drops `NODE_ENV` can't disarm it), and the `query()` backstop refuses ALL row writes (`INSERT`/`UPDATE`/`DELETE`/`TRUNCATE`) to a non-test DB under the runner. Do not weaken either to "just `NODE_ENV`" or "DELETE-only" — that hole wiped real data on 2026-06-13/14. See `server/lib/db.guards.test.js`.

## AI Provider Usage Policy

**No cold-bootstrap LLM calls.** PortOS must never queue AI provider calls a user hasn't knowingly triggered. A new install (or freshly merged feature) coming online stays silent on the LLM front until the user asks for AI-backed work. This rules out LLM calls from server boot / `server/index.js` init (cache warm-ups, pre-generation, startup backfills), and any background job that silently expands from "generate the one thing the user asked for" into "generate a whole batch for later."

**Scheduled automations are the one sanctioned exception** — a cron-style task, autopilot, or CoS agent the user explicitly configured (`taskSchedule.js`, `backupScheduler.js`, autopilot gates) may call providers on its own schedule. Anything else needs a direct user action in the same request, or an explicit consent/config step first.

**Pattern for background pre-generation (e.g. caches):** boot-time init loads only what's on disk (zero LLM calls); the bulk/cold fill runs only from an explicit user-triggered endpoint behind a UI prompt that names the provider/model and lets the user change it or decline; incremental top-ups after the user has engaged (replenishing one item they consumed) may run silently. Reference: `server/services/meatspacePostDrillCache.js` (`initDrillCache` / `requestCacheFill`) and `client/src/components/meatspace/post/WordplayTrainer.jsx` (`CacheFillConsentModal`).

## Architecture

The server is always user-facing on `:5555` (HTTP or HTTPS). The client runs on the Vite dev server at `:5554` under `npm run dev`; under `npm start` the built client is served from `:5555`. PM2 manages app lifecycles. Where a record persists (Postgres vs a `data/` file) is decided by `docs/STORAGE.md`.

**Ports.** PortOS uses 5553–5561 (system PostgreSQL on 5432, Docker PostgreSQL on 5561). When HTTPS is on, local curl/scripts hit the loopback-only HTTP mirror on `:5553` to skip the cert warning. Define ports in the top-level `PORTS` object in `ecosystem.config.cjs` (re-exported at `server/lib/ports.js`). Guide and diagram: `docs/PORTS.md`.

**Never run `npm ci` or `npm install` from inside a CoS worktree (`data/cos/worktrees/*`).** Worktrees get the primary checkout's `node_modules` (root, `client/`, `server/`) by symlink; npm follows the symlink and empties the PRIMARY checkout's real `node_modules`, which takes every agent spawn down with `posix_spawn failed: No such file or directory` until someone reinstalls. If a worktree is missing dependencies, symlink them from the primary checkout and call the workspace binaries directly (`server/node_modules/.bin/vitest run <files>`) — never install. Recovery and mechanism: `docs/TROUBLESHOOTING.md` ("Every Agent Spawn Fails…"); the runner names the fault in `server/lib/ptySpawnDiagnostics.js`.

**Backup excludes.** `DEFAULT_EXCLUDES` in `server/services/backup.js` is **rsync filter syntax — every path must be anchored with a leading `/`.** An unanchored pattern matches at any depth and silently drops unrelated user data; that is a data-loss bug. See `docs/BACKUP.md` for the `overridable` tiers and `computeEffectiveExcludes()`.

### Per-directory conventions

Client- and server-specific conventions live in nested memory files that load when you work in those trees (each an `AGENTS.md` with a bridge `CLAUDE.md`):

- `client/src/AGENTS.md` — UI conventions, routing/deep-linking, API error/save gating, the shared `Drawer` convention
- `client/src/components/dashboard/AGENTS.md` — widget registration, grid/arrange mechanics, ⌘K layout wiring
- `server/AGENTS.md` — schema parity, write serialization, peer fan-out in tests, generated manifests, prompt-template migrations
- `server/lib/aiToolkit/AGENTS.md` — the override-consistency contract for the vendored provider/runner/prompt toolkit (self-contained: no imports out to other PortOS modules). Read it before editing the runner or provider config.

**Nested files reach API-provider agents too — but the walk is bounded.** `getAgentInstructionsContext()` in `server/services/agentPromptBuilder.js` splices `~/.claude/CLAUDE.md`, the workspace-root file, then every nested one (`AGENTS.md` preferred, one entry per directory, bridge `CLAUDE.md`s skipped) into the prompts PortOS builds for its API-provider agents. The walk is capped at depth 5 / 10 files and skips dot-dirs, `node_modules/`, `data/`, build output, and any subdirectory with its own `.git`. Consequences: **a rule that must reach every agent has to sit inside that budget** (raise the cap in the same change if the repo exceeds 10 nested files), and **the root file is the only guaranteed-first slot** — a rule guarding data loss, a destructive action, privacy, or spend belongs here when it must outrank a subtree convention.

### Command Palette & Voice Nav — shared backbone

`server/lib/navManifest.js` is the single source of truth for navigation: `NAV_COMMANDS` + `resolveNavCommand()`, consumed by both the `⌘K` palette and the voice agent's `ui_navigate` tool. **Adding a `<Route>` without a `NAV_COMMANDS` entry leaves the page unreachable from `⌘K` and un-navigable by voice.** Invoke the `portos-add-page` skill for the entry shape, palette-action wiring, and the fail-fast guards.

**Optional features gate navigation, not routes.** `server/lib/instanceFeatureRegistry.js` declares the optional per-install features (**Settings > Features**); a nav entry tagged `feature: '<id>'` (or in a `SECTION_FEATURE` section) drops out of `⌘K` and the sidebar while the feature is off, but its `<Route>` keeps working. The gate is applied CLIENT-side (`useInstanceFeatures` + `client/src/lib/navFeatures.js`), never by filtering the HTTP-cached manifest response, and a sidebar row still needs its own `NAV_PRESENTATION` entry in `client/src/lib/navPresentation.js`. **A feature toggle that arms background work must reconcile that work at toggle time, not only at boot** — one idempotent `reconcile…()` called from every path that moves the gate (`server/services/beeperArming.js` is the worked example). Feature groups, the resolution order, and the full contract: `docs/INSTANCE_FEATURES.md`.

### Slashdo Commands (`lib/slashdo`)

PortOS bundles [slashdo](https://github.com/atomantic/slashdo) as a git submodule at `lib/slashdo`, providing `/do:next`, `/do:review`, `/do:pr`, `/do:push`, `/do:release`, … without a global install; `.claude/commands/do/` symlinks expose them as project-level slash commands. `/do:next` claims the next PLAN.md item (or GitHub issue with `--issues`) in an isolated worktree and ships a PR. CoS agents use the shared slashdo renderer: file-tool hosts receive a short entrypoint with supporting files read by phase; `loadSlashdoCommand(name)` from `server/services/subAgentSpawner.js` is the eager, self-contained form.

In that source, `!read lib/<name>.md` means read `lib/slashdo/lib/<name>.md` when the named phase applies; resolve nested references (including `~/.claude/lib/<name>.md` tokens) against the same bundled package root. These are required reads, not shell commands. Do not preload every phase or depend on a global slashdo installation. Staged CoS bundles resolve each reference relative to the file containing it.

## Module Organization

PortOS is large enough that re-implementing a helper is cheaper to *start* than finding what exists. Every directory holding reusable code carries a catalog `README.md` and an enumerable `index.js` barrel. **Before writing a helper, grep the catalog.**

### Where new code lives

- **Pure / side-effect-free helpers** → `server/lib/` or `client/src/lib/`
- **React hooks (state + lifecycle)** → `client/src/hooks/`. Names start with `use`.
- **Formatting helpers (pure, no React)** → `client/src/utils/` (`formatters.js`, `cronHelpers.js`, …)
- **HTTP / Socket / browser clients** → `client/src/services/`. API wrappers start with `api*`.
- **Express handlers** → `server/routes/`. Use `validateRequest` + `lib/validation.js` schemas.
- **Domain orchestration (multi-step business logic over models + services)** → `server/services/`
- **Persisted data (PostgreSQL vs a `data/` file)** → decide via `docs/STORAGE.md` *before* defaulting to a new `data/*.json`. App-native relational records are `db-primary`; that doc's "Adding a new data store?" checklist is required in PR review.

One concern per file. Tests live next to their source as `<name>.test.js`. Naming is camelCase with a domain prefix (`brainValidation.js`, `creativeDirectorPrompts.js`).

### Discovery rule (BEFORE writing a helper)

```bash
grep -i "what you want to do" server/lib/README.md
grep -i "what you want to do" client/src/lib/README.md
grep -i "what you want to do" client/src/hooks/README.md
grep -i "what you want to do" client/src/services/README.md
```

If a close match exists, **extend it or use it**. Only add a new module when none fits. Easy-to-miss helpers:

- `tryReadFile` (`server/lib/fileUtils.js`) — collapses `readFile(path).catch(() => null)`.
- `atomicWrite` (`server/lib/fileUtils.js`) — `ensureDir + writeFile + JSON.stringify` in one call.
- `createCollectionStore` (`server/lib/collectionStore.js`) — when a service outgrows its single-JSON-file shape (large per-record payload, frequent mutations), use this instead of another `readJSONFile` + `atomicWrite` + `createFileWriteQueue`. Lays out `data/{type}/{id}/index.json` under a type-level index stamping the storage-layout `schemaVersion`, with a per-id write queue and a `verifySchemaVersion` hook for the boot-time verifier. Full API in `server/lib/README.md`; worked example `server/services/universeBuilder.js` (migration 034).
- `optionalBooleanMap(keys)` (`server/lib/validation.js`) — collapses `z.object(Object.fromEntries(KEYS.map(k => [k, z.boolean().optional()])))`.
- `flattenCanonDescriptorFragments` / `mapCanonDescriptorFragments` (`server/lib/canonPrompt.js`, mirrored to client) — render `[{ prefix?, value }]` fragments to a sentence or array.
- `copyToClipboard` / `writeClipboardSilently` / `readClipboard` (`client/src/lib/clipboard.js`) — safe on insecure-origin contexts. Never use `navigator.clipboard.writeText` inline.
- `useLockToggle` (`client/src/hooks/useLockToggle.js`) — optimistic-PATCH lock toggle for any new lock button.
- `useSseProgress` (`client/src/hooks/useSseProgress.js`) — generic JSON-frame EventSource subscriber; build new progress hooks on it.
- `formatBytes` / `formatTimecode` / `formatDateShort` / `formatDurationMs` / `timeAgo` (`client/src/utils/formatters.js`) — never re-define formatters inside components.
- `formatCount` / `formatUsd` (`client/src/utils/formatters.js`) — thousands-grouped, en-US-pinned (`2,762`, `$4,610.09`) for every user-facing count or amount. Never a raw integer or a bare `.toLocaleString()`; `client/src/numberFormattingConventions.test.js` fails CI on one. Full rule (including when to pass `{ fallback: '0' }`) in `client/src/AGENTS.md`.

### Maintenance rule (WHEN adding a public module)

Any new file in `server/lib/`, `client/src/lib/`, `client/src/hooks/`, `client/src/utils/`, or a new `apiX.js` in `client/src/services/` **MUST** (1) be re-exported from the same-directory `index.js` barrel (or, for `services/`, from `api.js`) and (2) get a one-line row in the same-directory `README.md`. Enforced: `server/lib/index.test.js` and its client counterparts fail when a non-test `.js` file is missing from either.

**Catalogs and barrels merge with git's `union` driver** (`.gitattributes`), because every branch inserts one sorted line and concurrent branches collide on the same hunk. Union keeps both sides — right for an insertion, wrong for an edit or deletion beside one — so after a rebase that touched a catalog, `scripts/catalog-merge-union.test.js` fails on a doubled or resurrected row; keep one and move on. Never give a file with real code paths the `union` attribute; the guard rejects a `.js` that is not a pure re-export barrel.

**Name collisions.** When two modules in one directory export the same identifier (e.g. `settingsUpdateInputSchema` in both `brainValidation.js` and `digitalTwinValidation.js`), the barrel uses `export * as <name>` namespace exports so callers reach for `brainValidation.settingsUpdateInputSchema` explicitly. Catch-all modules like `validation.js` stay flat. The collision-detector test fails if two flat-`export *` modules share an identifier.

Existing deep imports (`import { x } from '../lib/foo.js'`) keep working — the barrel exists for *discovery*. The worked example for "barrel + documented exports" is `server/lib/aiToolkit/index.js`.

### Generated manifests are addressed by content, never by position

First ask whether the manifest needs to exist: a derivation that is deterministic, cheap, and reads only inputs every install ships belongs **in memory, derived on first use and cached for the process** (`server/lib/apiRouteGraph.js`, `server/lib/socketEventInventory.js`). A checked-in `*.generated.json` must change when — and *only* when — the thing it describes changes, so key each record by the declaring file plus the semantic identity of what it declares (stage key plus file paths in `scripts/generate-prompt-stage-call-sites.js`), never by line/column: a `foo.js:412` record makes every unrelated edit above it churn the file and every rebase conflict on it.

**A new generator proves this with `shiftSourceText` (`scripts/lib/positionInvariance.js`)** — shift every line in its inputs, regenerate, assert byte-identical output. `server/lib/generatedManifests.test.js` is the tree-wide backstop and **fails when a `scripts/generate-*.js` has no sibling test importing `positionInvariance.js`**. This rule lives in root because the generators are in `scripts/`, which carries no nested file; the mechanism and the coverage-without-positions pattern are under "Generated manifests" in `server/AGENTS.md`.

## Scope Boundary

When CoS agents or AI tools work on managed apps outside PortOS, all research, plans, docs, and code for those apps go in the target app's own repository/directory — never here. PortOS stores only its own features, plans, and documentation.

## Sensitive Data & Privacy (developing on a live instance)

**This code is written and reviewed on a live install holding one real user's data.** Machine identity, network topology, personal records, and app-specific names read out of the running instance are private — they must never leak into anything committed, pushed, or published. Treat every artifact an agent produces (source, comments, test fixtures, docs, changelog, commit messages, PR titles/descriptions/review comments, issue text) as world-readable the moment it lands on a branch.

**Never commit, log to a shared file, or write into a PR/issue/commit any of:**

- **Machine identity** — hostnames, machine names, Tailscale node / MagicDNS names, device IDs, OS usernames, home-directory paths embedding a username (`/Users/<name>/…`, `/home/<name>/…`), user email addresses, account IDs, license keys, serial numbers.
- **Network info** — LAN/Tailscale/public IPs, MAC addresses, subnet layouts, port-forwarding maps, router/gateway addresses, VPN keys, `.env` secrets, DB passwords other than the documented `portos` dev fallback, API tokens, session cookies, auth headers.
- **PII** — real names, physical addresses, phone numbers, birthdays, government IDs, payment details, GPS coordinates, biometric data — the user's or anyone in their data.
- **Personal app data** — the actual contents of the running instance: real universe/series/writers-room/catalog records, brain/journal entries, MeatSpace/POST data, media project names, scheduled-task payloads, chat/voice transcripts, or any record pulled from `data/`, the live DB, or a running screen. Never paste a real record into a test fixture, a doc example, or a bug report.

**Rules for agents:**

- **Placeholders, not observations.** When an example value is needed, invent an obviously-fake one (`example.com`, `alice@example.com`, `192.0.2.10`, `Acme Corp`, `Example Universe`, `host-XXXX`). Never transcribe a value observed in the live instance or environment.
- **Reproduce with redaction.** When a repro, log excerpt, or stack trace needs real state, redact the sensitive fields (`<hostname>`, `<user-email>`, `<tailscale-ip>`, `<record-id>`) before it goes into a commit, PR, issue, or review comment.
- **No environment scraping into artifacts.** Do not run `hostname`, `whoami`, `ifconfig`/`ip addr`, `tailscale status`, `env`, `git config user.*` and paste the output into anything committed or published. Read them only for transient in-session logic.
- **Scrub before you ship.** Before `git add`/commit and before opening or commenting on a PR/issue, scan your own diff and prose for the categories above. If real data was already committed, amend/rewrite the branch before pushing rather than layering a "redaction" commit on top.
- **Absolute paths.** Prefer repo-relative paths in committed text; when an absolute path is unavoidable, strip the user segment (`~/…` or `<repo-root>/…`).

This complements the Security Model (the deployed product) — this section governs what agents may *write down* while working against real data.

## Code Conventions

- **No try/catch** — errors bubble to centralized middleware. **Exception:** PTY/child-process/`setTimeout`/`setInterval` callbacks and any code running *outside* the Express request lifecycle, where an uncaught throw crashes the Node process. At those boundaries, wrap hook invocation in try/catch and log via the emoji-prefixed `console.error` style. Async event handlers that mutate shared module-level state (e.g. the TUI spawner's `handleData`) must also be serialized — chain them onto a per-session/per-actor `Promise.resolve()` queue rather than firing concurrently.
- **Functional programming** — no classes; use hooks in React.
- **Zod validation** — all route inputs validated via `lib/validation.js`.
- **Command allowlist** — shell execution restricted to approved commands only.
- **Every new page registers in the nav manifest** — a `<Route>` + sidebar link also means a `NAV_COMMANDS` entry in `server/lib/navManifest.js`. Invoke the `portos-add-page` skill.
- **Selection lives in the URL, never in local state** — any view that opens/selects a specific record encodes it as a route param, so it's shareable, bookmarkable, and reachable from ⌘K and voice. Full contract in `client/src/AGENTS.md`.
- **Client UI conventions** (`client/src/AGENTS.md`) — no `alert`/`confirm`, `htmlFor`/`id` label pairing, mobile responsive, above the fold, no hardcoded localhost, alphabetical nav, user-facing number formatting, reactive local-state updates after mutations, silent-vs-toasting API errors, save gating for "Run Now" actions, and the shared tabbed `Drawer` convention.
- **Server conventions** (`server/AGENTS.md`) — schema parity when adding fields, serializing async PATCH races on shared records, batching high-frequency state writes, peer fan-out in record-creating tests, backup exclude anchoring, and stage-prompt template migrations.
- **Socket-driven UI** — invoke the `portos-socket-ui` skill before wiring or debugging a socket-driven view.
- **Single-line logging** — emoji prefixes and string interpolation; never log full JSON blobs or arrays.
  ```js
  console.log(`🚀 Server started on port ${PORT}`);
  console.error(`❌ Failed to connect: ${err.message}`);
  ```
- **LLM response merging — distinguish absent vs intentionally empty.** "Key absent" preserves the original; "key present with empty value" applies the clear. Don't use `.length` truthiness as the signal. Strings: `null`/`undefined` = absent, `""` = a clear (server helpers like `universeBuilderExpand.trimField` return `null` for non-strings). Arrays/objects: gate on `Array.isArray(parsed?.field)` / `typeof parsed?.field === 'object'` before falling back. Keep server-side merges and the client's `pick` helpers mirrored.
- **Sentinel + validate to distinguish "not set / failed" from "present-but-empty / valid".** Never let *absent*, *failed-to-fetch*, or *invalid* collapse into the same value as *fetched-and-legitimately-empty* or *valid*; use an explicit sentinel and validate before falling through, not `x.length` or `x || fallback`. Canonical examples in the local-LLM backends: model-list caches use `null = not fetched` vs `[] = cached-empty` (`ollamaManager.js` `installedModels`, `lmStudioManager.js` `availableModels`); `getBackend()` validates the `.env` marker before falling back to `process.env` (`server/services/localLlm.js`); a reachable-but-list-failed backend surfaces an explicit `modelsError` rather than `0 models` (`lmStudioManager.js` `getLastListError`).

## Git Workflow

- **main**: active development. **release**: push `main` to `release` to trigger the GitHub Release workflow.
- **Push pattern**: `npm run pregate && git pull --rebase --autostash && npm run pregate && git push` — the gate runs CI's own plan locally (see Commands). Run it **again after the rebase**: the import budget and the tree-wide guards are properties of your branch *merged with* the new `main`, so a rebase is exactly when a clean branch starts failing, and the first run cannot have seen it.
- **No per-branch changelog entries.** PRs do not write a changelog file or fragment — commit messages are the record, and `/do:release` synthesizes the release notes from the commit log since the last tag into `.changelog/v{version}.md`. **Write commit subjects/bodies for a human release-note reader** (see "Git commits and PRs" in the global instructions). Rationale: `.changelog/README.md`.
- **Release quality snapshot**: before a release, run `npm run quality:snapshot` on the install holding PortOS audit evidence. It publishes numeric local assessments only (no provider calls, no private run prose) into the repo-root `.quality.json`; with no local evidence it commits nothing and says so.
- **Versioning**: `package.json` reflects the last release. Do not bump during development — `/do:release` handles it.
- After each feature or bug fix, run `/simplify`, then commit and push.
- **Capture deferred work, and decide rather than park it.** Deferred refactors/cleanups go into a filed GitHub issue labeled `plan`, specific enough to pick up cold — never left only in chat. When the sole obstacle is an undecided design choice, **make the call yourself** and file it ready-to-work; `future` / `needs-input` are last resorts. Invoke the `portos-file-issue` skill before filing. The label vocabulary (dispatch axes, contributor labels, `planner:<model>`, colors, read-back) has exactly one source of truth — `MANDATORY_DISPATCH_HINT_GUIDANCE` in `server/lib/dispatchLabels.js` — so take it from there and never restate it in a doc, skill, or prompt that can drift from it.
- **Never link to AI conversation sessions.** No `claude.ai`, `chatgpt.com`, or other AI chat/session share URL (or "view this conversation" link) in a PR description, commit message, issue, or review comment. Reference durable artifacts instead: issue/PR numbers, commit SHAs, file paths.
- If enough commits have accumulated to warrant a production release, pull the latest `main` and `release`, then run `/do:release` from `main`.
- **Archive approved design plans.** When a plan is approved out of plan mode, copy it from `~/.claude/plans/` to `./docs/plans/YYYY-MM-DD-<slug>.md` (date of approval) before implementing. See `docs/plans/README.md`.

## Documentation

[ETHOS.md](ETHOS.md) states the project's ethos — why unsupervised agent operation is the design target, what the structural guards protect, and the testable commitments a change must not break. Read it before proposing supervision gates, per-action confirmations, external edits to a mind's own memories, or new data that crosses the federation layer.

`docs/README.md` indexes everything under `docs/` — guides, feature deep dives, ADRs (`docs/decisions/`), and design records (`docs/plans/`). Most-referenced contracts: `docs/STORAGE.md` (where a record lives), `docs/PORTS.md`, `docs/BACKUP.md`, `docs/SELF_UPDATE.md`, `docs/ARCHITECTURE.md`, `docs/API.md`.
