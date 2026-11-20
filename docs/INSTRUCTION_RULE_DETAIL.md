# Instruction-file rule detail

Root and nested `AGENTS.md` files carry a byte budget (`server/test/guards/repo/agent-instructions-files.test.js`), so passages that are procedure or detail live here and the instruction file keeps the one-sentence rule. Each passage adds detail its instruction file leaves out, and the rule left there stays authoritative; a sentence already in the instruction file is not repeated here.

## Agent instruction files

**API-provider agents get these files too, within a budget**: `getAgentInstructionsContext()` in `server/services/promptSections/instructions.js` splices `~/.claude/CLAUDE.md`, the root file, then nested `AGENTS.md` files (depth 5 / 10 files; dot-dirs, `node_modules/`, `data/`, build output and nested repos skipped). The root file is the only guaranteed-first slot: rules guarding data loss, destructive actions, privacy or spend belong here. `server/test/guards/repo/agent-instructions-files.test.js` caps root at 28 KB and each nested file at 12 KB; move task-specific procedure into a skill (`.claude/skills/`) or doc rather than raising them.

The 28 KB / 12 KB ceilings are the only absolute failure. A file already above 90% of its ceiling at the merge base (`CI_BASE_SHA`, else the merge-base with the remote default branch; a missing base fails closed) may not grow in the change, so two small edits merged separately cannot land over the cap while files can still shrink back toward the line.

Read the nested instructions before editing these trees (each an `AGENTS.md` with a bridge `CLAUDE.md`):

- `client/src/AGENTS.md`: UI, routing/deep-linking, API error/save gating, `Drawer`, collection loading
- `client/src/components/dashboard/AGENTS.md`: widget registration, grid/arrange, ⌘K layout wiring
- `server/AGENTS.md`: schema parity, write serialization, async boundaries, test peer fan-out, import scoping, generated manifests (incl. `scripts/generate-*.js`), prompt templates
- `server/lib/aiToolkit/AGENTS.md`: the override-consistency contract for the vendored provider/runner/prompt toolkit (no imports out to other PortOS modules)

## Federation between the user's own machines

Personal content alone is no reason to block federation ([ADR](decisions/2026-09-19-user-controlled-federation.md)), and Brain records (including tracked-topic threads) may travel the Brain sync channel. Keep the configured peer/category controls and each domain's wire contract. Status/capability endpoints keep bounded projections, never an export path.

## Logging levels

**Single-line logging** with emoji prefixes and interpolation; never log JSON blobs or arrays (`console.log(\`🚀 Server started on port ${PORT}\`)`). **stderr means "investigate"**: `console.error` (`❌`/`⛔`) and `console.warn` only for something actually wrong. Deliberate behavior stays on `console.log` with a non-failure marker: guard refusals and 4xx (`🚫`), skips and dedupes (`⏭️`), handled degraded states (iCloud eviction, peer on another schema, quota, reconnect/retry), slow-path telemetry (`🐢`). If it fires on a normal day it is not stderr. For a mixed status line pick the sink first (`const log = ok ? console.log : console.error;`); `server/test/guards/runtime/logLevelConventions.test.js` keeps failure markers off stdout.

## LLM response merging and sentinels

**LLM response merging** string gate: `null`/`undefined` is absent, `""` a clear (`universeBuilderExpand.trimField` returns `null` for non-strings). Array/object gate: `Array.isArray(parsed?.field)` / a non-null, non-array object.

**Sentinel** examples: `null` not fetched vs `[]` cached-empty (`ollamaManager.js` `installedModels`); a reachable backend whose list failed surfaces `modelsError`, not `0 models` (`getLastListError`).

## Error handling outside the request lifecycle

Outside the request lifecycle, a caught hook failure logs in the emoji `console.error` style. Async event handlers mutating shared module state (the TUI spawner's `handleData`) serialize on a per-session `Promise.resolve()` queue.

## Server conventions

The original, unabridged wording of rules whose one-sentence form now sits in `server/AGENTS.md`.

**Schema parity when adding fields.** A field added to a sanitizer, `createXxx` or payload shape gets its Zod schema in the same change (`lib/aiToolkit/validation.js` for toolkit shapes, the domain `lib/*Validation.js` file for routes), wired into POST and PUT (`schema.partial()`); an unwired sub-schema is false confidence. Polymorphic stores (`PUT /api/settings`) validate the present slice with `schema.partial()` (`backupConfigSchema.partial()` in `server/routes/settings.js`). Tolerate UI sentinels (`endpoint: ''`) with `z.preprocess(v => v === '' ? undefined : v, …)`; a service migrating legacy keys on read keeps accepting the legacy shape.

**Serialize a `json`/`jsonb` parameter with `toPgJson`, never bare `JSON.stringify`.** Postgres rejects a lone UTF-16 surrogate or NUL in `jsonb` (NUL in `text`), which old file stores accepted, so the write throws and the record is lost (#12815). `toPgJson` and `normalizePgString` in `server/lib/pgJson.js` repair to U+FFFD. `lib/db.js` normalizes plain parameters on every `query()`, but a pre-stringified JSON string looks like text to it. *Enforced:* `server/test/guards/runtime/pgJsonConventions.test.js` (frozen `scripts/db-migrations/` are skipped).

**Attach a spawned child's terminal listeners before the function next `await`s**: a failed spawn reports on `process.nextTick` and a fast child can exit while you're suspended, so an unlistened `error` crashes the process and an unlistened `close` strands the job `running`. Do awaited work before `spawn()`, or call `bufferChildExit(child)` (`services/videoGen/generateVideoHelpers.js`) in the same tick and replay its result (`services/imageGen/local.js`) (#11761). *Enforced:* `server/test/guards/runtime/childListenerOrderConventions.test.js`.

Record writes reach peer sync only through the subscription adapter in `server/services/sharing/recordEvents.js` (a no-op until `peerSync.js` registers). A suite loading the peer-sync graph (`peerSync.js` or `sharing/index.js`, even transitively) mocks `services/instances.js` with `mockNoPeers()` and `services/sharing/peerSync.js` with `mockNoPeerSync()` from `server/lib/mockPathsDataRoot.js`. To assert auto-subscribe in a domain test, register a double with `registerSubscriptionAdapter({...})` and reset with `__resetSubscriptionAdapter()`.

**The tree-wide guard is base-relative growth** (`scripts/lib/importGrowth.js`): summed closure growth of suites existing on both sides, against the merge base (`CI_BASE_SHA`), stays under `EXISTING_SUITE_GROWTH_LIMIT` (2,500); new test files don't spend it, and a missing base fails. On failure, narrow or defer the import. Raising the limit is the intentional-regression path: same change, name the module that can't be deferred, stay under the pin test's band. Pregate's selected `release` refs are exempt from this limit only.

## Slashdo read resolution

A `!read lib/<name>.md` in a nested file or a `~/.claude/lib/` reference resolves against the bundled package root; in a staged CoS bundle it resolves against the containing file. Read each phase's file only when that phase applies, and don't rely on a global install.

## Testing

`server/vitest.config.js` forces `NODE_ENV=test` so a suite never inherits PM2's `development` environment and aims at the real Postgres. What pregate runs, and its Windows and interrupt behavior: [PREGATE.md](PREGATE.md). The full test policy, including retry, timeout and process-lifecycle state machines as unit-test territory: [CONTRIBUTING.md](CONTRIBUTING.md#test-strategy-value-over-assertion-count).

## Findings and review scope

Review scope stays tied to the requested change and affected contracts; subjective preferences are not defects. The ephemeral-state rule also covers branches, agent completion state and state-preservation findings, and never justifies a two-step review endpoint.

## Filing and routing issues

Cross-link an issue in slashdo and PortOS only when both need changes.

## Provider calls and model input

The cold-bootstrap reference implementation is `initDrillCache` (boot, disk only) and `requestCacheFill` (user-triggered fill) in `server/services/meatspacePostDrillCache.js`.

Static additions shown as chips beside the user's own words include universe/project style, production bible, mood-board style, shot actions, preset negatives, the agent wrapper and policy clauses.

## Security exemptions

The free-API-key exemption's CivitAI case lives in `applyDownloadToken` (`server/services/loras.js`).

## Realtime updates

When a view would need a timer to stay fresh, add the missing server event rather than polling.

## Code comments

Also remove walkthroughs; keep meaningful type/JSDoc and public API docs. There is no comment quota in either direction.

## Documentation

[ETHOS.md](../ETHOS.md) also lists the commitments a change must not break. `docs/README.md` indexes ADRs (`docs/decisions/`) and plans (`docs/plans/`, conventions in `docs/plans/README.md`); start with `docs/STORAGE.md`, `docs/ARCHITECTURE.md` and `docs/API.md`.

## Keyboard ownership and web storage

**Space is a global push-to-talk hotkey.** A surface owning Space (drill, keyer, transport) claims it with `useKeyCapture`. Global key handlers stand down for native button activation through one predicate, `shouldIgnoreGlobalKey(event, opts)` in `lib/a11yKeyboard.js`; add guards there, never at one caller (#4748). A key-owning surface spreads `noPointerFocusSurfaceProps` on its root so a click focusing an inner button doesn't take the key over.

**Web Storage goes through `lib/safeStorage.js`** (`safeReadStorage` / `safeWriteStorage` / `safeRemoveStorage` and their `Json`/`*Session` variants). Raw `localStorage`/`sessionStorage` throws in Safari private mode, sandboxed iframes, disabled cookies and at quota (`typeof`/`?.` don't guard it), unmounting the route (#5689). *Enforced:* `client/lint-no-raw-web-storage.grit` (Biome plugin; exemptions are negated globs on its override in `client/biome.jsonc`).

## Client rules

The original, unabridged wording of rules whose one-sentence form now sits in `client/src/AGENTS.md`.

**Fix missing prerequisites in place.** Show the missing tool or setting beside the blocked action with the existing setup/check controls, and preserve the user's work; for setup outside the app, give concrete steps and a retry. For linked records, locks or approvals, link to the exact place it's resolved (reachable for stale and already-approved records), not just a disabled control. Keep existing authority checks.

**Mobile responsive, always.** A `grid-cols-N` with N > 3 and no `…:grid-cols-*` in the same class string is a bug: give text-bearing cards a phone default and widen by breakpoint (`grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4`); a wider gap is not a column breakpoint. Square thumbnail/heatmap grids may stay 4+ on a phone but still need a breakpoint. *Enforced:* `responsiveGridConventions.guard.test.js`.

**List deletion preserves place** ([contract](UX_DESIGN_GUIDE.md#list-deletion-and-reading-position)): after the server confirms, collapse the row with `components/ui/CollapsibleListItem` (spacing inside the wrapper), then remove it from local state. Keep the list, scroll container, filters and pagination mounted, never swap in a loading placeholder, keep failures visible, guard duplicates, honor reduced motion, and move focus to a surviving row with `preventScroll`.

**Every selectable record is deep-linkable**: an opened project, item, scene, editor or master-detail selection is a route param (`/music-video/:projectId`), never `useState`/`selectedId`. Selection `navigate()`s to the id route, delete/clear `navigate()`s back to the index, and stale ids render a not-found fallback. Register both the index and `:id` routes in `App.jsx`, and the base path in `NAV_COMMANDS`.

Every potentially growing list follows [the collection-loading contract](UX_DESIGN_GUIDE.md#large-collections-and-incremental-loading): bounded server pages, active-route data only, details on demand, `usePagedCollection` + `InfiniteScrollFooter` for new infinite lists, socket invalidation instead of whole-list polls, and query-wide search/counts (never only loaded rows). Client-side slicing of an unbounded response is not pagination.

Settings-over-a-feature surfaces use the shared `client/src/components/Drawer.jsx`, never a hand-rolled `fixed inset-y-0 right-0` clone. **All mutable form state lives in the parent** (per-tab scroll remounts the body), the overlay is always portaled to `<body>` (any new hand-rolled `fixed inset-0` overlay too, #4150), and a deep-linkable tab uses `useDrawerTab`. Sizes, tabs, Esc/backdrop and examples: [the drawer contract](UX_DESIGN_GUIDE.md#config-drawers).

**Size form fields for their content.** Short selects and numeric inputs share rows when there is room and stack when narrow; prefer bounded wrapping grids (`grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),24rem))]`) over full-width controls. Keep labels and help with their fields, preserve tab order, give prose editors and long paths room, no global input width limits.

**Never `autoFocus` a control that appears in response to a key-submit**: the still-down Enter activates it the moment it mounts. Keep the submitting element focused (`readOnly`, not `disabled`) and filter `e.repeat` (`MorseTrainer.jsx`), or handle Enter-to-advance in a window handler gated on `shouldIgnoreGlobalKey` with the button unfocused (`PostDrillRunner.jsx`).

**A sanctioned poll uses `useAutoRefetch(fetchFn, intervalMs, { enabled, pollOnly: true })`** (`hooks/useAutoRefetch.js`), never a hand-rolled `setInterval`; it pauses in hidden tabs (#5697). Pass the gate as `enabled`, not an early `return`, and `immediate: false` when another effect owns the first fetch. *Enforced:* `pollingConventions.guard.test.js`.

**Pick the right Layout scroll mode** by where the `<Route>` sits in `App.jsx`, never by pathname: `PageLayout` pages (`PageHeader` over an internally scrolling body) go under `<FullWidthMain />`, document/form routes (`/apps/create`) under `<PaddedMain />` (`components/PageShell.jsx`). Exceptions: `docs/research/PAGE_LAYOUT_AUDIT.md`.

## Authentication and HTTPS detail

- **Auth**: an optional instance password (`server/services/auth.js`, enforced by `server/services/authGate.js`) gates `/api/*` and `/data/*`, except `ALWAYS_PUBLIC_API_PATHS` in `server/lib/apiAccessPolicy.js` (`/api/auth/status`, `/api/auth/whoami`, `/api/auth/login`, `/api/auth/logout`, `/api/system/health`, `/api/eidoverse/travel/guest`). Paired peers use scoped pair credentials attached by `peerFetch` (`server/lib/peerHttpClient.js`); legacy Basic uses the instance password and is not scoped (`docs/PEER_PUSH_AUTH.md`).
- **PortOS-spawned agents** authenticate with `PORTOS_API_TOKEN`, a loopback session token injected into their environment (`server/services/agent/agentApiAuth.js`). Any `curl` against this install's API carries `-H "Authorization: Bearer ${PORTOS_API_TOKEN:-}"`; on `401 AUTH_REQUIRED`, check for a missing, expired or invalid token before diagnosing availability. It is empty when no password is set and never given to a public-content review stage.
- **Agents PortOS did not spawn** call the API with `node scripts/portos-api.js …` (`PORTOS_API_TOKEN` when set, else the opt-in key in `~/.portos/agent-key.json`); never ask for or type the instance password ([docs/AGENT_API_KEY.md](docs/AGENT_API_KEY.md), `portos-api` skill).
- **HTTPS**: `npm run setup:cert` flips `:5555` to TLS with a loopback-only HTTP mirror on `:5553`. Peer hops set `rejectUnauthorized: false` because WireGuard authenticates tailnet nodes; a non-tailnet peer (plain LAN IP or non-`.ts.net` host, see `peerRequiresTailscale()`) gets no server authentication.

Full federation rule (moved from root):

(see root) Credentials, tokens, encryption keys and machine-local execution/sync settings stay local; guarded local-only stores (Privacy Center, message mirrors, provider configuration) gain sync only through a scoped change, never a doc clarification; non-self peers, guests, public worlds and external services follow that surface's audience controls (ADRs in `docs/decisions/`). Wire contract and permitted Brain sync: [detail](docs/INSTRUCTION_RULE_DETAIL.md#federation-between-the-users-own-machines).

## Security posture detail

**Preserve delegated agent authority.** In the host-control gate an operator session includes a verified `PORTOS_API_TOKEN` agent session; operator does not mean human-only. Genuine local callers keep host access when auth is disabled; network reachability and scoped peer credentials do not grant it. A Basic password holder can already exchange it for a session, so refusing Basic is credential-use policy, not isolation. Security findings distinguish these principals and test both unauthorized refusal and the preserved authorized workflow (trace the real path, fallback and deferred work included). Authorized agent execution is an intended capability, not a vulnerability; a configured tool-capable provider still never lets an anonymous remote caller launch it.

**Assess security findings against actual control, reachability and impact.** Follow [security risk assessment](docs/SECURITY_RISK_ASSESSMENT.md): distinguish owner-input reliability and conditional exposure from unauthorized harm, retain external-content and browser/network defenses, reuse the existing abuse guard only on paths it covers, and record dispositions with reevaluation conditions.

**Audit the external boundary, not delegated autonomy.** Trusted local agents in a user-granted workflow are operators, not adversaries. Protect against malicious third-party code and dependencies, issue/PR/review content, retrieved pages and files, model output, and unauthorized LAN/tailnet callers; local execution does not sanitize them, and untrusted content cannot expand a grant, pick a new audience, change policy or gain host authority. Fix the actual crossing instead of adding human-only approvals, repeated passwords, blanket tool restrictions or per-step confirmations. Keep revision/evidence checks, data protection, budgets and explicit publication controls.

(see root) Provider permissions, quotas, budgets and purchase authorization still apply (the `portos-music-video-*` skills carry the delegated-review detail).

## Distribution model detail

(see root)

- **Never delete or skip migration/compatibility code because "there's only one install."**
- On-disk format changes need a migration in `scripts/migrations/` (applied-list per install in `data/migrations.applied.json`). Seed files ship in `data.reference/`.
- **A migration that DERIVES `data/<x>` from existing records ships NO `data.reference/<x>` seed and gates on its INPUT, never its output's absence**: `setup-data.js` copies missing seeds first, so a seeded output looks "already done" and the next write destroys the user's data (`scripts/migrations/340-cos-config-seed-repair.js`). Declare such a path in `scripts/lib/migrationOwnedPaths.js` and in the migration's `OWNED_OUTPUT_PATHS`; the guard checks both.
- Prompt-default changes: edit the body, then run the integrity-snapshot regen, which bumps the version so other installs upgrade stored defaults (procedure: `server/AGENTS.md` "Prompt templates").
- Cross-machine sync payloads stay version-gated (`server/lib/schemaVersions.js`).
- Self-update stays fork-aware. **Never add `--force` to the server-side `gh repo sync`** (it discards fork commits; the 409 `FORK_DIVERGED` message tells the user to run it themselves). The upstream slug lives only in `server/lib/gitRemote.js`; UI claiming "you are running PortOS" reads `remoteInfo.isUpstream` ([docs/SELF_UPDATE.md](docs/SELF_UPDATE.md)).

## Privacy detail

Use obviously fake placeholders (`example.com`, `alice@example.com`, `192.0.2.10`, `Acme Corp`, `host-XXXX`) and redact repro logs (`<hostname>`, `<user-email>`, `<tailscale-ip>`, `<record-id>`). Read `hostname`, `whoami`, `ifconfig`/`ip addr`, `tailscale status`, `env` or `git config user.*` only for in-session logic, never into an artifact. Scan your diff and prose before committing or posting; if real data was already committed, rewrite the branch before pushing, not a redaction commit. Prefer repo-relative paths (`~/…` or `<repo-root>/…` when absolute is unavoidable). **Never link AI conversation sessions** (`claude.ai`, `chatgpt.com` or any chat share URL) in PRs, commits, issues or reviews; reference issue/PR numbers, SHAs and file paths.

## AI provider policy detail

**No cold-bootstrap LLM calls.** PortOS never queues provider calls the user hasn't knowingly triggered: none from server boot or `server/index.js` init (warm-ups, pre-generation, backfills), and no background job that grows "what the user asked for" into "a batch for later." User-configured scheduled automations (`taskSchedule.js`, `backupScheduler.js`, autopilot gates, CoS agents) are the one exception; anything else needs a direct user action in the same request or an explicit consent/config step. For cache pre-generation, boot loads only what is on disk; the cold fill runs only from a user-triggered endpoint behind a prompt naming the provider/model that lets the user change or decline it; replenishing an item the user consumed may run silently. Reference: `meatspacePostDrillCache.js`.

## Live Node inspector

- **Live Node inspector**: no dynamic `import()` from an inspector-evaluated callback ([safe cleanup](docs/TROUBLESHOOTING.md#dynamic-import-callback-missing-after-profiling)).

## Moved from root (issue triage, findings, storage)

- **Route to the owner.** Shared slashdo command, renderer or workflow defects go to [atomantic/slashdo](https://github.com/atomantic/slashdo/issues); PortOS behavior, integration, configuration and instructions go here; forks and managed apps use their configured remote. Use your own authorized GitHub identity, never the owner's (Pico-delegated work: `picodot`; the owner's local agents: `atomantic` when authorized).
- **Search before filing.** Reuse an existing issue and add evidence; a new issue carries redacted evidence or repro steps, expected vs actual, affected files, a next step and acceptance criteria, and says whether a flake is suspected or reproduced. (see root) For PortOS, read [portos-file-issue](.claude/skills/portos-file-issue/SKILL.md) and the label guidance in `server/lib/dispatchLabels.js`.

A rule may be retired after reassessing its value and feasibility, with concise rationale; difficulty alone is not an exemption, and retiring never hides a known important defect. Never suppress findings, weaken tests, demote rules or disable useful checks to get green; invest in high-quality fixes. A hardware, permission or genuinely user-owned blocker stays explicitly unresolved with evidence, an owner and a tracked next step, never relabeled clean. Bounded audits may track remaining accepted work; severity alone never justifies deferral.

**Storage backend.** PostgreSQL (system `:5432` or Docker `:5561`, `npm run setup:db`) is mandatory for every install and peer (`docs/STORAGE.md`). `MEMORY_BACKEND=file` is a dev/test escape hatch selected by `NODE_ENV=test`; with it unset, `server/services/memoryBackend.js` fails fast without a healthy DB, intentionally: add no silent fallback or file choice to `scripts/setup-db.js`.

**API keys for free, non-monetary services are not security findings.** Host-allowlisting or redirect-stripping one (CivitAI, #2200) is won't-fix; the key is still never committed or logged. Paid/quota-billed keys and keys gating money-bearing or destructive actions are not exempt.

## Moved from root (commands, worktrees, privacy lists)

**Run pregate before every push and again after rebasing onto a moved base** (`node scripts/pregate.js` on Windows). It skips imports past two hops and browser/DB/build/boot-smoke suites, so run a focused public-boundary regression as you implement; `--full` runs CI's broad plan, still pinned to `portos_test`. Its receipt is local evidence only; hosted CI and provider-enforced checks and reviews stay mandatory ([what it runs](docs/PREGATE.md)).

Use linked binaries (`server/node_modules/.bin/vitest run <files>`). Only the `dependency-updates` task's worktree has no symlinks and installs inside itself. A worktree PortOS did not create runs `node scripts/link-worktree-deps.js <primary-checkout> <worktree>` right after `git worktree add` (pregate links too).

- **Network info**: LAN/Tailscale/public IPs, MACs, subnets, port forwards, gateways, VPN keys, `.env` secrets, DB passwords other than the `portos` dev fallback, API tokens, cookies, auth headers.

## Moved from root (platform, host control, changelog)

macOS is the primary interactive app/browser target; Windows is secondary; Linux interactive browser compatibility is not a support target (Linux server support is unchanged), and headless Linux CI failures still get investigated. Linux-browser-only work needs a supported-target reproduction or concrete shared-code, server, security or data impact. Triage: [portos-file-issue](.claude/skills/portos-file-issue/SKILL.md) and [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md#platform-support-and-issue-triage).

(see root) Encourage a strong, unique instance password. Password-free installs warn after upgrade until the operator accepts the risk or sets one; acceptance is machine-local and grants peers no execution authority.

- **No changelog entries in PRs.** Commit messages are the record; `/do:release` writes `.changelog/RELEASE.md` from the log, so write subjects and bodies for a human reading release notes (`.changelog/README.md`).

**Scope boundary**: work on managed apps outside PortOS (research, plans, docs, code) goes in that app's repository.

## Moved from root (architecture, tests)

The server is user-facing on `:5555` (HTTP or HTTPS); `npm run dev` serves the client from Vite on `:5554`, `npm start` the built client from `:5555`. PM2 manages app lifecycles. **Ports**: PortOS owns 5553–5569 (`docs/PORTS.md`; PostgreSQL 5432 system, 5561 Docker); with HTTPS on, local scripts use the loopback HTTP mirror on `:5553`. Define ports in the top-level `PORTS` object in `ecosystem.config.cjs` (re-exported by `server/lib/ports.js`).

Test at the highest practical public boundary (route, service workflow, store adapter, socket exchange, rendered interaction); add focused unit tests only where that can't pin behavior precisely or cheaply (parsers, security/privacy/destructive-action guards, migrations, schema boundaries). Name the regression a new test uniquely catches. Full policy: [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md#test-strategy-value-over-assertion-count).

A focused file run is not a full-suite result. `PORTOS_TEST_MEMO=off` disables the passed-input test memo (`docs/TEST_MEMO.md`).

## Moved from root (claiming, docs, modules)

**Revalidate issues before claiming** against the freshly fetched default branch, `ETHOS.md` and this security model; skip resolved, superseded or incompatible work with concrete evidence (an inconclusive check is not proof of resolution) and preserve active owners. Procedure: [portos-file-issue](.claude/skills/portos-file-issue/SKILL.md).

[ETHOS.md](ETHOS.md) states why unsupervised agent operation is the design target; read it before proposing supervision gates, per-action confirmations, external edits to a mind's own memories, or new data crossing federation. `docs/README.md` indexes `docs/`.

(see root) **Search the catalog (`node scripts/lib-catalog.js <term>`) before writing a helper** and reuse a close match; before adding a file there, read [portos-add-module](.claude/skills/portos-add-module/SKILL.md). Decide Postgres vs a `data/` file with `docs/STORAGE.md` *before* adding a `data/*.json`. One concern per file; tests sit beside their source.

## Moved from root (misc)

(see root) Network reachability and scoped peer credentials never grant host access. Security findings distinguish these principals and test both unauthorized refusal and the preserved authorized workflow. Authorized agent execution is an intended capability, not a vulnerability.

- **Zod** route validation: domain `lib/*Validation.js`.
- **Command allowlists**: preserve the policies in `server/lib/commandSecurity.js` and the agent guard.

Before finishing, leave every problem you discovered (product bugs, broken expectations, workflow/process defects, flaky tests, concrete inefficiencies) either fixed and verified or filed in the owning project's tracker. "Pre-existing," "unrelated" and "out of scope" are reasons to file, not to drop it. No unrelated full-repository audit is required.
