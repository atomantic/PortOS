# Instruction-file rule detail

Root and nested `AGENTS.md` files carry a byte budget (`server/test/guards/repo/docsIntegrity.test.js`), so passages that are procedure or detail live here and the instruction file keeps the one-sentence rule. Each passage adds detail its instruction file leaves out, and the rule left there stays authoritative; a sentence already in the instruction file is not repeated here.

## Agent instruction files

**API-provider agents get these files too, within a budget**: `getAgentInstructionsContext()` in `server/services/promptSections/instructions.js` splices `~/.claude/CLAUDE.md`, the root file, then nested `AGENTS.md` files (depth 5 / 10 files; dot-dirs, `node_modules/`, `data/`, build output and nested repos skipped). The root file is the only guaranteed-first slot: rules guarding data loss, destructive actions, privacy or spend belong here. `server/test/guards/repo/docsIntegrity.test.js` caps root at 16 KiB and each nested file at 6 KiB; move task-specific procedure into a skill (`.claude/skills/`) or doc rather than raising them.

The 16 KiB / 6 KiB ceilings are the only absolute failure. A file already above 90% of its ceiling at the merge base (`CI_BASE_SHA`, else the merge-base with the remote default branch; a missing base fails closed) may not grow in the change, so two small edits merged separately cannot land over the cap while files can still shrink back toward the line.

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

[ETHOS.md](../ETHOS.md) also lists the commitments a change must not break. `docs/README.md` indexes ADRs (`docs/decisions/`). Start with `docs/STORAGE.md`, `docs/ARCHITECTURE.md` and `docs/API.md`.

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

**Pick the right Layout scroll mode** by where the `<Route>` sits in `App.jsx`, never by pathname: `PageLayout` pages (`PageHeader` over an internally scrolling body) go under `<FullWidthMain />`, document/form routes (`/apps/create`) under `<PaddedMain />` (`components/PageShell.jsx`).

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

## Server schema validation

- **A POST/PUT/PATCH handler reading `req.body` validates it with a schema** (`validateRequest(schema, req.body ?? {})`, schema in the route family's domain `server/lib/*Validation.js` file, which is the only home for a schema; a fragment two domains need lives in `sharedSchemas.js`), not a hand-rolled check. *Enforced:* `server/test/guards/runtime/routeValidationConventions.test.js` over `server/routes/`, `lib/aiToolkit/routes/` (schemas in `lib/aiToolkit/validation.js`) and `cos-runner/index.js` (`requestSchemas.js`). Its `ALLOWED_UNVALIDATED` list (raw-binary and multipart bodies) may only shrink; never add a JSON-body handler.

- **A handler reading `req.query` validates the whole query object** on any method (`validateRequest(schema, req.query)` or `validate` / `parseBody` / `safeParse` / `Schema.parse` on it or a name assigned from it; one field or `req.params` doesn't count, nor does `parsePagination`). Shared lenient shapes (pagination, flags) live in `lib/queryValidation.js`; the same test has no allowlist for query reads.

## Import scoping

Every suite reaching a module instantiates its whole closure. `server/lib/importScoping.test.js` holds the base-relative growth guard and the architectural boundary tests, with no per-edge rows to update when you narrow or move a module; measure fan-out with `node scripts/lib/importReach.js <repo-relative source>`.

- **Don't drag a subtree in for one constant.** Import from the declaring module (`CHECK_SCOPES` from `server/lib/editorial/checkInfra/taxonomy.js`, not the `checkRegistry.js` barrel), and `await import()` a dependency only a boot/rare path needs (`ensureSchemaImpl()` composes DDL that way).

- **A lazy `import()` cuts instantiation, not CI selection**: `vitest related` follows dynamic imports too (#12285). To cut selection, move the needed piece into a leaf both sides import (`services/readinessSignal.js`), have the heavy service register a callback at boot (`initAutoFixer()` → `services/provider/providerRecoveryHooks.js`), or load it by name with `loadLateBoundService` (`lib/lateBoundServices.js`, loaders in `services/serviceLoaders.js`; a suite that runs the call registers its own loader). Cut edges are pinned in `SELECTION_CUTS`; a suite that `vi.mock`ed the heavy module registers test doubles instead.

- **Outside an async scope, defer with `import('./x.js').then(…).catch(handler)`** (how `services/promptRunner.js` defers `tuiPromptRunner.js`), ideally inside an existing predicate gate (`runner.js` defers `ollamaAgentContext.js` in the `isOllamaBackedProvider` ternary).

- **Never narrow an import around a barrel a suite mocks**: `vi.mock('./cos.js')` intercepts the specifier, so re-pointing a caller at `./cosTaskStore.js` silently bypasses the double. Grep for `vi.mock` of the module first; a lazy `await import()` has no such hazard.

## Generated manifests

- **Derive at first use before committing a manifest.** Deterministic, cheap, shipped-input inventories are computed in memory behind a per-process cache (`server/lib/apiRouteGraph.js`, `socketEventInventory.js`). Commit one only when derivation is slow, nondeterministic or needs inputs an install lacks (`promptStageCallSites.generated.json`).

- **A checked-in manifest is addressed by content, never position**: key each record by declaring file plus semantic identity, never `foo.js:412` (churns and conflicts on unrelated edits). Positional detail may stay in memory (`routeDeclarationKey` in `server/lib/apiRouteGraph.js`).

- **Prove it with `shiftSourceText`** (`scripts/lib/positionInvariance.js`): shift the inputs, regenerate, require byte-identical output. `server/test/guards/repo/generatedManifests.test.js` backstops the tree by scanning tracked `*.generated.json` for position-shaped keys and failing when a `scripts/*.js` writing one has no sibling test importing `positionInvariance.js`.

## Prompt and migration maintenance

- **A prompt template edit needs no migration.** After changing a `data.reference/prompts/{stages,_partials,skills}/*.md` body, run `node scripts/regen-shipped-prompt-hashes.js`: it retires the outgoing hash into `data.reference/prompts/shipped-hashes.json`, and `reconcileShippedPrompts` (`scripts/migrations/shippedPromptHashes.js`, run after every migration pass) upgrades installed copies on a retired hash and leaves customized ones alone. `server/test/guards/repo/shippedPromptHashes.test.js` fails on a missed regen, a dropped hash or a new `makePromptReplaceMigration`; never re-point the few prompt-hash migrations left. `makeSeedMigration` only copies missing files.

- **Ship media-model catalog changes through the loader.** Add new image or video entries in `server/lib/mediaModels/catalogDefaults.js`. Update an existing entry through `VIDEO_REGISTRY_UPGRADES` or the image backfill chain, matching the old shipped values to preserve customizations. Neither change needs a migration. See the [distribution rules](#distribution-model-detail).

- **A migration's number orders it; its filename identifies it.** Pick an unused number after its dependencies. The applied-list keys on filenames, so historical collisions stay intact. Renaming or deleting a shipped migration can re-run or drop it on installs, so `server/test/guards/repo/migrations.test.js` fails on it. Retire via its reviewed `RETIRED_MIGRATIONS` list.

- **Add model IDs to the shipped provider catalog.** Additive changes in `data.reference/providers.json` reach installed presets at startup after migrations, honoring `removedModels` and explicit preset narrowing. Keep the aiToolkit sample catalog in sync. A model rename, retirement, or default change needs its own compatibility decision.

- **A new migration is a frozen snapshot of its transform**: it imports `_lib.js` primitives, `server/lib` pure helpers or a frozen copy, never `server/services`; declares no local copy of a `_lib.js` helper; and writes any `purge: true` marker as a top-level property of the default export. Additive DDL needs no migration (`ensureSchema`); log-only stubs fail. *Enforced:* `server/test/guards/repo/migrations.test.js`.

- **Prompt-default changes: edit the body, then run `node scripts/regen-prompt-integrity-snapshot.js`**. The snapshot (`services/taskPromptDefaults/integrity.snapshot.json`) owns the version numbers (`versions.js` re-exports them), so the regen bumps the version and retires the old hash so other installs upgrade stored defaults (`promptMatchesShippedDefault`); never hand-edit one. After a snapshot rebase conflict, take the base side and rerun it. Retired bodies live only in git history; never paste one back as recognition data (the literal in `taskPromptDefaults/retiredPromptFixtures.js` is a test fixture). No migration is needed: `readSchedule()` in `services/taskScheduleStore.js` upgrades uncustomized stored prompts (`data/cos/task-schedule.json`) on next load, and `server/test/guards/repo/migrations.test.js` fails on a new prompt-bump migration.

- **Creative prompts get the IP-latitude clause by classification, not by wrapping call sites.** Classify a new creative stage in `server/lib/creativeLatitude.js` (its header lists the two chokepoints, the token reserve and the shown-never-hidden contract, #11317); `creativeLatitude.test.js` and `server/test/guards/modules/creativeLatitude.sources.test.js` fail on unclassified entries.

## Client component maintenance

- **A shared primitive baking in `inline-flex` yields to the caller's display utility** (Tailwind v4 sorts `.inline-flex` after `.hidden`, so it wins). `Pill` does (`OWN_DISPLAY` in `components/ui/Pill.jsx`); `InfoTooltip`, `CopyableId` and `ProvenanceChip` need the fix at their first `hidden md:` call site.

- **Chrome floating over media uses `.port-media-overlay`** (`-strong`, `-item`, `-divider`; see `index.css`, including when to use `.always-dark`). Never `bg-black/NN` + `text-white`/`text-gray-N00`: day mode darkens the text on the scrim. Older overlays still do (#3796); don't copy the neighbor.

- **Alphabetical navigation**: sidebar items in `SidebarNav.jsx` (driven by `navPresentation.js`) are alphabetical after the top single-row section (Dashboard, Review Hub, Eidoverse) and its separator, with Goals placed alphabetically between sections; children in collapsible sections are alphabetical too.

- **"Run Now" gates on saved state, not the form.** A button that triggers server work reading server-side settings stays disabled while the form is dirty or saving: track a `saved*` value per dependent setting, updated on successful save. A tooltip warning is not enough.

- **In-flight saves gate dependent actions too.** While an async PATCH of a field is pending, disable buttons that read it: set a `<field>Saving` flag before the PATCH, clear it in `.finally()` (`lengthProfileSaving` in `client/src/pages/PipelineIssue.jsx`).

## Dashboard layout maintenance

Widgets are registered in `widgetRegistry.jsx` (`{ id, label, Component, width, defaultH?, needs?, gate? }`). The Dashboard renders the active layout's widgets from it. Named layouts persist in `data/dashboard-layouts.json` (owned by `server/services/dashboardLayouts.js`, `GET/PUT/DELETE /api/dashboard/layouts`); the built-ins (`default`, `focus`, `morning-review`, `ops`, `deep-work`, `health`, `agent-watch`) are seeded on first read and can't be deleted. The `⌘K` palette synthesizes a `Dashboard: <name>` command per layout when it opens, so new layouts need no registration.

**Grid model.** A layout's `grid: [{ id, x, w, order, h?, fixedH? }]` places cells on 12 columns (`x`/`w`) plus a packing sequence (`order`). There is no stored row (#4133): `packVertically` lays cells out in pixels, each floating up under the nearest placed cell sharing a column, in `order`. An empty `grid` auto-flows via `synthesizeGrid` from each widget's `width` and `defaultH`. Below 640px container width the grid becomes one column in reading order (`order`, then `x`), never array order. `sanitizeGridItem`/`sequenceGrid` in `server/services/dashboardLayouts.js` still derive `order` from a legacy `y` on read, and `scripts/migrations/269-dashboard-grid-order.js` rewrites old files. **A new widget-seeding migration appends `{ id, x, w, order, h }`, not `{ x, y, w, h }`** (seed migrations before 269 still use `y` because they only run on pre-269 files).

**Height is measured, not declared.** A cell measures its widget with a `ResizeObserver`. `h` is only the first-paint fallback and what older clients (which don't know `fixedH`) read, so every drag commit refreshes it via `withMeasuredHeights`. A cell whose height the user dragged has `fixedH: true`, keeps `h` exactly and clips; the ⌃⌄ handle (edit mode, pinned cells) returns it to content height. `defaultH` is a first-paint ballpark (default `4`).

- **Handles are keyboard gestures too (#7263)**: Enter/Space lifts, arrows step, Enter/Space drops, Escape restores, matching the mobile sort handle. Pointer and keyboard share one placement path (`beginGesture`, `stepGhost`, `finishGesture`/`applyGhost`, the same `fixedH` rule), so a keyboard preview is the commit. The one divergence is deliberate: a horizontal keyboard move leaves `order` alone so ↑/↓ alone owns the sequence. The grid's `role="status"` region narrates keyboard steps and `aria-pressed` carries grabbed/idle. **A handle with `onPointerDown` and no `onKeyDown` is a WCAG 2.1.1 failure**; `DashboardGrid.test.jsx` fails on one.

**Widget order lives in the grid.** `saveGridEdit` rewrites `widgets` into `readingOrderIds(grid)`. `reconcileGrid` iterates the grid and uses `widgets` only for membership, so toggles and renames keep positions. LayoutEditor's Move up/down passes an explicit `reordered` flag from `save`/`commitDuplicate`, computed by `isReordered()` against the `unmovedOrder` ref (`add` appends to it, `remove` filters it, `move` leaves it), and `Dashboard.jsx` forwards it as `reconcileGrid(base, widgets, { reorder })`. **Never infer the flag by comparing `widgets` to `readingOrderIds(grid)`**: older layouts can disagree, and inferring would re-pack an arranged layout on an unrelated save (#4132).

## AI Toolkit host integration

### Exports and provider configuration

- `index.js` exports `createAIToolkit`, `createProviderStatusService`, the four Router factories (providers / runs / prompts / providerStatus), and `knownContextWindow` / `contextWindowRejection`. The host applies the latter pair to the explicitly requested provider, which `getFallbackProvider` never sees. Both return `null` for an unknown window, which callers read as "no constraint"; nothing infers a window from a model id.
- **The Ollama `num_ctx` ceiling is declared once**, as `clampToRuntimeContextWindow` in `internal/ollamaBacked.js`. `knownContextWindow` applies it through that helper; never restate the `Math.min` inline (#7466). It is an upper bound over every planning rung, a user's explicit `contextWindow` included, and the answer when nothing else declared one. Host callers (the stage budgeter in `server/services/stageRunner.js`, the untrusted-content guard in `server/services/untrustedContent.js`, the browser's provider meter) import the `internal/` leaf or `providerStatus.js` directly, which keeps them off the public barrel's `fs`/`child_process` closure.
- **A ceiling rung this directory can't resolve arrives as data, never as an import out.** The host resolves the ambient `OLLAMA_CONTEXT_LENGTH` (`server/lib/ollamaContext.js`) and stamps it on an in-memory provider projection with `withRuntimeContextWindow`, declared beside the clamp. `runtimeContextWindow` ranks below `provider.numCtx` and is never persisted. A new host-resolved rung follows the same shape (#7472).
- **An Ollama API run with a `numCtx` streams from native `/api/chat`** (`internal/ollamaNativeChat.js`), because `/v1/chat/completions` ignores `num_ctx` and silently truncates to the daemon default. Native NDJSON is reshaped into the OpenAI chunk the runner reads, so cancellation, stall bounds, reasoning salvage and finalization stay shared. Runs without `numCtx` and non-Ollama endpoints stay on `/v1`.
- Provider configuration (models, tiers, fallbacks) is persisted and migrated by `internal/providerServiceState.js`; the facade is `providers.js`. `loadProviders()` migrates legacy codex configs to the `codex-configured-default` sentinel, and `server/index.js` warms it at startup.
- PortOS extends the toolkit routes in `server/routes/providers.js` (vision testing, provider status, which needs host socket helpers).
- New provider fields (e.g. `fallbackProvider`, `lightModel`) go into `buildProviderRecord()` (an explicit field list) in `internal/providerServiceState.js` and the matching validation schema. `updateProvider()` spreads, so existing records keep custom fields.
- **Refresh several providers with `refreshProviderModelsBatch(ids)`, never a loop over `refreshProviderModels(id)`**, which rewrites all of `providers.json` per call. The batch groups by `ollamaRefreshGroupKey` (one probe per daemon and probe shape), applies every result and saves exactly once, and reports per-group `status` (`updated` / `failed` / `missing`) instead of throwing. Example: `syncLocalProviderModels` in `server/services/localLlm.js`.

### Model access policy

`internal/modelAccess.js` decides which of an upstream's advertised catalog an install may run (a `/models` response can't say; NVIDIA NIM lists its whole product line). It scopes on read, never at refresh. Contract: `docs/MODEL_ACCESS.md`.

- **The stored catalog is never narrowed.** `applyModelAccess` runs at the route (`routes/providers.js` here, `presentProvider` in the host), so a cleared policy restores the list with no re-probe. The scoped payload carries the original as `modelCatalog`, and **the provider editor seeds its model textarea from it**, since it saves that box verbatim.
- **`all` and an empty pattern list both mean no constraint.** A stored `{ mode: 'all', patterns: [...] }` is a parked list and keeps its patterns.
- **A model the record names is never hidden** (`defaultModel`, the four tiers, `fallbackModel`), or its picker renders blank and the next save re-points the provider.
- A gateway-backed wrapper with no policy inherits the sibling gateway's, resolved on read into the derived `modelAccessEffective` / `modelAccessSource` fields (never the persisted `modelAccess`, which a GET-then-PUT would otherwise pin). Composition order with `withGatewayApiKey` matters: it attaches the key non-enumerably, so a later spread drops it. Write responses carry the resolution forward with `withResolvedModelAccess` rather than re-reading.
- Glob matching is a hand-rolled iterative matcher, not a translated RegExp: patterns are user input and `*a*a*a*b` would backtrack exponentially.

### Host extension points

- **`onProvidersSaved(data)`** (`createProviderService` / `createAIToolkit`) runs after every successful `providers.json` write. PortOS uses it in `server/services/bootstrap.js` to reconcile its provider graph (`server/services/provider/providerGraph.js`, #6367). It is non-fatal: a throwing hook is logged and swallowed. **`applyProviderPatches(patches)`** updates several named records in one write with no sibling fan-out.
- **`withRunAdmission(handler)`** wraps the manual create-run route and owns the whole async handler lifetime, including preparation after an HTTP disconnect; don't release it on response close. API execution also takes `onPersistenceFailure` and `onSettled`; `onSettled` fires after both stream cleanup and terminal persistence/hooks, independent of `onComplete` (which can precede transport settlement on timeout).
- **`setCliRunner(fn)` / `setTuiRunner(fn)`** register host runners (`null` reverts); `server/index.js` sets both. The CLI runner is stdin-based and knows per-CLI argv (Codex `exec -`, Antigravity `agy --print`, Claude Code `-p -`). `setTuiRunner` attaches/detaches `executeTuiRun` so the runs router's `typeof runnerService.executeTuiRun === 'function'` gate stays honest.
- **A host runner that spawns its own process must `registerExternalRun(runId, killable)`** (and `unregisterExternalRun` / `hasExternalRun`), as `services/runner.js` does. `stopRun`, `isRunActive` and `deleteRun` consult this registry first; skipping it reports live runs inactive, refuses Stop and leaks processes. New lifecycle methods (e.g. `pauseRun`) consult it too.
- **Cancellation is not failure.** `stopRun` stamps a one-shot marker read by `consumeExternalRunStop(runId)`, and runs surface `canceled: true` and `code: 'RUN_CANCELED'`. **Anything that turns an LLM failure into a verdict** (a pause kind, a gap/investigation task, a bench, an `error` status) **calls `isRunCanceledError` from `errorDetection.js` first.** `executeApiRun` keeps its own marker (an `AbortController` abort reaches the finalizer as a bare `AbortError`), writes the same `canceled` / `completionReason` shape, and fires `hooks.onRunCanceled?.({ runId })` instead of `onRunFailed`. A timeout outranks a cancel.
- **`createProviderStatusService({ prerequisitesMet })`** gates whether a provider can run at all (its CLI binary present); `getFallbackProvider` checks it for every candidate. PortOS supplies `prerequisitesMetForRouting` from `services/provider/providerPrerequisites.js`. It must be synchronous, and a missing, throwing or non-boolean answer reads as "yes", because emptying the fallback chain is worse than a late ENOENT.
- **Time-based state needs read-side mirrors.** `providerStatus.init()` clears expired `estimatedRecovery` entries, and every reader (`getStatus`, `getAllStatuses`, `isAvailable`) re-applies the recovery check, or providers stay unavailable until restart.
