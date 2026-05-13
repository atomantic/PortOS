# Creative Director / Pipeline Polish Batch — 2026-05-10

## Goal

Finish the in-flight CD/pipeline polish work tracked in `PLAN.md` by running 6 mechanical/independent items as parallel sub-agents in worktree isolation, then resolving 3 design-input items interactively.

## Out of scope

- Writers Room Phase 4 (synced prose/script/media review) & Phase 5 (realtime CD feedback) — separate brainstorms later.
- Pipeline Story Arc Planning (Phases 1–5) — separate initiative.
- "Pipeline — Deferred" section items (scene-video render, prose rich-text editor, versioning, sidebar children, voice nav, panel progress, PDF export).

## Parallel batch (6 sub-agents, `isolation: worktree`)

| # | PLAN.md item | Files touched | Type |
|---|--------------|---------------|------|
| 1 | WR↔Pipeline **2a** `bibleStore` factory | `server/lib/storyBible.js` (extend) + collapse `server/services/writersRoom/{characters,settings,objects}.js` to ~15 LOC each | refactor (-250 LOC target) |
| 2 | WR↔Pipeline **2b** shared zod bible schemas | `server/lib/validation.js` (re-export), `server/routes/pipeline.js` (extend instead of `z.record(z.string(), z.any())`) | refactor |
| 3 | WR↔Pipeline **4c** `useAsyncAction` hook | new `client/src/hooks/useAsyncAction.js` + 4 stage components (`ProseStage`, `TextStagePanel`, `StoryboardsStage`, `EpisodeVideoStage`) | refactor |
| 4 | LTX FFLF UI hint | `client/src/pages/VideoGen.jsx` ~L917 | text |
| 5 | LTX deprecate notapalindrome | `server/lib/mediaModels.js` (add `deprecated: true` on `ltx2_unified`, `ltx23_unified`, `ltx23_distilled_q4`) | config |
| 6 | CD dedup-spawn fix | `server/services/agentLifecycle.js:114` + new test | bugfix |

**Conflict map:** zero overlap between any pair. All can land independently.

## Landing strategy

1. Dispatch all 6 in a single message with `isolation: "worktree"`. Each agent:
   - Makes the change.
   - Runs `cd server && npm test` (server-touching items) or the existing client check (client-touching items).
   - Commits to its worktree branch.
   - **Does NOT push. Does NOT open a PR.**
2. After all 6 return, merge each worktree branch into local `main` sequentially.
3. Run the full server test pack on `main` to catch cross-agent integration breakage.
4. `/simplify` on combined diff. Apply findings.
5. `/do:review` on combined diff. Apply findings.
6. Push to `main` (or single consolidated PR — decide once we see the diff).

## Interactive items (TUI session after batch lands)

- **CD audio continuity.** Pick strategy: (a) silent-render scenes + single backing audio pass at stitch time, or (b) `acrossfade` filter in `videoTimeline/local.js#buildFfmpegArgs` extending the existing video crossfade.
- **CD render slowness.** Need profile data from a real long session — add timing logs around the slow path, run sustained, then diagnose.
- **LTX FFLF deep test.** Manual: pick a real keyframe pair from same scene/camera, render, judge output together.

## Risks

- **Cross-agent integration breakage** between 2a (factory shape) and 2b (schema names) — caught by the post-merge full test pack on `main`.
- **4c client conflicts** if user edits any of the 4 pipeline-stage components mid-flight. User holds those files during agent run.
- **`deprecated: true` rendering** — agent 5 may need to also flip the model dropdown UI to group deprecated models into a "Legacy" section. Agent prompt instructs it to ship the UI change if the dropdown doesn't already render based on a `deprecated` flag.

## Why no per-agent PRs

Standard flow is each task → own PR → Copilot review. Trades 6 small Copilot rounds for one local quality pass via `/simplify` + `/do:review`. Faster end-to-end, single review surface, agents stay focused on the change itself (not the PR ceremony).
