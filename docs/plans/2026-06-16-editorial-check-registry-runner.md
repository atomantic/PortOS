# Plan — #1284 Editorial check registry + runner (backbone)

## Context

PortOS's series pipeline has editorial logic scattered across `manuscriptReview.js`,
`completenessPass.js`, `editorialAnalysis.js`, and `canonReadiness.js` with **no shared
way** to register a new "check," declare its scope, run it, and collect findings. Every
new editorial rule the roadmap wants (name similarity, scene balance, POV-without-arc,
info-dumping, …) currently has no home.

#1284 is the **backbone** of epic #1283: a single extensible **check registry + runner**
(mirroring `apiRegistry.js` / `navManifest.js` / `widgetRegistry.jsx`) that lets each
editorial rule — deterministic or LLM-driven — plug in, declare scope, emit findings into
the **existing `manuscriptReview` store**, be toggled/configured, and run inside
`seriesAutopilot`. The dedicated management **UI is a separate issue (#1285)** — this PR
makes findings land in the *existing* manuscript-review store/UI; it ships **no new React
page**. Two reference checks (1 deterministic, 1 LLM) prove both paths.

## Scope decisions (defaults — adjust at approval)

- **Backbone only, no new UI page.** Findings surface in the existing manuscript-review UI
  via the store. The Editorial Checks catalog/config/triage page is #1285.
- **Two reference checks:**
  - `naming.dissimilar-names` — **deterministic**, scope `series`, category `naming`.
    Flags character-name pairs that are too similar (shared first letter / same length /
    similar vowel skeleton) from canon characters. Configurable thresholds.
  - `prose.info-dumping` — **LLM**, scope `issue`, category `exposition`. Flags
    "as-you-know-Bob" exposition dumps in drafted prose via a new prompt stage.
- **`checkId` on findings.** Add an optional `checkId` field to the manuscript-review
  comment shape and fold it into the dedup key so findings group per-check and dismissals
  stay suppressed per-check. Additive + optional ⇒ backward-compatible with synced
  `manuscript-review.json` and with existing completeness findings (absent → `''`).

## Key reuse (verified)

- **Findings store:** `server/services/pipeline/manuscriptReview.js` —
  `seedReviewFromFindings(seriesId, findings, { runId, mode })` (serialized per-series write
  queue + `findingKey` dedup + dismiss-suppression), `getReview(seriesId)`,
  `sanitizeComment` (the shape), `findingKey` (`${issueNumber??''}|${anchorQuote}|${problem}`).
- **Registry + fail-fast guard pattern:** `server/lib/navManifest.js` (module-load loop that
  throws on missing fields / bad enum / dup id) and `server/lib/apiRegistry.js` (static array
  + resolver merging persisted state).
- **LLM call:** `runStagedLLM(stageName, vars, { providerOverride, modelOverride, returnsJson, source })`
  from `server/lib/stageRunner.js` (same path `completenessPass.js` uses). Provider/model
  resolved via `getActiveProvider()` + `resolveModel()`; supports local + API providers.
- **Manuscript assembly + ctx:** `collectManuscriptSections(seriesId)` + `sectionsCorpus(sections)`
  + `buildArcBaseContext` / `getSeriesCanon` from `server/services/pipeline/arcPlanner/context.js`
  & `completenessPass.js`. Canon characters via `getSeriesCanon(series)`.
- **SSE run-tracking:** `server/services/pipeline/manuscriptCompletenessRunner.js` +
  `server/lib/sseUtils.js` (`attachSseClient`, `broadcastSse`, run-record `Map`).
- **Routes:** `server/routes/pipeline/editorial.js` (Router, `asyncHandler`, `validateRequest`,
  `mapServiceError`, `seriesSvc.getSeries`), mounted under `/api/pipeline/` by
  `server/routes/pipeline/index.js`.
- **Autopilot loop:** `server/services/pipeline/seriesAutopilot.js` `runEditorial()` (~L539–594),
  `buildDryRunPlan()` (~L840–863), `providerOverrideOpts(record)`.
- **Settings:** `getSettings()` / `saveSettings()` from `server/services/settings.js`;
  per-check state under `settings.pipelineEditorialChecks.checks[id] = { enabled, config }`.
- **Stage propagation (no migration needed):** `scripts/setup-data.js` `JSON_MERGE_TARGETS`
  merges new `stages` entries from `data.reference/prompts/stage-config.json` into existing
  installs, and copies missing `.md` files. Migrations are only for *modifying* shipped
  prompts — a brand-new stage is fully covered by the existing merge/copy.

## New files

1. **`server/lib/editorial/checkRegistry.js`**
   - `EDITORIAL_CHECKS` array. Entry: `{ id, label, description, scope, kind, category,
     severityDefault, configSchema (Zod), gate?(ctx), run(ctx) }`.
   - Module-load fail-fast guards (mirror navManifest): missing required fields; `scope ∈
     {series,issue,scene,noun}`; `kind ∈ {deterministic,llm}`; duplicate id.
   - The two reference checks (deterministic `naming.dissimilar-names` computes inline;
     LLM `prose.info-dumping` calls `runStagedLLM('pipeline-editorial-info-dumping', …)`).
   - Helpers: `getCheck(id)`, `listChecks()`, `resolveCheckState(settings)` (registry
     defaults merged with persisted enabled/config, validated through each `configSchema`),
     `getEnabledChecks(settings, subsetIds?)`.
2. **`server/lib/editorial/index.js`** — barrel (`export * from './checkRegistry.js'`).
3. **`server/lib/editorial/README.md`** — catalog rows (Module Organization rule).
4. **`server/services/pipeline/editorial/checkRunner.js`**
   - `runEditorialChecks(seriesId, { checkIds?, providerOverride, modelOverride, signal, onProgress })`:
     build shared ctx once (`series, issues, universe canon, manuscript`), run each enabled
     check (deterministic inline; llm via stage), tag every finding with `checkId`, persist
     via `seedReviewFromFindings(seriesId, findings, { runId, mode: 'merge' })`. Returns
     `{ runId, findings, perCheck }`.
   - SSE run-tracking mirroring `manuscriptCompletenessRunner.js`: `startRun`,
     `attachSseClient`, `getStatus`, `cancelRun`; frames `start | check:start | check:complete
     | complete | error | canceled`.
   - `buildEditorialCheckPlan(seriesId, settings)` — dry-run plan (which checks would run).
5. **`data.reference/prompts/stages/pipeline-editorial-info-dumping.md`** — LLM stage prompt
   (returns JSON findings). New file → auto-copied to installs.
6. **Tests:**
   - `server/lib/editorial/checkRegistry.test.js` — shape invariants, dup-id throw,
     invalid-enum throw, `gate` filtering, deterministic naming-check output.
   - `server/services/pipeline/editorial/checkRunner.test.js` — re-run dedup (no dupes),
     `checkId` present on findings, dry-run plan shape.

## Modified files

7. **`server/services/pipeline/manuscriptReview.js`** — add optional `checkId` to
   `sanitizeComment` (default `null`); fold into `findingKey`
   (`${checkId??''}|${issueNumber??''}|${anchorQuote}|${problem}`). Keep existing
   completeness findings deduping unchanged (absent checkId → `''`).
8. **`server/routes/pipeline/editorial.js`** — add:
   - `GET /editorial/checks` → registry + resolved enabled/config state.
   - `PATCH /editorial/checks/:id` → enable/disable/config (Zod-validated).
   - `POST /series/:id/editorial/checks/run` → start run (body: optional `checkIds`), SSE.
   - `GET /series/:id/editorial/checks/run/progress` (SSE attach), `.../status`, `.../cancel`
     (mirror the existing analyze endpoints).
9. **`server/services/pipeline/seriesAutopilot.js`** — add the check-runner pass into the
   bounded editorial loop (after manuscriptCompleteness, behind the same round/budget gates);
   add a `kind: 'editorialChecks'` line to `buildDryRunPlan()`.
10. **`server/lib/validation.js`** — `editorialCheckConfigSchema` (PATCH: `enabled?`,
    `config?`), `editorialChecksRunSchema` (`checkIds?: string[]`),
    `pipelineEditorialChecksSettingsSchema`; wire the settings slice into the existing
    `PUT /api/settings` partial-validation pattern (`server/routes/settings.js`).
11. **`server/lib/index.js`** + **`server/lib/README.md`** — export + document `editorial/`.
12. **`.changelog/NEXT.md`** — user-facing entry under the appropriate heading.

## Verification

- `cd server && npm test` — new registry + runner suites pass; existing manuscriptReview /
  autopilot / validation / `lib/index.test.js` (barrel) suites stay green.
- `node -e "import('./server/lib/editorial/index.js').then(()=>console.log('ok'))"` — confirms
  the new module + barrel load (catches missing-import / cross-module link bugs that vitest
  false-greens).
- Boot guard: a temporarily-malformed registry entry throws at module load (manual sanity).
- Manual end-to-end (dev box, optional): `GET /api/pipeline/editorial/checks` lists both
  checks with default state; `POST /api/pipeline/series/:id/editorial/checks/run` streams SSE
  and the resulting findings appear in the existing manuscript-review for that series with
  `checkId` set; a re-run does not duplicate them.

## Ship

`/do:next` Phase 5–7: re-sync `main`, log changelog, `/simplify` + `/do:pr --no-merge
--review-with=…` (multi-file feature → external review), gate merge on a clean status, merge
with `Closes #1284`, clean up worktree + close issue.
