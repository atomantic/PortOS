# Instruction-file rule detail

Root and nested `AGENTS.md` files carry a byte budget (`scripts/agent-instructions-files.guard.test.js`), so passages that are procedure or detail live here and the instruction file keeps the one-sentence rule. Each passage adds detail its instruction file leaves out, and the rule left there stays authoritative; a sentence already in the instruction file is not repeated here.

## Agent instruction files

**API-provider agents get these files too, within a budget**: `getAgentInstructionsContext()` in `server/services/promptSections/instructions.js` splices `~/.claude/CLAUDE.md`, the root file, then nested `AGENTS.md` files (depth 5 / 10 files; dot-dirs, `node_modules/`, `data/`, build output and nested repos skipped). The root file is the only guaranteed-first slot: rules guarding data loss, destructive actions, privacy or spend belong here. `scripts/agent-instructions-files.guard.test.js` caps root at 28 KB and each nested file at 12 KB; move task-specific procedure into a skill (`.claude/skills/`) or doc rather than raising them.

The 28 KB / 12 KB ceilings are the only absolute failure. A file already above 90% of its ceiling at the merge base (`CI_BASE_SHA`, else the merge-base with the remote default branch; a missing base fails closed) may not grow in the change, so two small edits merged separately cannot land over the cap while files can still shrink back toward the line.

Read the nested instructions before editing these trees (each an `AGENTS.md` with a bridge `CLAUDE.md`):

- `client/src/AGENTS.md`: UI, routing/deep-linking, API error/save gating, `Drawer`, collection loading
- `client/src/components/dashboard/AGENTS.md`: widget registration, grid/arrange, ⌘K layout wiring
- `server/AGENTS.md`: schema parity, write serialization, async boundaries, test peer fan-out, import scoping, generated manifests (incl. `scripts/generate-*.js`), prompt templates
- `server/lib/aiToolkit/AGENTS.md`: the override-consistency contract for the vendored provider/runner/prompt toolkit (no imports out to other PortOS modules)

## Federation between the user's own machines

Personal content alone is no reason to block federation ([ADR](decisions/2026-09-19-user-controlled-federation.md)), and Brain records (including tracked-topic threads) may travel the Brain sync channel. Keep the configured peer/category controls and each domain's wire contract. Status/capability endpoints keep bounded projections, never an export path.

## Logging levels

**Single-line logging** with emoji prefixes and interpolation; never log JSON blobs or arrays (`console.log(\`🚀 Server started on port ${PORT}\`)`). **stderr means "investigate"**: `console.error` (`❌`/`⛔`) and `console.warn` only for something actually wrong. Deliberate behavior stays on `console.log` with a non-failure marker: guard refusals and 4xx (`🚫`), skips and dedupes (`⏭️`), handled degraded states (iCloud eviction, peer on another schema, quota, reconnect/retry), slow-path telemetry (`🐢`). If it fires on a normal day it is not stderr. For a mixed status line pick the sink first (`const log = ok ? console.log : console.error;`); `server/logLevelConventions.guard.test.js` keeps failure markers off stdout.

## LLM response merging and sentinels

**LLM response merging** string gate: `null`/`undefined` is absent, `""` a clear (`universeBuilderExpand.trimField` returns `null` for non-strings). Array/object gate: `Array.isArray(parsed?.field)` / a non-null, non-array object.

**Sentinel** examples: `null` not fetched vs `[]` cached-empty (`ollamaManager.js` `installedModels`); a reachable backend whose list failed surfaces `modelsError`, not `0 models` (`getLastListError`).

## Error handling outside the request lifecycle

Outside the request lifecycle, a caught hook failure logs in the emoji `console.error` style. Async event handlers mutating shared module state (the TUI spawner's `handleData`) serialize on a per-session `Promise.resolve()` queue.

## Server conventions

The original, unabridged wording of rules whose one-sentence form now sits in `server/AGENTS.md`.

**Schema parity when adding fields.** A field added to a sanitizer, `createXxx` or payload shape gets its Zod schema in the same change (`lib/aiToolkit/validation.js` for toolkit shapes, the domain `lib/*Validation.js` file for routes), wired into POST and PUT (`schema.partial()`); an unwired sub-schema is false confidence. Polymorphic stores (`PUT /api/settings`) validate the present slice with `schema.partial()` (`backupConfigSchema.partial()` in `server/routes/settings.js`). Tolerate UI sentinels (`endpoint: ''`) with `z.preprocess(v => v === '' ? undefined : v, …)`; a service migrating legacy keys on read keeps accepting the legacy shape.

**Serialize a `json`/`jsonb` parameter with `toPgJson`, never bare `JSON.stringify`.** Postgres rejects a lone UTF-16 surrogate or NUL in `jsonb` (NUL in `text`), which old file stores accepted, so the write throws and the record is lost (#12815). `toPgJson` and `normalizePgString` in `server/lib/pgJson.js` repair to U+FFFD. `lib/db.js` normalizes plain parameters on every `query()`, but a pre-stringified JSON string looks like text to it. *Enforced:* `server/pgJsonConventions.guard.test.js` (frozen `scripts/db-migrations/` are skipped).

**Attach a spawned child's terminal listeners before the function next `await`s**: a failed spawn reports on `process.nextTick` and a fast child can exit while you're suspended, so an unlistened `error` crashes the process and an unlistened `close` strands the job `running`. Do awaited work before `spawn()`, or call `bufferChildExit(child)` (`services/videoGen/generateVideoHelpers.js`) in the same tick and replay its result (`services/imageGen/local.js`) (#11761). *Enforced:* `server/childListenerOrderConventions.guard.test.js`.

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
