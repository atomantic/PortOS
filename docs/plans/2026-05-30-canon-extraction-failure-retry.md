# Retain canon-extraction failures + retry with a chosen provider/model

## Context

When a pipeline issue's **prose** stage finishes, PortOS auto-extracts canon
(characters / places / objects) from the prose into the linked universe. The
user generated prose for issue #1 of *Giant*, then extraction failed:

- Codex **safety-refused** the `objects` kind (`Invalid prompt: we've limited
  access to this content for safety reasons…`).
- The Claude Code fallback then failed with `401 Invalid authentication
  credentials`.
- A later manual "Extract from prose" (Nouns stage) hit
  `Invalid JSON in AI response: Bad control character…`.

Two problems surfaced:

1. **The failure is swallowed.** `extractCanonFromProse` runs all three kinds
   through `Promise.all` (`server/services/universeCanon.js:71`), so one kind
   rejecting discards the characters + places that *did* extract. The auto path
   only `console.warn`s and throws nothing away that's visible
   (`server/services/pipeline/textStages.js:331`) — nothing is persisted, so
   after reload the user has no idea extraction failed or why.
2. **No way to retry with a different model.** The Nouns "Extract from prose"
   button sends no provider/model override (`NounsStage.jsx:223`), so the user
   can't keep trying different providers/models until one succeeds.

**Outcome:** extraction becomes resilient to per-kind failure (keep the
successes, flag the rest), the outcome is **persisted on the issue** so it
survives reload, and the Nouns stage gets a **provider/model picker + a failure
banner + retry** so the user can keep trying models until objects (or whatever
failed) come through.

Design decisions confirmed with user: **keep partial successes & flag failed
kinds**, and **put the retry UI on the Nouns stage** (not also on Prose).

## Server

### 1. Thread `modelOverride` through the extraction stack
- `server/lib/bibleExtractor.js` — `extractBible({ … , modelOverride })`, pass
  `modelOverride` into `runStagedLLM` (it already supports `modelOverride`,
  `stageRunner.js:218`).
- `server/services/universeCanon.js` — `extractCanonFromProse` accepts
  `opts.modelOverride`, forwards to each `extractBible` call (`runOne`).

### 2. Per-kind resilience in `extractCanonFromProse` (`universeCanon.js`)
- Replace the `Promise.all` / serial-reduce that throws on the first rejection
  with **settle semantics**: run each kind, collect successes and
  `failures: [{ kind, error }]`.
- Merge only the kinds that **succeeded** into the universe (existing
  `mergeExtractedBible` path, unchanged).
- If **every** kind failed → throw a `ServerError` (hard failure, callers still
  see an error). If **some** succeeded → resolve.
- New return shape (additive): `{ universe, results, failures }`. Existing
  callers read `universe`/`results` and ignore `failures` — backward compatible.

### 3. Persist outcome on the issue (`server/services/pipeline/issues.js`)
- Add a `canonExtraction` field to `emptyStage()` and `sanitizeStage()` so it
  round-trips (sanitizeStage currently drops unknown fields). Shape, all
  clamped/sanitized, `null` when never attempted:
  ```js
  canonExtraction: {
    status: 'ok' | 'partial' | 'failed',
    error: '',                 // trimmed message (clamp like errorMessage)
    failedKinds: [],           // ['object', …]
    extracted: { characters: 0, places: 0, objects: 0 },
    provider: '', model: '',   // what was used, so the banner can say "failed with X"
    at: null,                  // ISO timestamp
  }
  ```

### 4. Stamp it from both extraction paths
- `server/services/pipeline/textStages.js` (auto, after prose) — replace the
  `.catch(console.warn)` with: on resolve stamp `ok`/`partial` (+ failedKinds,
  counts, provider/model); on reject stamp `failed` (+ error). Still **non-fatal**
  to the prose write.
- `server/routes/pipeline.js` `POST /issues/:id/stages/:stageId/extract-canon`
  — **allow `prose`** in addition to `comicScript`/`teleplay`; add `model` to
  `extractCanonFromScriptSchema`; pass `providerOverride` + `modelOverride` to
  `extractCanonFromProse`; after extraction **stamp
  `issue.stages.<stageId>.canonExtraction`** (single source of truth) and
  include the updated `issue` + `failures` in the response (alongside the
  existing `universe`, `extracted`, `truncated`).

This routes the Nouns manual extract through the **pipeline** endpoint (which
knows the issue) instead of the universe endpoint, so the marker is stamped
server-side for both auto and manual paths.

## Client

### 5. API wrapper (`client/src/services/apiPipeline.js`)
- `extractPipelineCanonFromScript(issueId, stageId, { providerOverride, model })`
  — add `model`; the existing param already carries `providerOverride`. Allow
  `prose` as a stageId (just a string passthrough).

### 6. Nouns stage UI (`client/src/components/pipeline/stages/NounsStage.jsx`)
- Switch `handleExtract` from `extractUniverseCanon(universe.id, …)` to the
  pipeline endpoint with `stageId='prose'`, passing the chosen provider/model.
  Use the returned `universe` (setUniverse) and the returned `issue`'s
  `stages.prose.canonExtraction` to drive the banner.
- Add a compact **provider/model picker** next to "Extract from prose",
  defaulting to `series.llm` (provider+model), letting the user override per
  attempt. Reuse the dropdown pattern from
  `client/src/components/pipeline/SeriesLlmPicker.jsx` (load via `getProviders`,
  "Active provider" / "Default model" empty options) — extract a small local
  presentational picker (local state, not persisted to the series) rather than
  re-saving `series.llm`.
- Render a **persisted failure/partial banner** from
  `issue.stages.prose.canonExtraction` (seed local state from the prop, update
  it from each attempt's response): e.g. *"Object extraction failed with Codex /
  default: <error>. Pick a different provider/model and retry."* Use
  `port-warning` styling for `partial`, `port-error` for `failed`. Hidden when
  `status === 'ok'` or never attempted.
- Toast on retry already exists; extend to mention failed kinds when partial.

## Tests
- `server/services/universeCanon.test.js` — add: one kind rejecting still merges
  the others and returns `failures`; all kinds rejecting throws; `modelOverride`
  is forwarded.
- `server/routes/pipeline.test.js` — `prose` is an accepted stageId; `model`
  passthrough; response includes the stamped `canonExtraction`; failure path
  stamps `failed`.
- `server/services/pipeline/issues.test.js` (or wherever sanitizeStage is
  covered) — `canonExtraction` round-trips through sanitize and defaults to the
  empty/`null` shape.

## Verification
1. `cd server && npm test` (universeCanon, pipeline route, issues sanitize).
2. `cd client && npm test` (NounsStage if covered).
3. Manual: `npm run dev`, open a pipeline issue with a linked universe, generate
   prose, force a provider that refuses one kind (Codex) → confirm characters +
   places land, a **persisted** warning banner shows the failed kind + error,
   reload the page and the banner is still there, then pick Claude/Gemini in the
   picker and retry → objects extract, banner clears.

## Notes / out of scope
- The Codex safety-refusal + Claude `401` are *provider* problems; this work
  surfaces and recovers from them, it doesn't fix the providers themselves
  (those already spawn "AI provider investigation" tasks — see logs).
- The universe-builder `POST /:id/extract-canon` route (used by the standalone
  Universe Builder page) is left as-is; only the Nouns/pipeline path gets the
  marker + picker. Adding the picker there is a possible follow-up
  (capture in `PLAN.md` if deferred).
