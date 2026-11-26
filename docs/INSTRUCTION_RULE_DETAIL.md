# Instruction-file rule detail

Root and nested `AGENTS.md` files carry a byte budget (`server/test/guards/repo/docsIntegrity.test.js`), so passages that are procedure or detail live here and the instruction file keeps the one-sentence rule. Each passage adds detail its instruction file leaves out, and the rule left there stays authoritative; a sentence already in the instruction file is not repeated here.

## Agent instruction files

**API-provider agents get these files too, within a budget**: `getAgentInstructionsContext()` in `server/services/promptSections/instructions.js` splices `~/.claude/CLAUDE.md`, the root file, then nested `AGENTS.md` files (depth 5 / 10 files; dot-dirs, `node_modules/`, `data/`, build output and nested repos skipped). The root file is the only guaranteed-first slot: rules guarding data loss, destructive actions, privacy or spend belong here. `server/test/guards/repo/docsIntegrity.test.js` caps root at 28 KB and each nested file at 12 KB; move task-specific procedure into a skill (`.claude/skills/`) or doc rather than raising them.

The 28 KB / 12 KB ceilings are the only absolute failure. A file already above 90% of its ceiling at the merge base (`CI_BASE_SHA`, else the merge-base with the remote default branch; a missing base fails closed) may not grow in the change, so two small edits merged separately cannot land over the cap while files can still shrink back toward the line.

Read the nested instructions before editing these trees (each an `AGENTS.md` with a bridge `CLAUDE.md`):

- `client/src/AGENTS.md`: UI, routing/deep-linking, API error/save gating, `Drawer`, collection loading
- `client/src/components/dashboard/AGENTS.md`: widget registration, grid/arrange, ⌘K layout wiring
- `server/AGENTS.md`: schema parity, write serialization, async boundaries, test peer fan-out, import scoping, generated manifests (incl. `scripts/generate-*.js`), prompt templates
- `server/lib/aiToolkit/AGENTS.md`: the override-consistency contract for the vendored provider/runner/prompt toolkit (no imports out to other PortOS modules)

## Federation between the user's own machines

The Privacy Center, message mirrors and provider configuration require a scoped change before they gain sync. Non-self peers, guests, public worlds and external services follow their own audience controls (see the [ADRs](decisions/)).

Personal content alone is no reason to block federation ([ADR](decisions/2026-09-19-user-controlled-federation.md)), and Brain records (including tracked-topic threads) may travel the Brain sync channel. Keep the configured peer/category controls and each domain's wire contract. Status/capability endpoints keep bounded projections, never an export path.

## Logging levels

**Single-line logging** with emoji prefixes and interpolation; never log JSON blobs or arrays (`console.log(\`🚀 Server started on port ${PORT}\`)`). **stderr means "investigate"**: `console.error` (`❌`/`⛔`) and `console.warn` only for something actually wrong. Deliberate behavior stays on `console.log` with a non-failure marker: guard refusals and 4xx (`🚫`), skips and dedupes (`⏭️`), handled degraded states (iCloud eviction, peer on another schema, quota, reconnect/retry), slow-path telemetry (`🐢`). If it fires on a normal day it is not stderr. For a mixed status line pick the sink first (`const log = ok ? console.log : console.error;`); `server/test/guards/runtime/logLevelConventions.test.js` keeps failure markers off stdout.

## LLM response merging and sentinels

**LLM response merging** string gate: `null`/`undefined` is absent, `""` a clear (`universeBuilderExpand.trimField` returns `null` for non-strings). Array/object gate: `Array.isArray(parsed?.field)` / a non-null, non-array object.

**Sentinel** examples: `null` not fetched vs `[]` cached-empty (`ollamaManager.js` `installedModels`); a reachable backend whose list failed surfaces `modelsError`, not `0 models` (`getLastListError`).

## Error handling outside the request lifecycle

Outside the request lifecycle, a caught hook failure logs in the emoji `console.error` style. Async event handlers mutating shared module state (the TUI spawner's `handleData`) serialize on a per-session `Promise.resolve()` queue.

## Server conventions

Implementation detail for rules in `server/AGENTS.md`.

**Schema parity when adding fields.** A field added to a sanitizer, `createXxx` or payload shape gets its Zod schema in the same change (`lib/aiToolkit/validation.js` for toolkit shapes, the domain `lib/*Validation.js` file for routes), wired into POST and PUT (`schema.partial()`); an unwired sub-schema is false confidence. Polymorphic stores (`PUT /api/settings`) validate the present slice with `schema.partial()` (`backupConfigSchema.partial()` in `server/routes/settings.js`). Tolerate UI sentinels (`endpoint: ''`) with `z.preprocess(v => v === '' ? undefined : v, …)`; a service migrating legacy keys on read keeps accepting the legacy shape.

**Serialize a `json`/`jsonb` parameter with `toPgJson`, never bare `JSON.stringify`.** Postgres rejects a lone UTF-16 surrogate or NUL in `jsonb` (NUL in `text`), which old file stores accepted, so the write throws and the record is lost (#12815). `toPgJson` and `normalizePgString` in `server/lib/pgJson.js` repair to U+FFFD. `lib/db.js` normalizes plain parameters on every `query()`, but a pre-stringified JSON string looks like text to it. *Enforced:* `server/test/guards/runtime/pgJsonConventions.test.js` (frozen `scripts/db-migrations/` are skipped).

**Attach a spawned child's terminal listeners before the function next `await`s**: a failed spawn reports on `process.nextTick` and a fast child can exit while you're suspended, so an unlistened `error` crashes the process and an unlistened `close` strands the job `running`. Do awaited work before `spawn()`, or call `bufferChildExit(child)` (`services/videoGen/generateVideoHelpers.js`) in the same tick and replay its result (`services/imageGen/local.js`) (#11761). *Enforced:* `server/test/guards/runtime/childListenerOrderConventions.test.js`.

Record writes reach peer sync only through the subscription adapter in `server/services/sharing/recordEvents.js` (a no-op until `peerSync.js` registers). A suite loading the peer-sync graph (`peerSync.js` or `sharing/index.js`, even transitively) mocks `services/instances.js` with `mockNoPeers()` and `services/sharing/peerSync.js` with `mockNoPeerSync()` from `server/lib/mockPathsDataRoot.js`. To assert auto-subscribe in a domain test, register a double with `registerSubscriptionAdapter({...})` and reset with `__resetSubscriptionAdapter()`.

**The tree-wide guard is base-relative growth** (`scripts/lib/importGrowth.js`): summed closure growth of suites existing on both sides, against the merge base (`CI_BASE_SHA`), stays under `EXISTING_SUITE_GROWTH_LIMIT` (2,500); new test files don't spend it, and a missing base fails. On failure, narrow or defer the import. Raising the limit is the intentional-regression path: same change, name the module that can't be deferred, stay under the pin test's band. Pregate's selected `release` refs are exempt from this limit only.

## Slashdo read resolution

A `!read lib/<name>.md` in a nested file or a `~/.claude/lib/` reference resolves against the bundled package root; in a staged CoS bundle it resolves against the containing file. Read each phase's file only when that phase applies, and don't rely on a global install.

## Testing

Pregate skips imports past two hops and omits boot-smoke suites. Its `--full` DB plan targets `portos_test`. It also links worktree dependencies. The `dependency-updates` task is the exception to shared dependencies: its worktree has no dependency symlinks and installs locally.

Parsers, security/privacy/destructive-action guards, migrations and schema boundaries are unit-test territory when a public-boundary test cannot pin their behavior precisely or cheaply. Name the regression a new test uniquely catches.

`server/vitest.config.js` forces `NODE_ENV=test` so a suite never inherits PM2's `development` environment and aims at the real Postgres. What pregate runs, and its Windows and interrupt behavior: [PREGATE.md](PREGATE.md). The full test policy, including retry, timeout and process-lifecycle state machines as unit-test territory: [CONTRIBUTING.md](CONTRIBUTING.md#test-strategy-value-over-assertion-count).

## Findings and review scope

Retiring a rule requires assessing feasibility as well as value. Difficulty alone does not justify retirement. Never demote a rule to obtain a passing check. A bounded audit may track accepted work that remains. Investigate headless Linux CI failures. The review does not require a separate full-repository audit.

Review scope stays tied to the requested change and affected contracts; subjective preferences are not defects. The ephemeral-state rule also covers branches, agent completion state and state-preservation findings, and never justifies a two-step review endpoint.

## Filing and routing issues

The pinned `GH_TOKEN` uses the repository's configured or owner-matched account (`atomantic` for the owner's local agents, `picodot` for Pico-delegated work). Do not use a provider-bundled GitHub connector to reach another identity. The pin also applies to tracker comments. State whether a flake is suspected or reproduced. An inconclusive current-need check does not establish that an issue is resolved.

Cross-link an issue in slashdo and PortOS only when both need changes.

## Provider calls and model input

The cold-bootstrap reference implementation is `initDrillCache` (boot, disk only) and `requestCacheFill` (user-triggered fill) in `server/services/meatspace/meatspacePostDrillCache.js`.

Static additions shown as chips beside the user's own words include universe/project style, production bible, mood-board style, shot actions, preset negatives, the agent wrapper and policy clauses.

## Security exemptions

The CivitAI decision (#2200) covers host allowlisting and redirect stripping for the free key used by `applyDownloadToken` (`server/services/loras.js`). Quota-billed keys are outside this exemption.

## Realtime updates

When a view would need a timer to stay fresh, add the missing server event rather than polling.

## Code comments

Also remove walkthroughs; keep meaningful type/JSDoc and public API docs. There is no comment quota in either direction.

## Documentation

Read [ETHOS.md](../ETHOS.md) before proposing external edits to a mind’s own memories. Write commit subjects and bodies for people reading the release notes.

[ETHOS.md](../ETHOS.md) also lists the commitments a change must not break. `docs/README.md` indexes ADRs (`docs/decisions/`) and plans (`docs/plans/`, conventions in `docs/plans/README.md`); start with `docs/STORAGE.md`, `docs/ARCHITECTURE.md` and `docs/API.md`.

## Keyboard ownership and web storage

Drills, keyers and transports are examples of Space-owning surfaces. Global key handlers stand down for native button activation through one predicate, `shouldIgnoreGlobalKey(event, opts)` in `lib/a11yKeyboard.js`; add guards there, never at one caller (#4748). A key-owning surface spreads `noPointerFocusSurfaceProps` on its root so a click focusing an inner button doesn't take the key over.

**Web Storage goes through `lib/safeStorage.js`** (`safeReadStorage` / `safeWriteStorage` / `safeRemoveStorage` and their `Json`/`*Session` variants). Raw `localStorage`/`sessionStorage` throws in Safari private mode, sandboxed iframes, disabled cookies and at quota (`typeof`/`?.` don't guard it), unmounting the route (#5689). *Enforced:* `client/lint-no-raw-web-storage.grit` (Biome plugin; exemptions are negated globs on its override in `client/biome.jsonc`).

## Client rules

Implementation detail for rules in `client/src/AGENTS.md`.

Use existing setup and check controls, preserving the user’s work. For prerequisites that need setup outside the app, give concrete steps and a retry. Keep existing authority checks. For a prerequisite involving a linked record, lock or approval, link to the exact place where it can be resolved. Keep that destination reachable for stale and already-approved records.

**Mobile responsive, always.** A `grid-cols-N` with N > 3 and no `…:grid-cols-*` in the same class string is a bug: give text-bearing cards a phone default and widen by breakpoint (`grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4`); a wider gap is not a column breakpoint. Square thumbnail/heatmap grids may stay 4+ on a phone but still need a breakpoint. *Enforced:* `client/src/test/guards/ui/tailwindClassConventions.test.js`.

**List deletion preserves place** ([contract](UX_DESIGN_GUIDE.md#list-deletion-and-reading-position)): after the server confirms, collapse the row with `components/ui/CollapsibleListItem` (spacing inside the wrapper), then remove it from local state. Keep the list, scroll container, filters and pagination mounted, never swap in a loading placeholder, keep failures visible, guard duplicates, honor reduced motion, and move focus to a surviving row with `preventScroll`.

**Every selectable record is deep-linkable**: an opened project, item, scene, editor or master-detail selection is a route param (`/music-video/:projectId`), never `useState`/`selectedId`. Selection `navigate()`s to the id route, delete/clear `navigate()`s back to the index, and stale ids render a not-found fallback. Register both the index and `:id` routes in `App.jsx`, and the base path in `NAV_COMMANDS`.

Every potentially growing list follows [the collection-loading contract](UX_DESIGN_GUIDE.md#large-collections-and-incremental-loading): bounded server pages, active-route data only, details on demand, `usePagedCollection` + `InfiniteScrollFooter` for new infinite lists, socket invalidation instead of whole-list polls, and query-wide search/counts (never only loaded rows). Client-side slicing of an unbounded response is not pagination.

Settings-over-a-feature surfaces use the shared `client/src/components/Drawer.jsx`, never a hand-rolled `fixed inset-y-0 right-0` clone. **All mutable form state lives in the parent** (per-tab scroll remounts the body), the overlay is always portaled to `<body>` (any new hand-rolled `fixed inset-0` overlay too, #4150), and a deep-linkable tab uses `useDrawerTab`. Sizes, tabs, Esc/backdrop and examples: [the drawer contract](UX_DESIGN_GUIDE.md#config-drawers).

**Size form fields for their content.** Short selects and numeric inputs share rows when there is room and stack when narrow; prefer bounded wrapping grids (`grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),24rem))]`) over full-width controls. Keep labels and help with their fields, preserve tab order, give prose editors and long paths room, no global input width limits.

**Never `autoFocus` a control that appears in response to a key-submit**: the still-down Enter activates it the moment it mounts. Keep the submitting element focused (`readOnly`, not `disabled`) and filter `e.repeat` (`MorseTrainer.jsx`), or handle Enter-to-advance in a window handler gated on `shouldIgnoreGlobalKey` with the button unfocused (`PostDrillRunner.jsx`).

**A sanctioned poll uses `useAutoRefetch(fetchFn, intervalMs, { enabled, pollOnly: true })`** (`hooks/useAutoRefetch.js`), never a hand-rolled `setInterval`; it pauses in hidden tabs (#5697). Pass the gate as `enabled`, not an early `return`, and `immediate: false` when another effect owns the first fetch. *Enforced:* `client/lint-no-view-interval.grit`.

**Pick the right Layout scroll mode** by where the `<Route>` sits in `App.jsx`, never by pathname: `PageLayout` pages (`PageHeader` over an internally scrolling body) go under `<FullWidthMain />`, document/form routes (`/apps/create`) under `<PaddedMain />` (`components/PageShell.jsx`). Exceptions: `docs/research/PAGE_LAYOUT_AUDIT.md`.

## Authentication and HTTPS detail

Paired peers use scoped pair credentials attached by `peerFetch` (`server/lib/peerHttpClient.js`). Legacy Basic uses the instance password and is unscoped ([peer push auth](PEER_PUSH_AUTH.md)).

`server/services/agent/agentApiAuth.js` injects the loopback agent session token. For agents outside PortOS, the API helper falls back to the opt-in key in `~/.portos/agent-key.json` when the session token is absent.

Peer hops set `rejectUnauthorized: false` because WireGuard authenticates tailnet nodes. A non-tailnet peer (plain LAN IP or non-`.ts.net` host, see `peerRequiresTailscale()`) gets no server authentication.

## Security posture detail

Genuine local callers keep host access when auth is disabled. A Basic password holder can already exchange it for a session, so refusing Basic controls credential use. Trace the real authorization path when reviewing a finding, including fallback and deferred work. Anonymous remote callers cannot launch a configured tool-capable provider.

The [risk assessment](SECURITY_RISK_ASSESSMENT.md) distinguishes owner-input reliability and conditional exposure from unauthorized harm. Reuse the existing abuse guard only on paths it covers and record dispositions with reevaluation conditions.

Local execution does not sanitize external content or dependencies. Untrusted content cannot expand a grant, pick a new audience, change policy or gain host authority. Keep revision and evidence checks, budgets, explicit publication controls, provider permissions, quotas and purchase authorization. The `portos-music-video-*` skills cover delegated review.

Preserve the command allowlists in `server/lib/commandSecurity.js` and the agent guard. Password-free installs warn after upgrade until the operator accepts the risk or sets a password.

## Distribution model detail

The [root distribution rules](../AGENTS.md#security-model) govern migrations, cross-version sync and fork updates.

- Each install records applied migrations in `data/migrations.applied.json`.
- `setup-data.js` copies missing seeds first, so a seeded derived output looks “already done” (`scripts/migrations/340-cos-config-seed-repair.js`). Declare the path in the migration's `OWNED_OUTPUT_PATHS` as well as the central registry so the guard can match them.
- `server/AGENTS.md` “Prompt templates” gives the integrity snapshot procedure. `server/lib/schemaVersions.js` declares the cross-machine schema versions.
- Ship each new image or video model as one entry in `server/lib/mediaModels/catalogDefaults.js`. Change an existing entry in `VIDEO_REGISTRY_UPGRADES` or the image backfill chain, matching the previous shipped values to preserve customizations. Keep the pre-ledger video baseline frozen so the loader can append future models while respecting old deletions. Existing registry migrations remain in place. `server/test/guards/repo/migrations.test.js` rejects new ones.
- The 409 `FORK_DIVERGED` response tells the user to run the fork sync themselves. The upstream slug lives only in `server/lib/gitRemote.js`. The UI reads `remoteInfo.isUpstream` for “you are running PortOS” ([self-update](SELF_UPDATE.md)).

## Privacy detail

Additional fake values include `alice@example.com`, `Acme Corp` and `host-XXXX`. Use `<user-email>` and `<tailscale-ip>` in redacted logs. Port forwards and gateways are sensitive network details too. On Linux, `ip addr` is another in-session-only source.

If real data was committed, a follow-up redaction leaves the original in history. Use `~/…` or `<repo-root>/…` when a relative path is insufficient. Reference issue or PR numbers, SHAs and file paths in place of conversation links.

## AI provider policy detail

Unscheduled calls need a direct user action in the same request or an explicit consent/config step. The cache-fill consent prompt lets the user change or decline the provider and model. Replenishing an item the user consumed may run silently.

## Live Node inspector

- **Live Node inspector**: no dynamic `import()` from an inspector-evaluated callback ([safe cleanup](./TROUBLESHOOTING.md#dynamic-import-callback-missing-after-profiling)).

## Architecture

`npm start` serves the built client on `:5555`. PM2 manages app lifecycles. `server/lib/ports.js` re-exports the port registry from `ecosystem.config.cjs`.

**Storage backend.** `npm run setup:db` configures system PostgreSQL on `:5432` or Docker PostgreSQL on `:5561`. With the file-backend override unset, `server/services/memoryBackend.js` fails fast without a healthy database.
