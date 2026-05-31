# Non-linear generation: backport across pipeline stages & Story Builder steps

## Context

Today both the **Create Series Pipeline** and the **Story Builder** are strictly
*forward-only*. Each generation step assumes its source is the conventional
upstream artifact:

- Pipeline text stages (`idea → prose → comicScript → teleplay`) are wired so
  `buildStageContext()` (`server/services/pipeline/textStages.js:53`) only ever
  includes stages *before* the current one (`if (id === stageId) break;`), and
  each prompt template hardcodes one source slot (`{{seed}}`, `{{stages.idea.content}}`,
  `{{stages.prose.content}}`).
- Story Builder gates every step behind `isStepReachable()`
  (`server/services/storyBuilder.js`), which hard-throws `409` unless **every**
  earlier step is locked + not stale; its generators only pull from their
  conventional upstream (seed → idea → aesthetic → arc → readerMap).

The user often has work that was authored out of order — e.g. a series that
*started* as a drafted comic book. They want to **backfill the prior steps** to
evaluate whether the story is complete: generate prose from a comic script,
synthesize the idea/arc from issues that already have comic scripts, etc.

**Goal:**
1. **Pipeline** — each stage's Generate button offers a **multi-select source
   picker** listing only the stages that currently have content (never the target
   itself), with the conventional forward source pre-checked. Generation feeds
   the chosen sources into the LLM.
2. **Story Builder** — relax the hard lock-gate to advisory, and make the
   upstream generators able to **pull from existing downstream content** (the
   series' issues' comic-script/prose) — reusing the importer's extraction
   prompts — so you can start from a comic script and backfill idea/arc.

Decisions confirmed with the user: scope = **Pipeline + Story Builder gating**;
pipeline source picker = **multi-select with smart (conventional-forward)
default**; Story Builder = **generate upstream from downstream** (full backfill,
not just navigation unlock).

---

## Part 1 — Pipeline text-stage source picker

### 1a. Server: source-agnostic context (`server/services/pipeline/textStages.js`)

`buildStageContext({ series, canon, world, issue, stageId, seedInput, sourceStageIds })`:

- **Keep** the existing forward-only `stages` object exactly as-is. Customized
  installs whose prompts still reference `{{stages.idea.content}}` /
  `{{stages.prose.content}}` must keep working (these prompts are NOT migrated for
  customized installs — see 1c).
- **Add** a new `sourceMaterials` array to the returned context:
  ```js
  // selected = explicit sourceStageIds if provided & non-empty, else the
  // conventional forward-prior stages that have content (mirrors today's default)
  sourceMaterials: selected.map((id) => ({
    stageId: id,
    label: STAGE_LABELS[id],              // reuse existing STAGE_LABELS map (line 22)
    content: contentOf(issue.stages?.[id]) // input?.trim() || output?.trim() || ''
  })).filter((s) => s.content)
  ```
  - When `sourceStageIds` is omitted/empty → default to the forward-prior stages
    with content (so `autoRunner.js`, which calls `generateStage` with no
    `sourceStageIds`, is byte-for-byte unchanged in behavior).
  - When provided → validate each id is a `TEXT_STAGE_IDS` member, is **not** the
    target `stageId`, and has content; silently drop any that fail (or throw 400 —
    pick throw for explicit user requests).
- `generateStage(issueId, stageId, options)` passes
  `sourceStageIds: options.sourceStageIds` into `buildStageContext`.

### 1b. Server route (`server/routes/pipeline.js`)

Extend `generateSchema` (~line 350):
```js
sourceStageIds: z.array(z.enum(['idea', 'prose', 'comicScript', 'teleplay'])).optional(),
```
The handler already spreads the validated body into `generateStage` — no further
route change. `client/src/services/apiPipeline.js` `generatePipelineStage` already
forwards arbitrary `opts`, so no client-API change.

### 1c. Prompt templates + migration

All four templates (`data.reference/prompts/stages/pipeline-{idea-expansion,prose,
comic-script,teleplay}.md`) currently hardcode one source slot. Replace that slot
with a generic, source-agnostic block and make the task wording source-neutral:

```md
{{#sourceMaterials}}
## Source material — {{label}}
{{content}}

{{/sourceMaterials}}
```
- For `pipeline-idea-expansion.md`: keep the `{{seed}}` block (rough idea) AND add
  the `sourceMaterials` block (so the beat sheet can also be synthesized from an
  existing prose/comic/teleplay).
- Reword task lines from "adapting a beat sheet"/"adapting a prose story" to
  "adapting the provided source material" so the prompt reads correctly whichever
  source(s) are supplied.

Because `scripts/setup-data.js` only copies *missing* prompts, ship a migration
following the canonical pattern in `scripts/migrations/003-update-pipeline-stage-prompts.js`:
new file `scripts/migrations/0NN-pipeline-stage-prompts-source-agnostic.js`
(next free number after the highest in `scripts/migrations/`). For each of the 4
files: if the installed copy's md5 (line-ending-normalized) matches the
**pre-change shipped hash**, overwrite with the new shipped version; otherwise
leave the user's customization untouched. Mirror both `OLD_SHIPPED_MD5` and
`NEW_SHIPPED_MD5` into the drift warning in `scripts/setup-data.js` so it stays
actionable (per CLAUDE.md "Stage-prompt template changes need a migration").

### 1d. Client UI (`client/src/components/pipeline/stages/TextStagePanel.jsx`)

- Compute available sources: iterate the text stage order
  (`['idea','prose','comicScript','teleplay']`), exclude the current `stageId`,
  keep those with `input?.trim() || output?.trim()`.
- Render a compact **multi-select** (checkbox row or chips) labeled "Generate
  from:" above the Generate button, listing only available sources, using
  `PIPELINE_STAGE_LABELS` (`client/src/lib/pipelineStages.js`) for labels.
  - Default-checked = the conventional forward source(s) that exist (e.g. for
    `prose` → `idea`; for `comicScript`/`teleplay` → `prose`). If none of the
    conventional sources exist, leave all unchecked and let the user pick.
  - Hide the picker entirely when no other stage has content (fresh issue) — the
    panel then behaves exactly like today.
- Track selection in local state; pass `sourceStageIds: selected` in the
  `generatePipelineStage(issue.id, stageId, { ... })` call.
- Update `PLACEHOLDERS` / `HELP_TEXT` copy to stop asserting a fixed source
  ("Generated from the prose draft above" → "Generated from the selected source").

### 1e. Tests

`server/services/pipeline/textStages.test.js`:
- Default (no `sourceStageIds`) still produces the forward-only `sourceMaterials`
  and matches prior behavior.
- Backport: target `prose` with `sourceStageIds:['comicScript']` puts the comic
  script content into `sourceMaterials` and omits `idea`.
- Invalid source (target===source, or empty stage) is rejected/dropped.

`server/routes/pipeline.test.js`: `sourceStageIds` accepted by `generateSchema`;
bad enum value 400s.

---

## Part 2 — Story Builder: backfill upstream from downstream

### 2a. Relax the reachability gate (advisory, not hard block)

In `server/services/storyBuilder.js`:
- `generateStep()` currently throws `409` when `!isStepReachable(session, stepId)`.
  Change so the lock check (`step.locked` → 409) **stays**, but the
  upstream-incomplete condition no longer blocks generation. Keep
  `isStepReachable()` and surface its result to the client (already returned in
  session/step payloads) as an advisory `reachable`/`stale` flag the UI renders as
  a warning badge — do **not** throw on it.
- The stepper UI (`client/src/pages/StoryBuilder.jsx`) should allow clicking into
  any non-locked step and show a "upstream not locked / may be stale" warning
  instead of disabling it.

### 2b. Backfill-capable generators (pull from existing issue content)

The Story Builder generators (`STEP_GENERATORS` in `storyBuilder.js`) operate at
universe/series level. Add an optional `fromDownstream` path so `idea` and
`plotArc` can synthesize from the series' existing issue content when upstream is
empty:

- Add a helper that collects source text from the session's series issues via
  `getIssuesForSeries(session.seriesId)` (already imported, line 10): concatenate
  each issue's most-authored text stage (prefer `comicScript`, else `teleplay`,
  else `prose`, else `idea`) with a per-issue label, capped to a sane size.
- **`plotArc` generator:** when `options.fromDownstream` (or when no arc exists yet
  but issues do), feed that collected issue content into arc generation. Reuse the
  importer's arc-extraction prompt (`importer-arc-extract.md`) — the importer
  already reverse-engineers `{logline, summary, seasons[...]}` from a finished
  work; route through the same extraction service the importer uses
  (`server/services/importer.js`) rather than duplicating the prompt call. Persist
  to `series.arc` / `series.seasons` exactly as the forward `generateArcOverview`
  path does.
- **`idea` generator:** when backfilling, include the collected issue content as
  additional source in the `story-builder-idea-expand` prompt input (add an
  optional `sourceMaterial` field to `data.reference/prompts/stages/story-builder-idea-expand.md`,
  rendered only when present — migrate via the same migration mechanism as 1c).
- **characters / readerMap:** `characters` can already be backfilled by the
  importer's canon extraction (`importer-canon-extract.md`); `readerMap` derives
  from the (now backfillable) arc, so it works once arc exists. No new generator
  needed for these in this pass — note in PLAN.md if deeper backfill is wanted.

### 2c. Plumb the option through route + client

- `server/routes/storyBuilder.js`: add `fromDownstream: z.boolean().optional()`
  (and, if exposing source choice, an optional source descriptor) to the
  generate-step request schema; forward into `generateStep` options.
- `client/src/services/apiStoryBuilder.js` + `StoryBuilder.jsx`: when a step's
  conventional upstream is empty but downstream issue content exists, offer a
  "Backfill from existing issues" affordance on that step's generate control that
  sends `fromDownstream: true`.

### 2d. Tests

- `server/services/storyBuilder.test.js`: generating `plotArc` with
  `fromDownstream` on a session whose series has issues-with-comic-scripts but no
  arc produces a persisted arc; the reachability gate no longer throws 409 for an
  unlocked-but-explicitly-requested upstream step (only `locked` throws).
- `server/routes/storyBuilder.test.js`: new schema field accepted/validated.

---

## Compatibility notes (per CLAUDE.md)

- **Migrations required** for every shipped prompt change (1c, 2b idea prompt) —
  other installs/machines run this code and upgrade independently. Use the
  hash-gated rewrite pattern and update the `setup-data.js` drift warning.
- Keep `buildStageContext`'s legacy `stages` object so customized (un-migrated)
  prompts keep resolving.
- `autoRunner.js` must remain behaviorally unchanged (it calls `generateStage`
  with no `sourceStageIds` → default forward sources).
- No sync/schema-version payload changes expected (Story Builder sessions are
  local-only; pipeline issue shape is unchanged — only generation *inputs* change).

## Verification

1. `cd server && npm test` (textStages, pipeline route, storyBuilder service+route).
2. `cd client && npm test` (TextStagePanel / StoryBuilder component tests).
3. Manual via `npm run dev`:
   - Pipeline: open an issue that has only a comic script; on the Prose stage the
     source picker lists "Comic Script" (and Teleplay if present), Idea is absent.
     Generate → prose is produced from the comic script. Verify the Idea stage can
     be generated from prose/comic (backport).
   - Story Builder: import or hand-build a session whose series has issues with
     comic scripts but no arc; confirm you can enter the Plot Arc step despite
     upstream being unlocked, click "Backfill from existing issues", and get a
     populated arc; confirm a locked step still refuses regeneration.
4. Migration: on a copy of `data/` with the pre-change stage prompts, run the
   migration and confirm only unmodified prompts are upgraded; customized ones are
   left intact and flagged by the drift warning.
