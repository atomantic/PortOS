# Manuscript Editorial Review — "Generate edits for every finding"

## Context

On the manuscript editor (`/pipeline/series/:id/manuscript`), **"Run editorial review"** runs the
manuscript-completeness pass (`POST /pipeline/series/:id/manuscript/completeness` →
`arcPlanner.analyzeManuscriptCompleteness` → `manuscriptReview.seedReviewFromFindings`). It produces
itemized editorial comments only — each comment lands with `fix: null`, so the user must click
**"Generate fix"** on every comment individually (one extra LLM call each) before they can review the
diff and **Accept**.

The user wants a second option on the review trigger: produce the editorial findings **and** a full
proposed manuscript edit in the same pass — a `find`/`replace` per finding — so every comment arrives
with its `fix` already attached. The existing per-comment diff viewer (`ManuscriptCommentCard` +
`SideBySideDiff`/`InlineDiff`), the **Impact preview** modal, and the **Accept** path already render
and apply `comment.fix` — so once fixes are pre-attached, **the entire review/accept-one-by-one UX
already works** with no changes. This eliminates the N manual "Generate fix" round-trips.

**Decisions (confirmed):**
- **Single-pass prompt** — the completeness LLM call returns each finding's `replace` inline; attach
  `fix = { find: anchorQuote, replace }` via the existing `locateFindSpan` anchoring. No N+1 fix loop.
- **Checkbox** — add a second checkbox beside "Start fresh": *"Generate edits for every finding."*
- **SSE progress** — stream per-chunk progress (mirrors `editorialAnalysisRunner`), since a chunked
  large manuscript otherwise shows a long opaque spinner.

## Approach

### 1. Prompt: conditional `replace` field (single source, migrated)

`data.reference/prompts/stages/pipeline-manuscript-completeness.md` — wrap an additive instruction +
output-contract field in a Mustache section so it only appears when the editor asks for edits:

```mustache
{{#withEdits}}
- `replace` — the rewritten text that **replaces `anchorQuote` verbatim** to close this gap. Copy
  `anchorQuote` into `find`-equivalent position and supply the smallest concrete rewrite of that
  exact span. For `comic-structure` (full-page), `replace` is the complete panel-by-panel page.
  Omit `replace` only when no in-place edit is possible.
{{/withEdits}}
```
Add `"replace": "..."` to the JSON example inside the same `{{#withEdits}}` block. `anchorQuote`
already serves as the fix's `find`; `replace` is the new span. Keep the findings-only contract intact
(the section is absent when `withEdits` is false → identical prompt for the legacy path).

**Migration `scripts/migrations/083-completeness-with-edits-prompt.js`** (latest is 082):
- Use `makePromptReplaceMigration` from `./_lib.js` (copy the shape of
  `066-manuscript-finding-replacement-strategy-prompts.js`).
- `ACCEPTED_OLD_MD5['pipeline-manuscript-completeness.md']` = current shipped hash (from 066's
  `NEW_SHIPPED_MD5`, `cec8faeb75dfff74e41b8221145c2e92`).
- `NEW_SHIPPED_MD5` = the post-edit hash (compute after editing the `.md`).
- **Mirror the new hash into every earlier migration that tracks this file** (056, 057, 066) per the
  prompt-migration-drift cross-sync rule — update their `NEW_SHIPPED_MD5` and the `setup-data.js`
  drift table — or their drift-catch tests go red. Add a sibling `.test.js` like 066's.

### 2. Server: thread `withEdits` through analyze → shape → seed

**`server/services/pipeline/arcPlanner.js`** (`analyzeManuscriptCompleteness`, ~line 789):
- Accept `options.withEdits`. Pass `withEdits: !!options.withEdits` into the template ctx (alongside
  `manuscript`) in `runOne`.
- `shapeCompletenessFindings` (~line 698): when `withEdits`, also read `raw.replace` (string, trimmed,
  same `STAGE_OUTPUT_MAX`-ish cap as fix `replace`) onto each shaped finding. Absent/empty → no fix.
- Bump `COMPLETENESS_OUTPUT_RESERVE_TOKENS` when `withEdits` (each finding now also carries a full
  `replace`) — reserve more output room so a long edit list isn't truncated. Reuse `manuscriptFix`'s
  `FIX_OUTPUT_RESERVE_TOKENS` sizing as a reference.

**`server/services/pipeline/manuscriptReview.js`** (`seedReviewFromFindings`, ~line 174):
- Build each candidate's `fix` from the finding's `anchorQuote` + `replace`: reuse
  `manuscriptFix.locateFindSpan(section.content, anchorQuote)` (export already public) to confirm the
  anchor resolves; set `fix = { find: anchorQuote, replace, fuzzy: <not-located-verbatim> }`, with
  `edits: [{ issueNumber, issueId, stageId, find, replace }]` so the existing **Accept** path
  (`acceptManuscriptFix`) and **Impact preview** consume it unchanged.
- `sanitizeComment`/`sanitizeFix` already persist `fix` — just pass it in the candidate object.
- When a finding has no usable `replace` (or anchor doesn't resolve), leave `fix: null` so the comment
  falls back to manual "Generate fix" — no regression.
- `findingKey` dedupe is unchanged (keyed on issueNumber/anchor/problem).

> **Reuse note:** the fix-building logic (anchor → `{find, replace, edits}`, fuzzy flag) overlaps with
> `manuscriptFix.normalizeFix`. Factor the per-finding `{anchorQuote, replace, section} → fix` shaping
> into a small exported helper in `manuscriptFix.js` and call it from both seed and fix paths rather
> than duplicating the `locateFindSpan`/`fuzzy` logic.

### 3. Server: streaming runner + routes (mirror editorial analysis)

**`server/services/pipeline/manuscriptCompletenessRunner.js`** (new — model on
`editorialAnalysisRunner.js`): in-memory `runs` Map keyed by seriesId; `startCompletenessReview`,
`attachClient`, `isActive`, `cancel`. The coordinator calls the same chunk loop but emits SSE frames
per chunk, then seeds the review and emits a terminal frame:
- `{ type:'start', runId, total }` (total = chunk count; 1 in whole mode)
- `{ type:'chunk:start'|'chunk:complete', done, total }`
- `{ type:'complete', runId, openCount, chunked, chunkCount }` / `{ type:'error', ... }` / `canceled`
- Refactor: extract the chunk-iteration core of `analyzeManuscriptCompleteness` into an async
  generator or callback-accepting form so both the sync endpoint and the runner share it (avoid
  copy-pasting the chunk/merge/digest logic).

**`server/routes/pipeline/manuscript.js`**: keep `POST /completeness` synchronous & unchanged for
findings-only (ArcCanvas + checkbox-off both rely on the sync `{ issues, review }` contract). Add:
- `POST /series/:id/manuscript/completeness/stream` → `startCompletenessReview` → `{ runId, sseUrl, mode:'fresh'|'merge', withEdits:true }`
- `GET  /series/:id/manuscript/completeness/progress` (SSE attach)
- `GET  /series/:id/manuscript/completeness/status` → `{ active }`
- `POST /series/:id/manuscript/completeness/cancel`
- Extend `manuscriptCompletenessSchema` with `withEdits: z.boolean().optional()` (and validate the
  stream route body the same way).

### 4. Client: checkbox + SSE-driven progress

**`client/src/services/apiPipeline.js`**: add `startPipelineManuscriptCompleteness(seriesId, {providerOverride, modelOverride, mode, withEdits})`,
`pipelineManuscriptCompletenessSseUrl(seriesId)`, status + cancel wrappers. Re-export from `api.js`
and add README rows (catalog maintenance rule).

**`client/src/hooks/usePipelineManuscriptCompletenessProgress.js`** (new): thin wrapper over
`useSseProgress` like `usePipelineEditorialProgress.js`. Register in `hooks/index.js` + README.

**`client/src/pages/PipelineManuscriptEditor.jsx`**:
- Add `generateEdits` state + a second checkbox under "Start fresh" (id `ms-generate-edits`,
  `htmlFor` paired). Label: *"Generate edits for every finding — pre-build a fix per note so you can
  review the full diff & accept."*
- When `generateEdits` is **off**: keep today's synchronous `runEditorialReview` path verbatim.
- When **on**: call the stream endpoint, subscribe via the new hook, render per-chunk progress on the
  button (`Drafting edit chunk 2 of 4…`) and a small list (reuse the `reviewMeta?.chunked` warning
  area). On the terminal `complete` frame, re-fetch the review (`getPipelineManuscriptReview`) →
  `setComments`, set `reviewMeta`, toast. Add a Cancel affordance while streaming.
- On mount, probe `…/completeness/status` and re-attach to an in-flight run (mirror editorial).

## Critical files

- `data.reference/prompts/stages/pipeline-manuscript-completeness.md` — `{{#withEdits}}` `replace` block
- `scripts/migrations/083-completeness-with-edits-prompt.js` (+ `.test.js`); sync hash into 056/057/066 + `scripts/setup-data.js`
- `server/services/pipeline/arcPlanner.js` — `withEdits` ctx, `replace` shaping, output-reserve bump
- `server/services/pipeline/manuscriptReview.js` — build/persist `fix` in `seedReviewFromFindings`
- `server/services/pipeline/manuscriptFix.js` — export shared `{anchorQuote,replace,section}→fix` helper
- `server/services/pipeline/manuscriptCompletenessRunner.js` (new) — SSE runner
- `server/routes/pipeline/manuscript.js` — `withEdits` schema + stream/progress/status/cancel routes
- `client/src/services/apiPipeline.js`, `client/src/hooks/usePipelineManuscriptCompletenessProgress.js` (new),
  `client/src/pages/PipelineManuscriptEditor.jsx`

## Verification

1. **Unit/migration:** `cd server && npm test` — add coverage that `shapeCompletenessFindings({withEdits})`
   reads `replace`; that `seedReviewFromFindings` attaches `fix` with correct `find`/`fuzzy`; migration
   083 test asserts old→new hash auto-update + drift-table parity (model on `066…test.js`).
2. **Client:** `cd client && npm test` — extend `PipelineManuscriptEditor.test.jsx`: checkbox-on calls
   the stream endpoint; a `complete` SSE frame populates comments **with `fix` set**, and the
   "Generate fix" button is absent (diff + Accept shown directly).
3. **End-to-end (dev server):** `npm run dev`, open a series with a drafted multi-issue manuscript →
   `/pipeline/series/:id/manuscript`. Check "Generate edits for every finding" → Run. Confirm per-chunk
   progress, then each comment shows a diff + **Accept** with no "Generate fix" step; Accept applies the
   edit and snapshots a revertible version. Confirm **Impact preview** shows the aggregate diff. Re-run
   with the box **off** → unchanged findings-only behavior. Confirm ArcCanvas "Finish the draft" still
   works (sync path untouched).
4. **Compat:** confirm an install whose completeness prompt was customized is left intact + warned
   (migration is hash-gated), and that a model that omits `replace` yields `fix: null` comments that
   still support manual "Generate fix".
