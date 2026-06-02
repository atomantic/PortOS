# Context-aware manuscript editorial (full-manuscript ↔ chunked)

**Date:** 2026-05-31
**Status:** Designed, not implemented. Part (a) (the urgent Ollama truncation fix) shipped separately; this doc covers part (b).
**PLAN.md anchor:** `[context-aware-editorial-budgeting]`

## Problem

The editorial review features feed manuscript text to an LLM with **no awareness of the
target model's context window**:

- **Manuscript completeness** ("Finish the draft", `server/services/pipeline/arcPlanner.js:722`,
  `collectIssueSourceText` + `BACKFILL_SOURCE_MAX = 200_000`) concatenates the **whole series**
  (up to 200K chars ≈ 50K tokens) into **one** LLM call.
- **Manuscript fix** ("Generate fix", `server/services/pipeline/manuscriptFix.js:278`) sends one
  comment's resolved targets — a single issue **or the whole manuscript** when the comment is
  unanchored/story-level — in one call. This whole-manuscript path is required: a structural/arc
  fix must place edits *throughout* the manuscript, so it genuinely needs the whole text in context.
- **Editorial analysis** (reader-emotion, `server/services/pipeline/editorialAnalysis.js:174`,
  `CONTENT_MAX = 48_000`) is already per-issue, but its cap is also a hardcoded constant.

Two failure modes result:

1. **Small-context models silently truncate.** Before part (a), Ollama's OpenAI endpoint defaulted
   to a ~4K window and dropped everything past it — so local editorial "reviewed" ~3% of the book
   with no error. Part (a) lifts the default window (per-request `num_ctx`), but a 50K-token
   manuscript still won't fit a model whose real ceiling is, say, 8K–32K.
2. **Big-context models are needlessly capped.** Claude 4.8 (~1M ctx) and GPT 5.5 are hard-capped at
   the 200K-char / 48K-char constants, throwing away manuscript the model could easily hold.

We want to support **both** full-manuscript and chunked review, choosing automatically based on the
target model's context budget — whole manuscript when it fits, chunk + story-bible + merge when it
doesn't.

## Design

### 1. Declare each provider's context window

Add a `contextWindow` (tokens) field to the aiToolkit provider config — sibling to the `numCtx`
field added in part (a). (`numCtx` = the per-request window we *ask Ollama for*; `contextWindow` =
the budget the editorial planner is *allowed to assume*. For local Ollama they track each other; for
cloud providers `numCtx` stays null and `contextWindow` reflects the model's real ceiling.)

- Schema parity: `server/lib/aiToolkit/validation.js` `providerSchema` + `createProvider()` in
  `server/lib/aiToolkit/providers.js` (mirror the `numCtx` additions from part (a)).
- Seed sensible defaults in `data.reference/` provider seeds: Claude 4.8 ≈ 1_000_000, GPT 5.5 ≈ its
  published ceiling, Mistral Large 128_000, local backends from the model (fall back to `numCtx`).
- The pipeline reads the **effective** window for the resolved provider/model in `stageRunner.js`
  (provider override > stage pin > active), reserving headroom for output + the story bible.

### 2. A context budgeter

New pure helper (`server/lib/pipeline/contextBudget.js`, unit-tested), roughly:

```
estimateTokens(text)                     // chars/4 heuristic is fine; no tokenizer dep
fitsWholeManuscript({ manuscriptTokens, storyBibleTokens, outputReserve, contextWindow })
planEditorialPasses({ issues, storyBible, contextWindow, outputReserve })
  -> { mode: 'whole', text }  |  { mode: 'chunked', chunks: [{ issues, storyBible, runningSummary }] }
```

- `mode: 'whole'` when `manuscript + storyBible + outputReserve <= contextWindow` → existing single
  call, but with the cap derived from `contextWindow` instead of the hardcoded 200K/48K.
- `mode: 'chunked'` otherwise → chunk by issue/chapter (reuse the per-issue plumbing already in
  `editorialAnalysis.js`), **always** include the story bible (`server/lib/storyBible.js`) +ﾟa rolling
  summary of prior chunks' findings so cross-chapter continuity is still caught, then **merge**
  per-section findings into the same `{ edits: [...] }` / findings shape the UI already consumes.

### 3. Wire the budgeter into the three passes

- `arcPlanner.analyzeManuscriptCompleteness` — replace the `BACKFILL_SOURCE_MAX` hardcap with the
  budgeter; when chunked, run the completeness prompt per chunk and merge findings (dedupe by
  issueNumber + anchorQuote).
- `manuscriptFix.generateManuscriptFix` — the whole-manuscript "place edits throughout" case stays
  whole when it fits; when it doesn't, fall back to a two-pass map/merge (locate target sections,
  then generate edits per section) rather than silently truncating.
- `editorialAnalysis.analyzeIssue` — derive `CONTENT_MAX` from the budget instead of the constant.

### 4. Merge semantics

Chunked passes must reconcile findings the way the monolithic split migrations do (see the
`[[project_monolithic_split_migration_fidelity]]` memory): first-wins dedupe, preserve issue
ordering, never drop a finding silently. Log (single-line, emoji-prefixed) when a pass was chunked
and how many chunks, so a chunked review never *looks* like a whole-book review when it wasn't.

## Risks / decisions to lock before implementing

- **Token estimation without a tokenizer.** chars/4 is conservative; combined with a configurable
  `outputReserve` (default ~8K) and a safety margin (~10%) it avoids over-filling. Decide the margin.
- **Editing vendored aiToolkit.** `contextWindow` belongs in the toolkit provider shape (same as
  `numCtx`); keep it generic (no PortOS imports) so upstream syncs don't fight it.
- **Rolling-summary cost.** Chunked continuity needs prior-chunk context; a summary keeps it bounded.
  Decide whether the summary is LLM-generated per chunk or a structured findings digest (prefer the
  latter — cheaper, deterministic, no extra model call).
- **UI signal.** Surface "reviewed in N chunks vs. whole" in the Manuscript Editor so the user knows
  the review's coverage shape.

## Out of scope

- Per-model tokenizer integration (the chars/4 heuristic is enough; revisit only if mis-estimation
  bites).
- Streaming/iterative editorial UI changes beyond the chunk-count indicator.
