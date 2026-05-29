# Unified Story Builder

## Context

Today the **Importer**, **Universe Builder** (`/universes`), **Series/Pipeline** (`/pipeline`), and **Writers Room** are siloed pages. A user creating a story from scratch hops between them aimlessly with no sense of order, no clear "this part is done" buy-in, and no protection against revising an early decision in a way that silently invalidates later work.

We want a NEW guided page — **Story Builder** (`/story-builder`) — that walks the user **linearly from idea → universe → plot arc → reader map → characters → issues → video**. Each step is LLM-assisted, validated, has an AI-refinement affordance (like image-prompt refine / Universe Builder expand), and ends with an explicit **lock** before the next step unlocks. By the time the user reaches issue #2, they have explicitly confirmed issue #1 is 100% done and the path forward is defined. Users can go back and **unlock to revise**, but downstream locked steps then get **integrity-gated** (flagged stale, re-review required) without destroying their content.

**Confirmed decisions:**
1. **HYBRID architecture** — Story Builder is a thin *conductor* over the EXISTING universe/series/issue records (reuses their services; does NOT duplicate their data). Lightweight review/lock steps render inline; the heavy per-issue production (prose→script→pages→storyboards→video) **hands off** to the existing Pipeline Issue page (`/pipeline/issues/:issueId/:stage`), then returns to the builder to lock the issue. The four existing pages stay for advanced/direct access.
2. **Reader map** is a NEW distinct concept (separate from `arc.protagonistArc` and `arc.shape`): the roadmap of what the reader/viewer *experiences* — pacing of hooks, planted questions, reveals/payoffs, emotional beats, cliffhangers across issues. It builds on the Vonnegut `shape` backbone. Needs a new data field + its own LLM-assisted review/lock step.
3. **Idea intake = both modes** — type a short seed idea (LLM expands it stage-by-stage) OR paste/import a finished work via the existing Importer (pre-fills all downstream steps; user then reviews + locks each).
4. **Integrity = soft flag + gate** — at lock time, snapshot a hash of each step's upstream inputs. If upstream later changes, mark downstream locked steps "stale" with a badge and require re-review/re-lock before continuing. Never auto-destroy content.

---

## Architecture: conductor over existing records

The Story Builder owns ONE new lightweight record (`story-builder-session`) holding only step status/locks/integrity-hashes plus two FKs (`universeId`, `seriesId`). All real content lives in the universe (`data/universes/<id>/index.json`) and series (`data/pipeline-series/<id>/index.json`) records, mutated through their **existing services**. The builder never duplicates that data.

**Sessions are local-only / excluded from peer sync (v1).** They reference syncable records by FK, but the lock/integrity bookkeeping is a private workflow artifact — syncing it would create cross-install staleness false-positives. So: do NOT add a `PORTOS_SCHEMA_VERSIONS` entry for sessions, do NOT register in `RECORD_TYPE_CATEGORIES`, and do NOT fire `autoSubscribeRecordToAllPeers` in `createStorySession`. Still carry `sanitizeSoftDeleteFields` + `origin` + `ephemeral` for shape parity.

---

## New data: the session record

**Storage:** `createCollectionStore` (per-id directory `data/story-builder/<id>/index.json`) — mirror `server/services/pipeline/series.js` for the store factory, `ERR_NOT_FOUND`/`ERR_VALIDATION`, `TYPE_SCHEMA_VERSION = 1`, and CRUD via `queueRecordWrite` + `saveOneNow`. Omit the sync helpers (`insertWithId`/`mergeFromSync`/`pruneTombstoned*`) since local-only.

**New service `server/services/storyBuilder.js`, `sanitizeSession` shape:**
```
{
  id: 'stb-<uuid>',
  title: string,                          // max 200
  intakeMode: 'seed' | 'import',
  seedIdea: string,                       // max ~4000 (seed mode)
  universeId: string | null,              // FK → universeBuilder
  seriesId:  string | null,               // FK → pipeline/series
  currentStep: string,                    // one of STEP_IDS
  steps: {
    [stepId]: {
      status: 'pending' | 'in-progress' | 'ready' | 'locked',
      locked: boolean,
      lockedAt: string | null,
      upstreamHash: string | null,        // sha256 of upstream inputs at lock time
      issueLocks?: { [issueId]: { locked, lockedAt, upstreamHash } }  // issues step only
    }
  },
  llm: { provider: string|null, model: string|null },
  origin, createdAt, updatedAt,
  ...sanitizeSoftDeleteFields(raw),
  ...(raw.ephemeral === true ? { ephemeral: true } : {})
}
```

**Shared step definitions** — new pure module `server/lib/storyBuilderSteps.js` exporting `STEPS` (ordered) + `STEP_IDS` (mirrors how `ARC_SHAPES`/`ARC_ROLES` live in `storyArc.js`). Register in `server/lib/index.js` barrel + `server/lib/README.md` (enforced by `index.test.js`).

---

## Steps + state machine

Ordered steps (each reuses an existing service for generate/refine):

| step id | content lives in | generate / refine (REUSE) | advance allowed when | lock guards | upstream inputs hashed |
|---|---|---|---|---|---|
| `idea` | session.seedIdea (+ creates universe+series shells) | seed: new light prompt `story-builder-idea-expand`; import: `analyzeImport` (`server/services/importer.js`) | title non-empty + (seedIdea OR import preview); FKs assigned | freezes title/seed | `{ intakeMode, seedIdea }` |
| `universeAesthetic` | universe `locked.{logline,premise,styleNotes,influencesEmbrace,influencesAvoid}` | `expandWorldTemplate`/`refineWorldPrompts` (`universeBuilderExpand.js`/`universeBuilderRefine.js`) | logline+premise+styleNotes present | sets `universe.locked.*` via `updateUniverse` | `{ seedIdea, universeId }` |
| `plotArc` | `series.arc.{logline,summary,protagonistArc,themes,shape}` + `series.seasons[]` | `generateArcOverview` (`arcPlanner.js:242`) + refine via `runPromptRefine` | arc.logline + arc.summary present; shape picked | `series.locked.arc = true` (existing) | `{ universe aesthetic, seedIdea }` |
| `readerMap` (NEW) | `series.arc.readerMap` (NEW field) | NEW `generateReaderMap` in `arcPlanner.js` + new prompt | readerMap has ≥1 hook and ≥1 payoff beat | `series.locked.arcFields.readerMap` (add `'readerMap'` to `ARC_LOCKABLE_FIELDS`, `series.js:89`) | `{ arc.logline/summary/protagonistArc/themes/shape }` |
| `characters` | `universe.characters[]` each `{...,locked}` | `extractCanonFromProse` / `refineUniverseCharacter` (`universeCanon.js`) | ≥1 character entry | per-entry `locked:true` via existing canon-lock | `{ readerMap, arc.summary, universe aesthetic }` |
| `issues` (LOOP) | `issue` records (`issues.js`); seeds from `series.seasons[]` / import proposals | `generateSeasonEpisodes` (`arcPlanner.js:384`) to seed; per-issue **handoff** to `PipelineIssue.jsx` | each issue locked individually | per-issue lock in `steps.issues.issueLocks[issueId]` | per issue: `{ arc, readerMap, characters, prior locked issue ids }` |
| `production` | issue stages on existing PipelineIssue page | none new — pure deep-link out | targeted issues' production complete | terminal; marks session complete | `{ all issue locks }` |

**Gating rule** (enforced server-side in `lockStep`/`advanceStep`, mirrored client-side):
- Cannot advance `currentStep` past step N unless `steps[N].locked === true`.
- Locking recomputes + stamps `upstreamHash`. Unlocking step K leaves steps > K flagged stale (computed on read, see Integrity).
- Issue loop: an issue can only be locked after `characters` is locked; unlocking `plotArc`/`readerMap`/`characters` stales all per-issue locks.

---

## Reader map data model (NEW)

**Lives at `series.arc.readerMap`** (sibling field inside the existing arc object — travels with the series in sync, builds on `arc.shape`).

**Add to `sanitizeArc` in `server/lib/storyArc.js`:**
```
readerMap: {
  hooks:    [ { id, label, atArcPosition: number|null, note } ],
  payoffs:  [ { id, label, atArcPosition: number|null, resolvesHookId: string|null, note } ],
  beats:    [ { id, kind: 'hook'|'reveal'|'payoff'|'emotional'|'cliffhanger', atArcPosition: number|null, intensity: 0..1, note } ],
  cliffhangers: [ { id, atIssueBoundary: number|null, note } ],
  status: 'draft' | 'verified'
} | null
```
Implementation in `storyArc.js`:
- Add `READER_MAP_LIMITS` to `ARC_LIMITS` + a frozen `READER_MAP_BEAT_KINDS` enum (mirror `ARC_ROLES`).
- New `sanitizeReaderMap(raw)` returning `null` when no identifying content; cap arrays, coerce ids (`rm-<uuid>`), clamp `intensity` to [0,1], drop unknown `kind`.
- In `sanitizeArc`: add `readerMap` to the identifying-content check (so an arc with only a readerMap survives) at `storyArc.js:250`, and include `readerMap` in the returned object at line 252.
- **Absent-vs-empty merge:** the generator reads current arc, merges `{ ...arc, readerMap }`, PATCHes the full arc (CLAUDE.md merge rule — `null`/`undefined` preserves, `''`/`[]` clears).

**Lock field:** add `'readerMap'` to `ARC_LOCKABLE_FIELDS` (`series.js:89`) → existing `setArcFieldLock` handles it with zero new plumbing.

**New generator** `generateReaderMap(seriesId, options)` in `arcPlanner.js`, structured like `generateArcOverview`:
- Guard `series.locked.arcFields?.readerMap === true` → throw `ERR_VALIDATION`.
- Context from `series.arc` + `renderArcShapeGuidance(arc.shape)` + `renderArcShapePositionSummary` (build on the Vonnegut backbone) + `series.seasons[]` for issue boundaries.
- Run staged LLM with template `story-builder-reader-map`, then `sanitizeReaderMap(content)`.
- Refine via `runPromptRefineRaw` (`pipeline/refineHelpers.js`) with `story-builder-reader-map-refine` (object result, not single field).

---

## Integrity / staleness

**New pure helper `server/lib/storyBuilderIntegrity.js`** (no I/O; register in barrel + README):
- `hashUpstream(stepId, inputs) -> sha256 hex` — canonical (sorted-key) stringify of the whitelisted upstream fields, then `createHash('sha256')`. Reuse the canonical-stringify/`contentHashForRecord` approach from `server/lib/conflictJournal.js`. **Hash only whitelisted semantic fields — never `updatedAt`** (avoids false positives).
- `computeStaleSteps(session, currentHashes) -> [stepId,...]` — for each locked step, flag if `step.upstreamHash !== currentHashes[stepId]`.

**Detection on read:** `GET /api/story-builder/:id` loads session + universe + series, projects the whitelisted upstream fields per step, builds current hashes, runs `computeStaleSteps`, and returns the session augmented with a transient `staleSteps: [...]` (computed, NOT persisted). Lock records keep their frozen `upstreamHash`.

**UI:** each step header shows a "Stale — upstream changed, re-review" badge when `staleSteps.includes(stepId)`; the advance button is blocked while any earlier locked step is stale until re-reviewed + re-locked (which restamps the hash). Content is never destroyed.

---

## Server routes — `server/routes/storyBuilder.js` (mount `/api/story-builder` in `server/index.js`)

Mirror `routes/importer.js` (`asyncHandler`, `validateRequest`, service-error→HTTP map). New Zod schemas in `server/lib/validation.js`.

| Method + path | Service |
|---|---|
| `GET /api/story-builder` | `listStorySessions()` |
| `POST /api/story-builder` | `createStorySession()` (seed: creates universe+series shells via `createUniverse`/`createSeries`; import: links importer ids) |
| `GET /api/story-builder/:id` | `getStorySession()` + compute `staleSteps` |
| `PATCH /api/story-builder/:id` | `updateStorySession()` |
| `DELETE /api/story-builder/:id` | soft-delete |
| `POST /api/story-builder/:id/steps/:stepId/generate` | delegate to step's reuse service, PATCH universe/series via their services |
| `POST /api/story-builder/:id/steps/:stepId/refine` | `runPromptRefine`/`runPromptRefineRaw` per step |
| `POST /api/story-builder/:id/steps/:stepId/lock` | `lockStep()` — validate readiness, compute+stamp `upstreamHash`, set underlying record lock |
| `POST /api/story-builder/:id/steps/:stepId/unlock` | `unlockStep()` — clear lock, release underlying record lock, keep content |
| `POST /api/story-builder/:id/issues/:issueId/lock` `/unlock` | per-issue loop lock |
| `POST /api/story-builder/:id/import` | `analyzeImport` then pre-fill step statuses to `'ready'` (see reconciliation) |
| `GET /api/story-builder/:id/steps/:stepId/progress` | **SSE** for long generations — use existing SSE util + emitter bridge; client consumes via `useSseProgress.js` |

---

## Client structure

- **`client/src/pages/StoryBuilder.jsx`** — stepper modeled on `client/src/components/digital-twin/SoulWizard.jsx` (progress bar, step header, Back/Next, dots), but: each step renders a dedicated sub-component, "Next" gated on server `staleSteps` + `steps[N].locked`, and an explicit per-step **Lock** button using `useLockToggle` (`patchFn` → `/lock` or `/unlock`).
- **Per-step sub-components** under `client/src/components/story-builder/`:
  - `StepIdea.jsx` — seed-vs-import radio; import tab reuses the Importer intake form.
  - `StepUniverseAesthetic.jsx` — reuses the locked-field editors from `UniverseBuilder.jsx`.
  - `StepPlotArc.jsx` — reuses `client/src/components/pipeline/ArcCanvas.jsx` + the StoryShapes picker.
  - `StepReaderMap.jsx` — NEW: timeline of beats over arc positions layered on the Vonnegut sparkline (reuse `StoryShapes.jsx` backbone); refine button.
  - `StepCharacters.jsx` — reuses the canon character cards from UniverseBuilder.
  - `StepIssues.jsx` — issue list with per-issue "Open in Pipeline" deep-link + "Mark done / Lock".
  - `StepProduction.jsx` — deep-links to `/pipeline/issues/:issueId/:stage`.
- **`client/src/services/apiStoryBuilder.js`** — mirror `apiImporter.js`: `createStorySession`, `getStorySession`, `lockStep`, `unlockStep`, `generateStep`, `refineStep`, `storyStepProgressUrl(id, stepId)`.
- **Deep-linkable routes** (CLAUDE.md, no modals without URLs): `/story-builder`, `/story-builder/:storyId/:step` (`:step` ∈ `STEP_IDS`). Issue handoff navigates OUT to `/pipeline/issues/:issueId/:stage`; user returns to `/story-builder/:storyId/issues` to lock.

---

## Page registration

1. **`client/src/App.jsx`** — `const StoryBuilder = lazyWithReload(() => import('./pages/StoryBuilder'))`; routes:
   ```
   <Route path="story-builder" element={<StoryBuilder />} />
   <Route path="story-builder/:storyId" element={<Navigate to="idea" replace />} />
   <Route path="story-builder/:storyId/:step" element={<StoryBuilder />} />
   ```
2. **`client/src/components/Layout.jsx`** — add a "Story Builder" link in the Create section (alphabetical); add `location.pathname.startsWith('/story-builder')` to the `isFullWidth` list (~line 1016–1030), since it's a wide stepper with ArcCanvas/timeline.
3. **`server/lib/navManifest.js`** (REQUIRED) — add to `NAV_COMMANDS`:
   ```
   { id: 'nav.create.story-builder', path: '/story-builder', label: 'Story Builder', section: 'Create',
     aliases: ['story-builder', 'storybuilder', 'guided', 'new-story', 'story-wizard'],
     keywords: ['idea', 'universe', 'arc', 'reader map', 'guided', 'wizard', 'linear', 'lock', 'front door'] }
   ```
   Covered automatically by `navManifest.test.js` shape tests.

---

## Migration + schema

- New prompt seeds in `data.reference/prompts/stages/`: `story-builder-reader-map.md`, `story-builder-reader-map-refine.md`, `story-builder-idea-expand.md` + their `data.reference/prompts/stage-config.json` entries.
- New migration `scripts/migrations/043-story-builder-prompts.js` (next number after 042), modeled on `041-editorial-analysis-stage.js` (multi-file variant — loop the three filenames + merge stage-config), because boot runs migrations but not `setup-data.js`.
- Adding `arc.readerMap` is additive + lazily sanitized (existing series files load fine; no data-rewrite script needed). But the **wire shape changes** (readerMap now travels in series sync) → bump `PORTOS_SCHEMA_VERSIONS.pipelineSeries: 1 → 2` in `server/lib/schemaVersions.js`. The `data/pipeline-series/index.json` `TYPE_SCHEMA_VERSION` does NOT change (storage layout unchanged).

---

## Conflicts + risks

- **Importer is one-shot vs step-by-step locking.** In import mode, `commitImport` lands canon+arc+ALL issues before the user reviews anything. Reconciliation: on `/import`, after commit, set every step `status:'ready'` (NOT locked). Locking then just stamps `upstreamHash` over already-present content. The builder must tolerate "content exists but step not locked."
- **Locked-arc guard blocks regeneration.** `generateArcOverview`/`generateReaderMap` throw when arc is locked. "Unlock to revise" must call `unlockStep` (clears `series.locked`) BEFORE offering Generate/Refine; client disables those while locked and shows "Unlock to revise."
- **Universe is shared across series.** Locking aesthetic/characters freezes fields other series in the same universe use. Acceptable (universe locks are global by design); UI should note it.
- **Staleness false positives** mitigated by hashing only whitelisted semantic fields with sorted-key stringify, never `updatedAt`.
- **SSE job pruning** already handled by `useSseProgress` `closed`/`onerror`; don't hand-roll.

---

## Plan archival (do first)

Archive this design as a repo record so we keep a history of how features were designed:
- Copy this plan to `./docs/plans/YYYY-MM-DD-unified-story-builder.md` (today: `2026-05-27`). If `docs/plans/` doesn't exist, create it with a short `docs/plans/README.md` explaining the directory holds design plans, newest by date prefix.
- Add a **project workflow convention** to `CLAUDE.md` (project root, under Git Workflow) so future sessions do the same: *"When a plan is approved out of plan mode, copy the finalized plan from `~/.claude/plans/` to `./docs/plans/YYYY-MM-DD-<slug>.md` as a design record before implementing."*

## Recommended build order (ship the experiment incrementally)

0. **Archive the plan** (above) — commit the design doc + the CLAUDE.md convention.
1. **Reader map**: `sanitizeReaderMap` + `READER_MAP_BEAT_KINDS` in `storyArc.js`, `'readerMap'` in `ARC_LOCKABLE_FIELDS`, `generateReaderMap` in `arcPlanner.js`, 3 prompt seeds + migration 043, `pipelineSeries` schema bump. Self-contained, independently shippable, testable.
2. **Pure helpers**: `storyBuilderIntegrity.js` + `storyBuilderSteps.js` + tests (no I/O).
3. **Service + routes**: `storyBuilder.js` store + `routes/storyBuilder.js` + Zod schemas (seed mode, steps 1–5).
4. **UI**: `StoryBuilder.jsx` stepper + sub-components wired to ArcCanvas/canon cards; deep-link routes; nav registration.
5. **Issue loop (step 6) + production handoff (step 7)** to PipelineIssue.
6. **Import mode** last (most coupled; benefits from lock machinery already existing).

---

## Testing

**Server (Vitest):**
- `server/services/storyBuilder.test.js` — CRUD, advance/lock/unlock state machine, gating, unlock-K-stales->K. **MUST** `vi.mock('../instances.js', () => mockNoPeers())` + `vi.mock('../sharing/peerSync.js', () => mockNoPeerSync())` (`server/lib/mockPathsDataRoot.js`) because `createStorySession` creates universe+series shells that fire auto-subscribe (mirror `series.test.js`).
- `server/lib/storyBuilderIntegrity.test.js` — same inputs → same hash; key-order independence; `computeStaleSteps` flags only drifted locked steps, never unlocked.
- `server/lib/storyArc.test.js` — extend: `sanitizeReaderMap` round-trip, null-when-empty, intensity clamp, unknown-kind drop, arc-with-only-readerMap survives.
- `server/services/pipeline/series.test.js` — extend: `readerMap` lock via `setArcFieldLock`; readerMap survives `updateSeries` arc replace.
- `server/services/pipeline/arcPlanner.test.js` — `generateReaderMap` happy path + lock guard (mock the LLM runner).
- `server/routes/storyBuilder.test.js` — status mapping, Zod rejection, SSE smoke.
- `scripts/migrations/043-story-builder-prompts.test.js` — seeds 3 prompts + stage-config (mirror `041`'s test).

**Client (Vitest/jsdom):**
- `client/src/pages/StoryBuilder.test.jsx` — stepper advances only when locked; stale badge from `staleSteps`; deep-link mounts the right step.
- `client/src/components/story-builder/StepReaderMap.test.jsx` — renders beats, refine call.

## Verification (end-to-end)

1. `cd server && npm test` and `cd client && npm test` — all green (new + existing).
2. `npm run dev`, open `/story-builder`. Seed mode: create a session, expand idea → universe aesthetic → lock; generate plot arc → lock; generate reader map → review beats over the sparkline → refine once → lock; characters → lock; seed issues → open issue #1 in Pipeline, produce, return, lock #1 → confirm #2 unlocks.
3. Integrity: go back, unlock `plotArc`, edit the arc summary → confirm `readerMap`/`characters`/issue locks show the "stale" badge and advance is blocked until re-reviewed + re-locked; confirm their content was NOT destroyed.
4. Import mode: paste a finished work → confirm all steps pre-fill as `ready` (unlocked) and walk/lock each.
5. `⌘K` → "story builder" resolves; voice `ui_navigate` "story builder" works (nav manifest).
