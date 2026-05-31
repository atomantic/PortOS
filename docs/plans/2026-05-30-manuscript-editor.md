# Finish The Draft → Actionable Manuscript Editor

## Context

The "Finish the Draft" feature (manuscript-completeness pass) reads a series' drafted
scripts and returns editorial findings, but it isn't yet *actionable*:

1. **Bug:** The findings (and the sibling verify/derive results) live in component-local
   state in `ArcHeader` (`client/src/components/pipeline/ArcCanvas.jsx`) with **no reset
   when `series.id` changes** — so switching series leaves the prior series' suggestions
   rendered on the new one.
2. **Missing workspace:** Findings render as a flat advisory list with no way to act on
   them. The user wants a **dedicated full-page manuscript editor** that shows the whole
   series manuscript (all issues in story order) with editorial feedback as a **Word-style
   comments sidebar** — click a comment to jump to the relevant spot, generate an AI fix,
   modify it, and save it into the manuscript. It must work for all three manuscript types
   (prose, teleplay, comic), auto-detecting which type each issue uses.

**Confirmed product decisions:**
- **Surface:** dedicated full-page editor at `/pipeline/series/:seriesId/manuscript`.
- **Editing scope:** AI-comment-driven fixes **AND** full free-text editing of each
  issue section (live save per section through the serialized stage-write path).
- **Fix application:** surgical anchored **find/replace** (editable before accept), not
  full-issue rewrite.

The series manuscript is *virtual*: it's the concatenation of one chosen stage per issue
(`comicScript` ▸ `teleplay` ▸ `prose` precedence). Edits target a specific issue+stage.

---

## Change 1 — Bug fix: reset ArcHeader ephemeral state on series switch

**File:** `client/src/components/pipeline/ArcCanvas.jsx` — `ArcHeader` (component starts
line 520). Add one effect right after the `useState` block (after line 532), before
`useLockToggle`:

```jsx
// Switching series must not leak the prior series' advisory results. These are
// all ephemeral (never persisted) — reset on id change.
useEffect(() => {
  setVerifyIssues(null);
  setDerivePreview(null);
  setCompleteness(null);
  setConfirmingRegen(false);
  setResolvingIdx(new Set());
}, [series.id]);
```

`running` is intentionally excluded (it's bound to an in-flight async call whose
`setRunning(null)` must still fire). `useEffect` is already imported in this file.

---

## Change 2 — Manuscript editor with anchored, persisted, AI-fixable comments

### 2.1 Server — structured manuscript collection
**File:** `server/services/pipeline/arcPlanner.js`
- Add exported `collectManuscriptSections(seriesId, { stageOrder = MANUSCRIPT_STAGES } = {})`
  returning `[{ issueId, number, title, stageId, content }]` in `arcPosition` order. Reuse
  the existing `listIssues` + `compareIssuesByPosition` + `stageTextOf` + precedence-pick
  logic from `collectIssueSourceText` (line 195).
- **Refactor `collectIssueSourceText` to call `collectManuscriptSections` and join** the
  sections (`# Issue N — Title (stageId)\n\n{content}` joined by `\n\n---\n\n`, sliced to
  `BACKFILL_SOURCE_MAX`). The corpus the LLM sees and the sections the client renders MUST
  stay byte-identical — `anchorQuote`/`find` matching depends on it. A `primaryStageId`
  (most common `stageId`) is the editor's display "mode"; per-issue `stageId` is
  authoritative for writes.

### 2.2 Server — anchored findings
**File:** `server/services/pipeline/arcPlanner.js` — extend `shapeCompletenessFindings`
(line 594) to also carry:
```js
issueNumber: Number.isInteger(raw?.issueNumber) ? raw.issueNumber : null,
anchorQuote: typeof raw?.anchorQuote === 'string' ? raw.anchorQuote.trim().slice(0, 400) : '',
```
Keep `location` (fuzzy fallback). Findings without anchors still render (no click-to-jump).

**File:** `data.reference/prompts/stages/pipeline-manuscript-completeness.md` — add
`issueNumber` (integer matching the `# Issue N` headers) and `anchorQuote` (a short
**verbatim** excerpt copied from the manuscript at the gap) to the output contract +
field rules. This is an **edit to a shipped prompt → needs a migration.**

**File:** `scripts/migrations/056-manuscript-anchored-findings-prompt.js` (+ `.test.js`) —
use `makePromptReplaceMigration` from `./_lib.js` exactly like
`054-source-agnostic-stage-prompts.js`. Set `ACCEPTED_OLD_MD5` to the current shipped
`pipeline-manuscript-completeness.md` hash and `NEW_SHIPPED_MD5` to the post-edit hash
(via the repo's normalized `md5()` helper). Mirror the new hash into `scripts/setup-data.js`'s
drift table. (The new fix prompt below is a *new* file — no migration; `setup-data.js`
copies missing prompts.)

### 2.3 Server — review persistence
**File (new):** `server/services/pipeline/manuscriptReview.js`
- Storage: sibling file `data/pipeline-series/{id}/manuscript-review.json` (kept in the
  series folder so existing share/sync of that folder carries it; do NOT bloat the
  LWW-merged series `index.json`). Serialize writes on a per-series tail (single tail per
  shared file, per CLAUDE.md).
- `getReview(seriesId)` → `{ schemaVersion: 1, comments: [] }` when absent (distinguish
  absent vs empty).
- `seedReviewFromFindings(seriesId, findings, { runId })` → map shaped findings → comment
  records (status `open`), resolving `issueId`/`stageId` from `collectManuscriptSections`
  by `issueNumber`. **Preserve** existing `accepted`/`dismissed` comments; dedupe still-open
  comments by `(issueNumber, anchorQuote, problem)`.
- `updateComment(seriesId, commentId, patch)` — status/fix edits; LWW on `updatedAt`.
- `mergeReviewFromSync(seriesId, remoteReview)` — LWW-by-`updatedAt` per comment, mirroring
  `mergeIssuesFromSync` (issues.js:1039) so the review participates in series-folder sync.

**Comment shape:**
```js
{ id, issueNumber, issueId|null, stageId|null,
  severity, category, location, problem, suggestion, anchorQuote,
  status: 'open'|'accepted'|'dismissed',
  fix: { find, replace, fuzzy? } | null,
  sourceRunId, createdAt, updatedAt }
```

### 2.4 Server — fix generation + accept
**File (new):** `server/services/pipeline/manuscriptFix.js`
- `generateManuscriptFix(seriesId, { commentId, providerOverride, modelOverride })` —
  resolve the comment's `issueId`+`stageId`, load that issue's stage text (`getIssue` →
  `stages[stageId]`, `stageTextOf`), call
  `runStagedLLM('pipeline-manuscript-fix', ctx, { returnsJson: true, source: 'pipeline-manuscript-fix', ... })`.
  Persist `fix: { find, replace }` on the comment (status stays `open`). Validate that
  `find` occurs in the current stage text; if not, set `fix.fuzzy = true` so the client
  falls back to manual editing instead of failing silently.
- `acceptManuscriptFix(seriesId, { commentId, find, replace })` — apply through the
  serialized `updateStageWithLatest(issueId, stageId, computeFn)` (issues.js:974):
  ```js
  const text = stageTextOf(cur);
  const idx = text.indexOf(find);
  if (idx === -1) throw makeErr('Anchor text no longer present — regenerate the fix', ERR_VALIDATION);
  return { output: text.slice(0, idx) + replace + text.slice(idx + find.length),
           lastRunId: makeRunId('manuscript-fix') }; // fresh runId → snapshotRunHistory keeps prior text
  ```
  Then `updateComment(... status: 'accepted')`. Return the refreshed section content so the
  client re-renders without a full reload.

**File (new):** `data.reference/prompts/stages/pipeline-manuscript-fix.md` — context = series
bible block + the single issue's stage text + `category`/`severity`/`problem`/`suggestion`/
`anchorQuote`. Output JSON `{ find, replace }`: `find` MUST be copied verbatim from the
provided text, as small as possible while uniquely locatable; `replace` is the surgical
edit preserving the author's voice. Add a matching `pipeline-manuscript-fix` entry to
`data.reference/prompts/stage-config.json` with `returnsJson: true`.

### 2.5 Server — free-text section save
Reuse the **existing** issue stage PATCH path for free-text edits (no new endpoint needed):
each editable section saves via the existing `PATCH /pipeline/issues/:id` → `updateIssue`
stage write (serialized). The editor sends `{ stages: { [stageId]: { output } } }` for the
edited issue. Confirm the existing issue patch schema permits a stage `output` write; if it
routes through `updateStageWithLatest`, prefer that for serialization.

### 2.6 Server — routes
**File:** `server/routes/pipeline.js` (near the completeness route ~line 1293, using
`asyncHandler` + `validateRequest` + `mapServiceError`, no try/catch):
- `GET  /series/:id/manuscript` → `{ sections, primaryStageId }`.
- `GET  /series/:id/manuscript/review` → `getReview`.
- `POST /series/:id/manuscript/completeness` (existing) — after `analyzeManuscriptCompleteness`,
  call `seedReviewFromFindings` and return the merged review alongside `issues` (keep
  returning `issues` for the existing ArcHeader caller — backward compatible).
- `PATCH /series/:id/manuscript/review/comments/:commentId` → `updateComment`.
- `POST  /series/:id/manuscript/review/comments/:commentId/fix` → `generateManuscriptFix`.
- `POST  /series/:id/manuscript/review/comments/:commentId/accept` → `acceptManuscriptFix`.

**Zod schemas** (inline near the existing `manuscriptCompletenessSchema` at line 587):
- `manuscriptFixGenerateSchema = z.object(providerOverrideShape)`.
- `manuscriptFixAcceptSchema = z.object({ find: z.string().min(1).max(STAGE_OUTPUT_MAX), replace: z.string().max(STAGE_OUTPUT_MAX) })`.
- `manuscriptCommentPatchSchema = z.object({ status: z.enum(['open','accepted','dismissed']).optional(), fix: z.object({ find: z.string().max(STAGE_OUTPUT_MAX), replace: z.string().max(STAGE_OUTPUT_MAX) }).nullable().optional() }).strict()` (absent vs explicit-null).

### 2.7 Client — API wrappers
**File:** `client/src/services/apiPipeline.js` (near `analyzePipelineManuscriptCompleteness`
line 415; re-export via `api.js` since pages import from `../services/api`):
`getPipelineManuscript`, `getPipelineManuscriptReview`, `patchPipelineManuscriptComment`,
`generatePipelineManuscriptFix`, `acceptPipelineManuscriptFix`, and a free-text section save
(reuse `updatePipelineIssue`).

### 2.8 Client — editor page
**File (new):** `client/src/pages/PipelineManuscriptEditor.jsx` — full-bleed two-pane:
- Loads series + `getPipelineManuscript` + `getPipelineManuscriptReview` (Promise.all with
  the cancel-guard pattern from `PipelineSeries.jsx` lines 58-78).
- **Left pane (scrollable manuscript):** one section per issue, header `Issue N — Title
  (stageId)`, stable `id={`ms-issue-${number}`}` + a `ref` for scroll-to. Each section is a
  **live-editable textarea** (full free-text editing) with dirty-tracking + debounced save
  via `updatePipelineIssue` (status badge like `TextStagePanel`). `primaryStageId` shown as
  the editor mode label.
- **Right pane (comments sidebar):** comments grouped by status with severity/category
  badges. Per card: problem, suggestion, **Jump** (scroll to section + transient highlight
  of `anchorQuote` substring), **Generate fix**, then a `{find → replace}` preview with an
  **editable `replace` textarea** + **Accept** / **Dismiss**. After accept, update the
  affected section content from the response and move the comment to "accepted" locally
  (reactive update, no full reload). `fuzzy` fixes fall back to manual editing.
- Full-bleed is automatic: Layout's `isFullWidth` already matches `/pipeline/series/`.

**File:** `client/src/App.jsx` — lazy import + `<Route path="pipeline/series/:seriesId/manuscript" .../>`
(mirror the existing roadmap sub-route).

**Entry point:** in `ArcCanvas.jsx` `CompletenessResults` / ArcHeader results block, add an
`Open manuscript editor` Link to `/pipeline/series/${series.id}/manuscript`. Because the
completeness route now seeds the review file, the editor shows the just-generated comments
on open.

**Nav manifest:** no `NAV_COMMANDS` entry — this is a per-series detail sub-route needing a
concrete `:seriesId`, matching the existing `/pipeline/series/:seriesId/roadmap` precedent.

---

## Reuse notes
- `collectManuscriptSections` = refactored core of `collectIssueSourceText`
  (arcPlanner.js:195) — same precedence/order; corpus derived from sections to stay
  byte-identical.
- Accept + free-text writes go through `updateStageWithLatest` (issues.js:974): already
  serialized, already snapshots `runHistory` (`snapshotRunHistory`, line 262) on `lastRunId`
  change, already enforces `STAGE_OUTPUT_MAX`.
- Prompt migration via `makePromptReplaceMigration` (`scripts/migrations/_lib.js`, used by 054).
- Client load/cancel + reactive-update conventions from `PipelineSeries.jsx`; toasts via
  `client/src/components/ui/Toast`.

---

## Verification / test plan
**Server (`*.test.js` next to sources):**
- `collectManuscriptSections` returns correct ordered per-issue records; `collectIssueSourceText`
  output **byte-identical** after refactor (string-equality test).
- `shapeCompletenessFindings` carries/validates `issueNumber`/`anchorQuote`; backward compat
  for unanchored findings.
- `manuscriptReview` seed/dedupe/merge LWW; absent-file → empty; accepted comments survive re-seed.
- `manuscriptFix` accept applies find/replace, snapshots prior output to `runHistory`, throws
  `ERR_VALIDATION` on missing `find`.
- Routes: GET sections/review; POST completeness seeds review; PATCH/fix/accept happy +
  Zod 422 paths.
- Migration `056` test mirrors `054-…test.js` (old hash upgrades; customized prompt left intact).

**Client:** smoke render of `PipelineManuscriptEditor` with mocked API — Jump scrolls/highlights;
accept relocates comment reactively; free-text edit triggers debounced save.

**Manual:** run "Finish the draft" on a series with drafted scripts → Open editor → Jump to
anchor → Generate fix → edit replacement → Accept → confirm stage `output` updated and prior
text in `runHistory`; edit a section free-text → confirm saved; reload → review + comment
statuses persist; switch series on the arc page → confirm prior completeness results cleared
(Change 1).

Run: `cd server && npm test`, `cd client && npm test`. Run `/simplify` before committing.

---

## Risks / sequencing
- **Anchor fragility:** `anchorQuote`/`find` are verbatim substrings; the byte-identical
  corpus↔sections invariant is load-bearing. Validate presence server-side; mark `fuzzy` and
  fall back to manual editing rather than failing.
- **Migration hashes:** compute exact pre/post normalized `md5()` and mirror the new hash into
  `setup-data.js`'s drift table in the same change, or `setup-data` flags drift.
- **runHistory churn:** each accepted fix + free-text save consumes a `runHistory` slot (cap 5).
  Acceptable; bulk fixes on one issue roll older generations out.
- **Sequencing:** 2.1 + 2.2 are independent; 2.3 depends on both; 2.4/2.5 depend on 2.1; client
  (2.7/2.8) depends on routes (2.6). Ship the prompt edit + migration together.
