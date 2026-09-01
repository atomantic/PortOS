# AGENTS.md

This file provides guidance to every AI coding agent working in this repository — Claude Code, Codex, Antigravity (`agy`), grok, cursor-agent, OpenCode, and the local-model providers that front them.

`AGENTS.md` is the canonical file. The `CLAUDE.md` beside it is a one-line `@AGENTS.md` import, because Claude Code's memory discovery hardcodes `CLAUDE.md` and has no configurable filename — an import rather than a symlink so it survives a Windows checkout without symlink support, and so a CLI that reads both names doesn't ingest the body twice. Both files exist at the root and at each nested location below. **Edit `AGENTS.md`; never put content in a `CLAUDE.md`.**

## Commands

Non-obvious invocations only — everything else is in `package.json` scripts.

```bash
npm run install:all   # includes git submodule update --init --recursive

# Root `npm test` runs both workspaces in sequence (server, then client). Run them
# per workspace to scope to one — both are Vitest, with different environments:
cd server && npm test            # Vitest (node) — ALSO globs ../scripts, ../lib, ../autofixer
cd client && npm test            # Vitest (jsdom) — component/unit tests
# No NODE_ENV prefix needed: server/vitest.config.js FORCES NODE_ENV=test (#4554).
# Vitest only defaults it when unset, and PortOS runs under PM2 with
# NODE_ENV=development — a suite run that inherits that aims at the real Postgres.
npm run test:db                  # DB-backed suites → portos_test ONLY (see Security Model)
```

## Test Strategy: Value Over Assertion Count

PortOS tests move **up the stack as behavior stabilizes**. The default new test
is the highest practical public boundary: an Express route, service workflow,
persisted-store adapter, socket exchange, or rendered user interaction. A
boundary test should cover the success path plus the materially different
failure/compatibility paths; it should not enumerate every internal branch just
because the branch exists.

Do not add or retain a unit test merely to raise coverage for a deterministic
helper whose behavior is already exercised through a stable caller. When a
helper's signature and every caller would have to change together, prefer the
caller's integration contract and delete redundant helper-level examples.
Table-driven permutations are still duplication when they all prove the same
product outcome.

Focused unit tests remain valuable for behavior that a higher-level test cannot
pin precisely or cheaply: parsers and algorithms with a real input matrix;
security, privacy, data-isolation, and destructive-action guards; migrations and
cross-version compatibility; serialization/schema boundaries; retry, timeout,
and process-lifecycle state machines; and pure edge cases whose failure would be
ambiguous through an integration test. Real timeout behavior gets one focused
contract test with injected/fake time — never repeated production sleeps.

Before adding a test, name the regression it uniquely catches. During review,
remove tests that duplicate a stronger boundary assertion, mirror implementation
details, only verify mocks called other mocks, or cover impossible states. Test
count and line coverage are diagnostics, not goals; CI time, determinism, and
regression-detection value are the goals.

## Security Model

**Trust model (within one install).** Each PortOS install serves exactly one human user, on a private network behind Tailscale VPN, never exposed to the public internet. Within an install there is one server process and one user — so concurrent *request* races, mutex locking on file I/O, and atomic write patterns are unnecessary as defenses against competing actors and should not be added or flagged as concerns. Simple re-entrancy guards (per-account sync locks preventing duplicate in-flight operations; serializing two write paths that mutate the same record) are fine and expected. PortOS intentionally omits CORS restrictions, rate limiting, and full concurrency controls by default — non-issues for a single-user private-network deployment. Do not add them or flag their absence. **"Single-user" means: do not defend against multiple competing humans inside one install. It does NOT mean "assume only one install exists."**

**Authentication and HTTPS exist, but are OPT-IN and OFF by default.** Do not assume they are absent:

- **Auth** — an optional instance password (`server/services/auth.js`, enforced by `server/services/authGate.js`) gates all of `/api/*` and `/data/*` when set, with a small always-public set (`/api/auth/status`, `/api/system/health`). Peers reach a password-gated instance via a per-peer Basic credential on the peer record, attached to every outbound hop by `peerFetch` (`server/lib/peerHttpClient.js`).
- **HTTPS** — provisioned by `npm run setup:cert`; `:5555` flips to TLS with a loopback-only HTTP mirror on `:5553`. Peer hops set `rejectUnauthorized: false` ("Tailnet is the trust boundary") — between two tailnet nodes WireGuard already supplies mutual auth, but a non-tailnet peer (plain LAN IP / non-`.ts.net` host, see `peerRequiresTailscale()`) gets no server authentication.

Because both are off by default, **never treat "the password is set" as an available guarantee** when designing a feature — gate on it explicitly, or design for the default posture. **PII must not ride the federation layer at all** — see ADR [privacy records machine-local](docs/decisions/2026-08-08-privacy-records-machine-local.md). That rule governs *records* and *status/capability payloads*; its one scoped carve-out is a submitted job body carrying the conditioning an allowlisted peer is being asked to render — the prompt (ADR [federated visual prompts](docs/decisions/2026-08-20-federated-visual-prompts.md)), and, under the same gate, lyrics and conditioning images (ADR [conditioning crosses to an allowlisted peer](docs/decisions/2026-08-22-federated-media-input-assets.md), which also records what stays refused: model weights and multi-step chain state).

**Distribution model (across installs).** PortOS is distributed software: many independent people each run their own install, on their own machine(s), each upgrading on their own schedule — and a single user commonly runs **several machines federated as sync peers**. Backward/forward compatibility across installs and versions is first-class, NOT optional:

- **Never delete or skip migration / compatibility code on the grounds that "there's only one install."** There isn't — other people and other machines run this code and update it independently.
- On-disk format changes need a migration in `scripts/migrations/` (applied-list tracked per install in `data/migrations.applied.json`). Seed files must ship in `data.reference/`.
- Prompt-default changes need a `PROMPT_VERSIONS` bump AND the prior default preserved in `PREVIOUS_DEFAULT_PROMPTS`, so other installs recognize their stored prompt and auto-upgrade it (`server/services/taskSchedule.js`).
- Cross-machine sync payloads stay version-gated (`server/lib/schemaVersions.js`) so a newer peer can't corrupt an older one.
- The self-update path stays fork-aware — other users run forks, not just upstream. **Never add `--force` to the server-side `gh repo sync`** (it would discard a user's fork commits; the 409 `FORK_DIVERGED` message points them at running it themselves). Don't re-hardcode the upstream slug outside `server/lib/gitRemote.js`, and new UI claiming "you are running PortOS" must read `remoteInfo.isUpstream`, not just `currentVersion`, or it lies to fork users. Mechanism: [docs/SELF_UPDATE.md](docs/SELF_UPDATE.md).

**The default database password `portos`** (in `ecosystem.config.cjs`, `docker-compose.yml`, `.env.example`) is an intentional backward-compatible fallback for local development. Do not remove it or flag it as a security concern. Production overrides it via `PGPASSWORD`.

**Storage backend policy.** PostgreSQL (system `:5432` or Docker `:5561`) is a **mandatory** dependency for every install and every federated peer — provisioned by `npm run setup:db` (ADR `docs/decisions/2026-06-07-postgres-as-primary-datastore.md`, `docs/STORAGE.md`). **`MEMORY_BACKEND=file` is a development/test-only escape hatch, NOT a supported deployment mode** — the creative catalog/pgvector, federation, and backup all assume Postgres with no file-backed equivalent. When `MEMORY_BACKEND` is unset, `server/services/memoryBackend.js` requires a healthy DB and fails fast with no silent fallback. That is **intentional**: do not "fix" the no-fallback behavior, re-add a file menu choice in `scripts/setup-db.js`, or treat the file backend as a fallback for real installs. The file path stays runnable only because `NODE_ENV=test` selects it — guarded from bitrot by the suite, not promoted to a deployment option.

**Third-party API keys for free, non-monetary services are not security findings.** PortOS calls a few free external APIs (e.g. CivitAI model downloads) with an API key in a query parameter or header. Proposals to host-allowlist the download URL before attaching the key, strip the key across redirects, or similar are won't-fix: leaking that key **to an unintended host** has no monetary loss and no meaningful security consequence — worst case is quota abuse against a free service, borne by that service. (This exempts only that class of finding; the key is still a secret under Sensitive Data & Privacy below — never commit or log it.) This does NOT extend to paid/quota-billed providers (LLM API keys, payment gateways) or keys gating money-bearing or destructive actions, which retain full hardening requirements. Precedent: issue #2200, closed 2026-07-04 (`applyDownloadToken` in `server/services/loras.js#installFromCivitai`).

**Never run DB-backed tests against the real `portos` database.** There is ONE Postgres per install, shared by every git worktree (including CoS-agent worktrees). The `*.db.test.js` suites `DELETE FROM`/`INSERT` whole tables, so running them against `portos` corrupts the user's real universes/series/writers-room/catalog. They are gated to skip on a non-test DB and run only via `npm run test:db` (→ `portos_test`, provisioned by `npm run setup:db:test`). The gate in `server/lib/db.js` keys on `isTestRunner()` (`NODE_ENV==='test'` **OR** `process.env.VITEST` — not bare `NODE_ENV`, so a wrapper that drops `NODE_ENV` can't disarm it), and the `query()` backstop refuses ALL row writes (`INSERT`/`UPDATE`/`DELETE`/`TRUNCATE`) to a non-test DB under the runner. Do not weaken either to "just `NODE_ENV`" or "DELETE-only" — that's exactly the hole that wiped real data on 2026-06-13/14. See `server/lib/db.guards.test.js`.

## AI Provider Usage Policy

**No cold-bootstrap LLM calls.** PortOS must never queue up AI provider calls a user hasn't knowingly triggered. A new install (or a freshly merged feature) coming online should be silent on the LLM front until the user actually asks for AI-backed work. This rules out:

- Firing LLM calls from server boot / `server/index.js` init sequences (cache warm-ups, pre-generation, startup backfills).
- Any background job that silently expands from "generate the one thing the user asked for" into "generate a whole batch for later," without the user having opted into that batch.

**Scheduled automations are the one sanctioned exception** — a cron-style task, autopilot, or CoS agent the user explicitly configured (`taskSchedule.js`, `backupScheduler.js`, autopilot gates) is expected to call AI providers on its own schedule, because the user set it up and knows it's running. Anything else touching an AI provider needs either a direct user action in the same request, or an explicit consent/config step first.

**Pattern for background pre-generation (e.g. caches):**

1. Boot-time init loads only what's already on disk — zero LLM calls.
2. The bulk/cold fill runs only from an explicit user-triggered endpoint, gated behind a UI prompt that names the provider/model about to be used and lets the user change it (or decline and get a single on-demand generation instead).
3. Incremental top-ups after the user has already engaged with the feature (replenishing one item after they consumed one from a primed cache) are fine to run silently — the user consented once, and a small top-up doesn't route through a slow provider unannounced the way a from-zero batch does.

Reference implementation: `server/services/meatspacePostDrillCache.js` (`initDrillCache` / `requestCacheFill` split) and `client/src/components/meatspace/post/WordplayTrainer.jsx` (`CacheFillConsentModal`) — added after a fresh MeatSpace POST install triggered an unannounced 40-call sequential TUI backfill on first boot.

## Architecture

The server is always user-facing on `:5555` (HTTP or HTTPS). The client runs on the Vite dev server at `:5554` under `npm run dev`; under `npm start` the built client is served from `:5555` directly. PM2 manages app lifecycles. Where a given record persists (Postgres vs a `data/` file) is decided by the storage-classification contract in `docs/STORAGE.md`.

**Ports.** PortOS uses 5553–5561 (system PostgreSQL on 5432, Docker PostgreSQL on 5561). When HTTPS is on, the loopback-only HTTP mirror on `:5553` is what local curl/scripts should hit to skip the cert warning. Define ports in the top-level `PORTS` object in `ecosystem.config.cjs` (canonical re-export at `server/lib/ports.js`). Full guide and diagram: `docs/PORTS.md`.

**Backup excludes.** `DEFAULT_EXCLUDES` in `server/services/backup.js` is **rsync filter syntax — every path must be anchored with a leading `/`.** An unanchored pattern matches at any depth and silently drops unrelated user data; that is a data-loss bug, not a style nit. See `docs/BACKUP.md` for the failure mode, the `overridable` tiers, and `computeEffectiveExcludes()`.

### Per-directory conventions

Client- and server-specific conventions live in nested memory files that load when you work in those trees (each is an `AGENTS.md` with a bridge `CLAUDE.md` beside it):

- `client/src/AGENTS.md` — UI conventions, routing/deep-linking, API error/save gating, the shared `Drawer` convention
- `client/src/components/dashboard/AGENTS.md` — widget registration, grid/arrange mechanics, ⌘K layout wiring
- `server/AGENTS.md` — schema parity, write serialization, peer fan-out in tests, prompt-template migrations
- `server/lib/aiToolkit/AGENTS.md` — the override-consistency contract for the vendored provider/runner/prompt toolkit (self-contained: no imports out to other PortOS modules). PortOS overrides `executeCliRun`/`stopRun`/`isRunActive` and mirrors time-based provider-status recovery on read — read it before editing the runner or provider config.

**Nested files reach API-provider agents too — but the walk is bounded.** Nested instruction files load on demand in the agent CLIs, and `getAgentInstructionsContext()` in `server/services/agentPromptBuilder.js` splices them into the prompts PortOS builds for its own API-provider agents as well (`~/.claude/CLAUDE.md` — Claude Code's user-level memory, which keeps that name — then the workspace-root file, then every nested one as its own labeled section). It matches `AGENTS.md` and `CLAUDE.md`, prefers `AGENTS.md`, contributes ONE entry per directory when both are present, and skips a bridge `CLAUDE.md` whose whole body is the `@AGENTS.md` import. The walk is capped at depth 5 / 10 files and skips dot-dirs, `node_modules/`, `data/`, build output, and any subdirectory carrying its own `.git` (submodules and vendored checkouts, e.g. `lib/slashdo/`). Two consequences: **a rule that must reach every agent has to sit inside that budget** — if the repo ever exceeds 10 nested files, the overflow is silently dropped, so raise the cap in the same change rather than assuming coverage; and **the root file is the only guaranteed-first slot**, so a rule guarding data loss, a destructive action, privacy, or spend still belongs here when it must outrank a subtree convention (that is why the backup-exclude anchoring rule above sits in root rather than `server/AGENTS.md`).

### Command Palette & Voice Nav — shared backbone

`server/lib/navManifest.js` is the single source of truth for navigation: `NAV_COMMANDS` + `resolveNavCommand()`, consumed by both the `⌘K` palette and the voice agent's `ui_navigate` tool. **Adding a `<Route>` without a `NAV_COMMANDS` entry leaves the page unreachable from `⌘K` and un-navigable by voice.** Invoke the `portos-add-page` skill for the entry shape, palette-action wiring, and the fail-fast guards.

**Optional features gate navigation, not routes.** `server/lib/instanceFeatureRegistry.js` declares the optional per-install features (`post`, `datadog`, `jira`) the user toggles in **Settings > Features**; `server/services/instanceFeatures.js` resolves each one as stored override → auto-detection of the integration it fronts → `defaultEnabled`. A nav entry tagged `feature: '<id>'` (or living in a section listed in navManifest's `SECTION_FEATURE` map) drops out of `⌘K` and the sidebar while that feature is off — **the `<Route>` keeps working, so bookmarks, direct links, and voice `ui_navigate` still resolve**. The gate is applied CLIENT-side (`useInstanceFeatures` + `client/src/lib/navFeatures.js`), not by filtering the manifest response: `⌘K` and the voice widget each fetch `/api/palette/manifest` once per session and it is HTTP-cached, so a server-side filter would both defeat that cache and still show hidden pages until a reload. Tag the sidebar row in `client/src/components/Layout.jsx` with the same id; `navManifest.test.js` scrapes both lists and fails when they drift, when a tag names an unregistered feature, or when a `SECTION_FEATURE` key stops matching a live section.

### Slashdo Commands (`lib/slashdo`)

PortOS bundles [slashdo](https://github.com/atomantic/slashdo) as a git submodule at `lib/slashdo`, providing slash commands (`/do:next`, `/do:review`, `/do:pr`, `/do:push`, `/do:release`, …) without a separate global install. The `.claude/commands/do/` symlinks expose them as project-level slash commands. `/do:next` claims the next PLAN.md item (or GitHub issue with `--issues`) in an isolated worktree and ships a PR. CoS agents can inline a command's content into a prompt via `loadSlashdoCommand(name)` from `server/services/subAgentSpawner.js` (it resolves `!cat` lib includes automatically).

## Module Organization

PortOS has reached the size where re-implementing a helper is cheaper to *start* than finding what already exists. To keep that pressure off, every directory holding reusable code carries a catalog `README.md` and an enumerable `index.js` barrel. **Before writing a helper, grep the catalog.**

### Where new code lives

- **Pure / side-effect-free helpers** → `server/lib/` or `client/src/lib/`
- **React hooks (state + lifecycle)** → `client/src/hooks/`. Names start with `use`.
- **Formatting helpers (pure, no React)** → `client/src/utils/` (`formatters.js`, `cronHelpers.js`, …)
- **HTTP / Socket / browser clients** → `client/src/services/`. API wrappers start with `api*`.
- **Express handlers** → `server/routes/`. Use `validateRequest` + `lib/validation.js` schemas.
- **Domain orchestration (multi-step business logic over models + services)** → `server/services/`
- **Persisted data (PostgreSQL vs a `data/` file)** → decide via the storage-classification contract in `docs/STORAGE.md` *before* defaulting to a new `data/*.json`. App-native relational records are `db-primary`; that doc's "Adding a new data store?" checklist is required in PR review.

One concern per file. Tests live next to their source as `<name>.test.js`. Naming is camelCase with a domain prefix (`brainValidation.js`, `creativeDirectorPrompts.js`).

### Discovery rule (BEFORE writing a helper)

Grep the catalog for the directory most likely to hold it:

```bash
grep -i "what you want to do" server/lib/README.md
grep -i "what you want to do" client/src/lib/README.md
grep -i "what you want to do" client/src/hooks/README.md
grep -i "what you want to do" client/src/services/README.md
```

If a close match exists, **extend it or use it**. Only add a new module when none fits. Pre-existing helpers that are easy to miss:

- `tryReadFile` (`server/lib/fileUtils.js`) — collapses `readFile(path).catch(() => null)`.
- `atomicWrite` (`server/lib/fileUtils.js`) — `ensureDir + writeFile + JSON.stringify` in one call.
- `createCollectionStore` (`server/lib/collectionStore.js`) — when a service outgrows its monolithic single-JSON-file shape (large per-record payload, frequent mutations), use this instead of rolling another `readJSONFile` + `atomicWrite` + `createFileWriteQueue`. Lays out `data/{type}/{id}/index.json` with a type-level `data/{type}/index.json` stamping `schemaVersion` (the storage-layout version, distinct from any per-record-shape `schemaVersion` the sanitizer carries). Includes a per-id write queue and a `verifySchemaVersion` hook used by the boot-time verifier in `server/index.js`. Worked example: `server/services/universeBuilder.js` (migration 034 splits the legacy `universe-builder.json` into this shape).
- `optionalBooleanMap(keys)` (`server/lib/validation.js`) — collapses `z.object(Object.fromEntries(KEYS.map(k => [k, z.boolean().optional()])))`.
- `flattenCanonDescriptorFragments` / `mapCanonDescriptorFragments` (`server/lib/canonPrompt.js`, mirrored to client) — render `[{ prefix?, value }]` fragments to a sentence or array.
- `copyToClipboard` / `writeClipboardSilently` / `readClipboard` (`client/src/lib/clipboard.js`) — safe on insecure-origin contexts. Never use `navigator.clipboard.writeText` inline.
- `useLockToggle` (`client/src/hooks/useLockToggle.js`) — optimistic-PATCH lock toggle for any new lock button.
- `useSseProgress` (`client/src/hooks/useSseProgress.js`) — generic JSON-frame EventSource subscriber; build new progress hooks on top of it.
- `formatBytes` / `formatTimecode` / `formatDateShort` / `formatDurationMs` / `timeAgo` (`client/src/utils/formatters.js`) — never re-define formatters inside components.

### Maintenance rule (WHEN adding a public module)

Any new file in `server/lib/`, `client/src/lib/`, `client/src/hooks/`, `client/src/utils/`, or a new `apiX.js` in `client/src/services/` **MUST**:

1. Be re-exported from the same-directory `index.js` barrel (or, for `services/`, from `api.js`).
2. Get a one-line row in the same-directory `README.md`.

This is the one rule that keeps catalogs from rotting, and it is enforced: `server/lib/index.test.js` and its client counterparts fail when a non-test `.js` file is missing from either the barrel or the README.

**Name collisions.** When two modules in one directory export the same identifier (e.g. `settingsUpdateInputSchema` in both `brainValidation.js` and `digitalTwinValidation.js`), the barrel uses `export * as <name>` namespace exports so callers reach for `brainValidation.settingsUpdateInputSchema` explicitly. Catch-all modules like `validation.js` stay flat. The collision-detector test fails if two flat-`export *` modules ever share an identifier, forcing namespace resolution where the conflict is introduced.

Existing deep imports (`import { x } from '../lib/foo.js'`) keep working — the barrel exists for *discovery*, not to force a re-import. New code may use either form. The worked example for "barrel + documented exports" is `server/lib/aiToolkit/index.js`.

## Scope Boundary

When CoS agents or AI tools work on managed apps outside PortOS, all research, plans, docs, and code for those apps must be written to the target app's own repository/directory — never to this repo. PortOS stores only its own features, plans, and documentation. A PLAN.md, research doc, or feature spec generated for another app goes in that app's directory.

## Sensitive Data & Privacy (developing on a live instance)

**This code is written and reviewed on a live install holding one real user's data.** Machine identity, network topology, personal records, and app-specific names read out of the running instance are the user's private data — they must never leak into anything committed, pushed, or published. Treat every artifact an agent produces (source, comments, test fixtures, docs, changelog, commit messages, PR titles/descriptions/review comments, issue text) as world-readable the moment it lands on a branch.

**Never commit, log to a shared file, or write into a PR/issue/commit any of:**

- **Machine identity** — hostnames, machine names, Tailscale node / MagicDNS names, device IDs, OS usernames, home-directory paths embedding a username (`/Users/<name>/…`, `/home/<name>/…`), user email addresses, account IDs, license keys, serial numbers.
- **Network info** — LAN/Tailscale/public IPs, MAC addresses, subnet layouts, port-forwarding maps, router/gateway addresses, VPN keys, `.env` secrets, DB passwords other than the documented `portos` dev fallback, API tokens, session cookies, auth headers.
- **PII** — real names, physical addresses, phone numbers, birthdays, government IDs, payment details, GPS coordinates, biometric data — the user's or anyone in their data.
- **Personal app data** — the actual contents of the running instance: real universe/series/writers-room/catalog records, brain/journal entries, MeatSpace/POST data, media project names, scheduled-task payloads, chat/voice transcripts, or any record pulled from `data/`, the live DB, or a running screen. Never paste a real record into a test fixture, a doc example, or a bug report.

**Rules for agents:**

- **Placeholders, not observations.** When code, a test, a comment, or a doc needs an example value, invent an obviously-fake one (`example.com`, `alice@example.com`, `192.0.2.10` (TEST-NET-1), `Acme Corp`, `Example Universe`, `host-XXXX`). Never transcribe a value observed in the live instance or environment.
- **Reproduce with redaction.** When a bug repro, log excerpt, or stack trace legitimately needs real state, redact the sensitive fields (`<hostname>`, `<user-email>`, `<tailscale-ip>`, `<record-id>`) before it goes into a commit, PR, issue, or review comment. The point is the shape of the data, not its contents.
- **No environment scraping into artifacts.** Do not run `hostname`, `whoami`, `ifconfig`/`ip addr`, `tailscale status`, `env`, `git config user.*` and paste the output into anything committed or published. Read them only for transient in-session logic; never persist them.
- **Scrub before you ship.** Before `git add`/commit and before opening or commenting on a PR/issue, scan your own diff and prose for the categories above. If real data slipped in, replace it with a placeholder; if it was already committed, amend/rewrite the branch before pushing rather than layering a "redaction" commit on top (the history still leaks).
- **Absolute paths.** Prefer repo-relative paths in committed text; when an absolute path is unavoidable, strip the user segment (`~/…` or `<repo-root>/…`).

This complements the Security Model (which governs the deployed product) — this section governs what agents may *write down* while working against real data.

## Code Conventions

- **No try/catch** — errors bubble to centralized middleware. **Exception:** PTY/child-process/`setTimeout`/`setInterval` callbacks and any code running *outside* the Express request lifecycle. An uncaught throw there crashes the Node process (there is no `next(err)` to bubble to). At those boundaries, wrap hook invocation in try/catch and log via the emoji-prefixed `console.error` style. Async event handlers that mutate shared module-level state (e.g. the TUI spawner's `handleData`) must also be serialized — chain them onto a per-session/per-actor `Promise.resolve()` queue rather than firing concurrently, or interleaved awaits race on shared buffers.
- **Functional programming** — no classes; use hooks in React.
- **Zod validation** — all route inputs validated via `lib/validation.js`.
- **Command allowlist** — shell execution restricted to approved commands only.
- **Every new page registers in the nav manifest** — adding a `<Route>` + sidebar link also means a `NAV_COMMANDS` entry in `server/lib/navManifest.js`, which makes the page reachable via `⌘K` and voice (`ui_navigate`). Invoke the `portos-add-page` skill for the entry shape.
- **Selection lives in the URL, never in local state** — any view that opens/selects a specific record encodes it as a route param, so it's shareable, bookmarkable, and reachable from ⌘K and voice. Full contract in `client/src/AGENTS.md`.
- **Client UI conventions** (`client/src/AGENTS.md`) — no `alert`/`confirm`, `htmlFor`/`id` label pairing, mobile responsive, above the fold, no hardcoded localhost, alphabetical nav, reactive local-state updates after mutations, silent-vs-toasting API errors, save gating for "Run Now" actions, and the shared tabbed `Drawer` convention.
- **Server conventions** (`server/AGENTS.md`) — schema parity when adding fields, serializing async PATCH races on shared records, batching high-frequency state writes, peer fan-out in record-creating tests, backup exclude anchoring, and stage-prompt template migrations.
- **Socket-driven UI** — invoke the `portos-socket-ui` skill before wiring or debugging a socket-driven view (event-driven state swaps, single-subscriber resources, pending-request tracking, deferred-work guards).
- **Single-line logging** — emoji prefixes and string interpolation; never log full JSON blobs or arrays.
  ```js
  console.log(`🚀 Server started on port ${PORT}`);
  console.log(`📜 Processing ${items.length} items`);
  console.error(`❌ Failed to connect: ${err.message}`);
  ```
- **LLM response merging — distinguish absent vs intentionally empty.** When merging an LLM response into existing state, "key absent" must preserve the original while "key present with empty value" must apply the intentional clear. Don't use `.length` truthiness as the signal — it conflates the two and silently restores values the user (or LLM) just cleared.
  - Strings: `null`/`undefined` = absent, `""` = a clear. Server helpers like `universeBuilderExpand.trimField` return `null` for non-strings, not `""`.
  - Arrays/objects: gate on `Array.isArray(parsed?.field)` / `typeof parsed?.field === 'object'` before falling back to the original.
  - Keep server-side merges and the client's `pick` helpers mirrored — a one-sided change breaks the round-trip.
- **Sentinel + validate to distinguish "not set / failed" from "present-but-empty / valid".** The `.length`-truthiness footgun above is one instance of a broader rule: never let *absent*, *failed-to-fetch*, or *invalid* collapse into the same value as *fetched-and-legitimately-empty* or *valid*. Use an explicit sentinel and validate before falling through — not `x.length` or `x || fallback`-on-mere-presence. Canonical examples in the local-LLM backends: model-list caches use `null = not fetched` vs `[] = cached-empty`, so a zero-model backend still caches instead of re-hitting the API every call (`ollamaManager.js` `installedModels`, `lmStudioManager.js` `availableModels`); `getBackend()` validates the `.env` marker first and only then falls back to `process.env`, so a stale `.env` value can't mask a valid runtime env override (`server/services/localLlm.js`); and a reachable-but-list-failed backend surfaces an explicit `modelsError` rather than reporting `0 models` (`lmStudioManager.js` `getLastListError`).

## Git Workflow

- **main**: active development. **release**: push `main` to `release` to trigger the GitHub Release workflow.
- **Push pattern**: `git pull --rebase --autostash && git push`
- **No per-branch changelog entries.** Individual PRs do not write a changelog file or fragment — commit messages are the record. `/do:release` synthesizes the release notes from the commit log since the last tag (grouped by feature/theme) when it runs, and writes the result to `.changelog/v{version}.md`. This replaced an earlier per-branch fragment workflow (`.changelog/next/*.md` + `npm run changelog:add`), which existed to avoid parallel branches conflicting on a shared `NEXT.md` — deriving notes from commits at release time sidesteps that problem entirely, since no branch writes to `.changelog/` anymore. Consequence: **write commit subjects/bodies for a human release-note reader**, not just for `git log` — see "Git commits and PRs" in the global instructions. Full rationale: `.changelog/README.md`.
- **Versioning**: the version in `package.json` reflects the last release. Do not bump during development — `/do:release` handles it.
- After each feature or bug fix, run `/simplify`, then commit and push.
- **Capture deferred work, and decide rather than park it.** Deferred refactors/cleanups go into a filed GitHub issue labeled `plan`, specific enough to pick up cold — never left only in chat. When the sole obstacle is an undecided design choice, **make the call yourself** and file it ready-to-work; `future` / `needs-input` are last resorts. Invoke the `portos-file-issue` skill for the full labeling contract. Add independent slashdo dispatch hints (`model:light|medium|heavy`, `effort:low|medium|high|xhigh|max`) and contributor labels (`good first issue`, `help wanted`) only when the work you just inspected justifies them — omit an axis rather than guessing, never stamp `medium` on both, and never mark a wide mechanical sweep as a good first issue. Also stamp `planner:<model>` — a third, independent axis naming the model that WROTE the plan — taking the value verbatim from the "Planner Attribution" section of your own prompt (PortOS resolves it from the provider/model it dispatched you with); never guess it from what you believe you are, and omit it when your run was given none. Create missing labels lazily with slashdo/GitHub colors before `gh issue create`, use repeated `--label` flags, and keep category labels (`plan`, `ux`, `bug`, `tests`) intact.
- **Never link to AI conversation sessions.** Do not paste `claude.ai`, `chatgpt.com`/`chat.openai.com`, or any other AI chat/session share URL (or a "generated by / view this conversation" link) into a PR description, commit message, issue, or review comment. These leak session context, aren't durable references, and read as AI attribution — the PR must stand on its own with a Summary and a Test plan. Reference durable artifacts instead: issue/PR numbers, commit SHAs, file paths.
- If enough commits have accumulated to warrant a production release, pull the latest `main` and `release`, then run `/do:release` from `main`.
- **Archive approved design plans.** When a plan is approved out of plan mode, copy the finalized plan from `~/.claude/plans/` to `./docs/plans/YYYY-MM-DD-<slug>.md` (date of approval) as a design record before implementing. See `docs/plans/README.md`.

## Documentation

`docs/README.md` indexes everything under `docs/` — guides, feature deep dives, ADRs (`docs/decisions/`), and design records (`docs/plans/`). The contracts referenced most often from code review: `docs/STORAGE.md` (where a record lives), `docs/PORTS.md`, `docs/BACKUP.md`, `docs/SELF_UPDATE.md`, `docs/ARCHITECTURE.md`, `docs/API.md`.
