# PortOS — Development Plan

For project goals, see [GOALS.md](./GOALS.md). For completed work, see [DONE.md](./DONE.md).

---

## Next Up

1. **Voice agent next power-ups** — `ui_read` (extract visible page text so "what does this say?" works without hand-navigation), destructive-action confirmation gate (pause and require spoken "confirm" when `ui_click` matches `/delete|remove|discard|reset|clear/i`), proactive CoS speech (server-pushed voice with quiet-hours policy + barge-in contract).

## Backlog

### Creative Director follow-ups

The pipeline now has multi-frame evaluation, auto-accept watchdog, cheap smoke fixture, and per-scene `imageStrength` continuation anchoring (see DONE.md). Remaining targets surfaced by the long E2E run:

- [ ] **Whole-episode audio generation strategy.** mlx-video-with-audio generates audio per-clip and the resulting scene-level mini-soundtracks are abruptly different from each other — even a perfect xfade boundary won't fix it (it's like a DJ mixing five unrelated songs). The architectural answer is to STOP relying on per-clip audio and instead drive audio generation from the *whole-episode arc*. Scope of the eventual design:
  - **Source of truth.** The episode's prose/script/storyboards (already in the pipeline data model) define the arc — beats, tone shifts, scene durations. An audio generator should consume this, not the per-clip video output.
  - **Generator candidates.** Suno API (commercial, has duration control), MusicGen-MLX (local, but bounded to ~30s without stitching), AudioLDM2, or a multi-track approach (separate music + ambient + foley layers).
  - **Stitch path change.** `server/services/creativeDirector/stitchRunner.js` after timeline render: strip per-clip audio (`-c:v copy -an`), then a second ffmpeg pass overlays the generated track. New project-level `audioMode: 'per-clip' | 'silent' | 'generated' | 'uploaded-track'`. PLAN today's `'per-clip'` stays the default so existing projects don't regress.
  - **UX.** `EpisodeVideoStage.jsx` toolbar gets an "Audio" dropdown beside aspectRatio/quality. "Generated" kicks off the audio gen as part of the stitch pipeline; "Uploaded" opens a file picker.
  - **Investigation needed first** — pick a generator. Suno has the cleanest UX (give it a vibe prompt + duration); MusicGen-MLX is local but needs sliding-window stitching to exceed 30s; AudioLDM2 is older. ~150 LOC for the stitcher change once the generator is picked; the bigger question is which model and how to prompt it from script-level arc metadata. Treat this as a new sub-brainstorm when we pick it up — not a same-PR fix.
- [ ] **Render slowness on long sessions.** Per-scene render time degraded from ~3.5 min (early) to 10–30 min (late) within one project — likely accumulated listeners + queue races. Profile after sustained use; the round-22 dedup work probably already helps; verify.

### LTX-2.3 dgrauet runtime — wire native modes

The dgrauet/ltx-2-mlx runtime ships with FFLF (true keyframe interpolation), audio-to-video, and native video Extend (see DONE.md 2026-05-06). Remaining gaps:

- [ ] **Native FFLF deeper test on real keyframe pairs.** FFLF wiring is verified on synthetic ball-motion keyframes (commit `ef5d9081`). Validate with REAL pairs: take last frame of clip A + first frame of clip B from the same scene/camera, render an interpolation, confirm temporally-coherent transition. If it looks weak even on similar keyframes, file a follow-up to expose more pipeline knobs in the UI (cfg-scale, stg-scale, stage1-steps).

### Other backlog

- [ ] **Writers Room (Phase 4–5)** — Phases 1–3 shipped (authoring core, storyboard companion, character/world/objects bibles, per-stage LLM picker, paragraph-grain Adapt, auto-queue scene image gen, Read view + render dock). Remaining: Phase 4 synced prose/script/media review, Phase 5 realtime CD feedback. See [writers-room.md](./docs/features/writers-room.md). Phase 4 now lands on the unified bible/scene model that the DRY-unification work (DONE.md 2026-05-10) brought in.
- [ ] **Voice CoS tool expansion** — `calendar_today` / `calendar_next` (Google Calendar via existing MCP), `meatspace_log_workout` (wraps `meatspaceHealth.js`), `weather_now` (needs API choice — OpenWeather / WeatherKit / NWS), `timer_set` (reuses `agentActionExecutor.js` scheduled actions).
- [ ] **Voice agent vision fallback** — `ui_describe_visually` tool: screenshot the current tab (or a named canvas/chart) and send to a vision-capable model so "what's on this chart?" works on non-DOM content (CyberCity, graph views). Depends on a vision provider in `portos-ai-toolkit`.
- [ ] **Voice agent — explicit long-term memory routing** — pipeline already routes capture verbs to `brain_capture`. Remaining: on retrieval-shaped voice turns, inject top-N relevant memories into the system prompt via `brain_search` so it's self-improving rather than ambient.
- [ ] **CyberCity v2 — Phase 2+** — Phase 1 operational legibility shipped (per-building health glyphs, attention pane, search overlay, filter chips, hover quick-actions, mobile). Remaining: deeper drill-down (per-agent spatial trail, system flow lines between buildings, recent-action timeline overlay). See [cybercity-v2.md](./docs/features/cybercity-v2.md).
- [ ] **M50 P9 — CoS Automation & Rules** — Automated email classification, rule-based pre-filtering, email-to-task pipeline.
- [ ] **M50 P10 — Auto-Send with AI Review Gate** — Per-account/per-recipient trust level + dual-LLM review (drafter + reviewer). Only auto-send when both approve or trust ≥ 0.9. See [Messages Security](./docs/features/messages-security.md).
- [ ] **M34 P5-P7 — Digital Twin** — Multi-modal capture (voice/video/image identity sources), advanced testing, personas. Ties to GOALS.md secondary "Multi-Modal Identity Capture".
- [ ] **Multi-reference image editing for FLUX.2** — UI on the Image Gen page that accepts 2+ reference images plus an edit prompt (e.g. "put the subject from image A into the scene from image B"). When this lands, swap the model registry's 9B entry to [`black-forest-labs/FLUX.2-klein-9B-kv`](https://huggingface.co/black-forest-labs/FLUX.2-klein-9B-kv) — KV-cache optimization gives up to 2.5× speedup on multi-reference workflows. Work involves: schema for multi-image payload (`referenceImages: [...]`), client multi-uploader, server FormData parsing, and adapting `flux2_macos.py` to call the multi-reference pipeline API. Separately-gated repo on HF — user must request access.
- [ ] **World Builder Phase 2 — external SD-API + per-bucket model overrides.** The shipped batch render only supports local mflux + Codex. Wire the existing external SD-API providers (Together, Replicate, Fal) into the world-builder batch path so high-end renders are practical, and let each bucket pick its own model (e.g. characters → SDXL portrait LoRA, environments → Flux-pro). Single touchpoint: `server/services/worldBuilder.js#compileBatchPrompts` + `worldBuilderCollectionHook.js`. (Surfaced from PR #211 follow-ups.)
- [ ] **Unify VideoGen.jsx RESOLUTIONS with the shared image-gen list** — `client/src/pages/VideoGen.jsx:54` defines its own private `RESOLUTIONS` array + finds-by-w/h block, duplicating the pattern in `client/src/lib/imageGenResolutions.js`. Move VideoGen's presets into a shared `client/src/lib/videoGenResolutions.js` (or extend `imageGenResolutions.js` with a `media: 'image' | 'video'` field) so the dropdown + custom-fallback logic only lives in one place. Surfaced during the codex hi-res / per-backend filter work — `filterResolutions(mode, runner)` is exactly the helper VideoGen will want once mlx-video models gain runner-specific size constraints.
- [ ] **Extract `useSwipeNav` hook + `lib/clipboard.js`** — `MediaLightbox.jsx` hand-rolls touch-swipe nav (SWIPE_MIN_PX / TAP_MAX_PX / horizontal-dominant guard) and `navigator.clipboard.writeText` is inlined across 8+ call sites (`ExportTab`, `EditAppModal`, `NextActionBanner`, `JiraReports`, `RapidReader`, `Shell`, `RunsHistoryPage`, `MediaLightbox`). Extract once a second swipe consumer appears; clipboard can move now (`copy(text, label)` with the existing "insecure context" toast). Surfaced from the lightbox full-screen pass.
- [ ] **Route `MediaLightbox` settings drawer through `components/Drawer.jsx`** — In full-screen mode the lightbox renders a hand-rolled aside (`absolute top-0 right-0 bottom-0 w-full sm:w-96 z-20`) that is exactly the project's existing `Drawer` component. Skipped during the simplify pass because `Drawer`'s flat Esc handler conflicts with the lightbox's layered Escape cascade (drawer → fullscreen → close); reconcile by either lifting the cascade above `Drawer` or letting `Drawer` accept a no-op-Esc prop.
- [ ] **Extract `<ModelSelect>` component for the active+Legacy optgroup pattern** — `client/src/pages/VideoGen.jsx` and `client/src/pages/CreativeDirector.jsx` both render an identical "filter(!deprecated).map + optgroup('Legacy') + filter(deprecated).map" block (differ only in `m.name` vs `m.name || m.id`). Extract `client/src/components/ModelSelect.jsx` taking `{ models, value, onChange, labelOf?, disabled? }` and convert both sites. ~30 LOC removal, and any future model dropdown picks up the deprecated-grouping for free. Surfaced from the LTX-deprecate /simplify pass.
- [ ] **Extract `mockPathsDataRoot()` test helper** — `server/lib/storyBible.test.js`, `server/services/writersRoom/{characters,settings,objects,local,promoteToPipeline}.test.js` (6 files) all open with byte-identical setup: `let tempRoot; vi.mock('../../lib/fileUtils.js', async () => { const actual = await vi.importActual(...); return new Proxy(actual, { get(t,p){ if (p==='PATHS') return new Proxy(actual.PATHS,{get(tp,pp){ if(pp==='data') return tempRoot; ... }}); ... } }); }); beforeEach(() => { tempRoot = mkdtempSync(...) }); afterEach(() => rmSync(tempRoot, { recursive: true, force: true }))`. Extract into `server/test-utils/tempDataRoot.js` exposing `mockPathsDataRoot()` that returns a live tempRoot getter. ~20 LOC saved per file plus a single fix-point if PATHS mocking semantics ever change. Surfaced from the bibleStore-factory /simplify pass.
- [ ] **Widen `spawningTasks` try/finally in `agentLifecycle.js#spawnAgentForTask`** — pre-existing bug surfaced during /do:review. Today's try/finally (`server/services/agentLifecycle.js:536-547`) only wraps the spawn call itself. Between `spawningTasks.add(task.id)` (line 134) and the try-block, the function does ~400 lines of async work — `buildAgentPrompt`, `writeFile(prompt)`, `createAgentRun`, `registerAgent`, etc. — each of which can throw (ENOSPC, EACCES, network). A throw on any of those paths leaves `spawningTasks` registered FOREVER, permanently blocking future spawns of that task id. The detected-error paths call `cleanupOnError` which does delete, but an unhandled throw is the gap. Fix: hoist the try/finally up to wrap from line 134 (after `add`) through the spawn calls. `cleanupOnError`'s redundant `spawningTasks.delete` becomes a no-op (Set.delete on absent key) which is fine. Pre-existing bug, not introduced by the dedup-race fix.
- [ ] **`useAsyncAction` post-unmount setState guard** — the hook in `client/src/hooks/useAsyncAction.js` calls `setRunning(false)` after an awaited async fn resolves. If the owning component unmounts mid-action, React 18 silently warns; React 17 surfaces the warning. Add a `mountedRef` (set true in mount effect, false in cleanup) and gate `setRunning(false)` on `mountedRef.current`. YAGNI for current call sites (all stable parent components) but worth doing once the hook gains a 4th consumer or any consumer that unmounts during long-running ops. Surfaced from /do:review.
- [ ] **Extract `CollectionPickerShell` from `AddToCollectionMenu` + `BulkTargetPicker`** — both files (`client/src/components/media/AddToCollectionMenu.jsx`, `client/src/components/media/BulkTargetPicker.jsx`) own a near-identical portal popover: same `MENU_WIDTH/GAP/VIEWPORT_PADDING/SEARCH_THRESHOLD` constants, line-for-line identical reposition math, identical click-away + Esc + rAF-scroll effects, identical "new collection" footer form. The only differences are local to the list row (membership-toggle w/ check vs single-pick) and the create-success path (add-after-create vs pick-after-create). Extract `<CollectionPickerShell anchorRef, title, busy, onClose, renderRow, onCreate>` that owns positioning/portal/search/create-form; each picker becomes a ~40-line `renderRow` function. Two files isn't a fire; a third would force this. While extracting, also accept a `collections` prop (optional, falls back to internal fetch) so `MediaCollectionDetail` can pass its already-fetched list and avoid the per-mount `listMediaCollections` round-trip when the user toggles Move/Copy. Surfaced from the bulk-actions /simplify pass.
- [ ] **Server-side bulk endpoint for collection items** — `MediaCollectionDetail`'s bulk Move/Copy/Remove currently makes N sequential HTTP calls (server has no per-collection lock, so parallel writes would lose updates on the JSON read-modify-write). At ~30ms localhost RTT, 20 items ≈ 600ms; 50 items ≈ 1.5s (move = 2 × that). The user's stated use case is "select all" on a world-builder collection that could legitimately have 50+ items. Add `POST /api/media/collections/:id/items/bulk` taking `{ add: [{kind,ref}], remove: [key] }` and doing one read-modify-write per collection. Halves wall-clock for Move (single source-side commit instead of N), dodges the race window entirely. Surfaced from the bulk-actions /simplify pass.
- [ ] **Drop legacy `description` fallback in `sanitizeCharacter`** — `server/lib/storyBible.js:130` carries an inline `TODO(item-4): drop the description fallback once pipeline characters extract natively.` Item 4 (shared bible-extraction service) shipped 2026-05-10 — extraction now writes the canonical `physicalDescription` field directly. Plan: write a one-shot migration that rewrites every `series.characters[].description` → `physicalDescription` in `data/pipeline-series.json` (idempotent: skip entries that already have `physicalDescription`), drop the `|| raw.description` fallback at `storyBible.js:137`, and remove the TODO comment. Audit `data.sample/` + tests for any remaining `description` reads before merging.

### Civitai LoRA / Z-Image-Turbo follow-ups (from /simplify pass)

These were flagged by the post-merge code review pass on the Z-Image + Civitai LoRA work but deliberately deferred to keep the original PR scoped.

_All items in this section have shipped — see DONE.md → 2026-05-12 for the
"Civitai / Z-Image follow-ups — six post-merge cleanups" entry and the
`scripts/_runner_common.py` extraction entry._
- [ ] **Project-wide `<Modal>` component** — every modal in the app (`Flux2InstallModal`, `EditAppModal`, `MemoryEditModal`, `ResumeAgentModal`, `MediaLightbox`, `LayoutEditor`, `KeyboardHelp`, `RapidReader`, `DeployPanel`'s confirm, the new `CivitaiAuthModal` in `Loras.jsx`) rolls its own `fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4` backdrop + click-outside + close-button + ESC handler. Extract `client/src/components/ui/Modal.jsx` with backdrop + dialog props and a slot for the body, then convert all call sites. ~300 LOC of duplicated chrome across the codebase.

- [ ] **Extract shared `runPromptThroughProvider` runner-wrapper** — four near-identical "create run → branch on provider.type → executeCliRun/executeApiRun → accumulate text → reject on error" implementations now exist: `server/services/mediaPromptRefiner.js#runRefinePrompt`, `server/services/messageEvaluator.js#runPrompt`, `server/lib/stageRunner.js#awaitRunnerCall`, `server/services/worldBuilderExpand.js#callLLM`. Promote into `server/lib/promptRunner.js` returning `{ text, runId }`, then collapse the four sites. Failure-handling drift is already visible (some reject on `success === false`, some only on `error`) — the unified version should pick the stricter discriminator. Surfaced from the Refine Prompt /simplify pass.

- [ ] **Promote `findBalancedBlocks` + `tryParseWithRepair` to `server/lib/jsonExtract.js`** — `server/services/worldBuilderExpand.js:132-235` (with trailing-comma + Codex `}}]` repair + `[...]` placeholder cleanup), `server/services/mediaPromptRefiner.js#extractRefinementJson` (string-aware brace walker), and `server/lib/stageRunner.js#extractJson` (greedy regex) all solve the same "extract JSON from CLI-banner-prefixed LLM output" problem. The richest implementation is in worldBuilderExpand; lift it out and have all three callers import it (with caller-specific shape predicates). Surfaced from the Refine Prompt /simplify pass.

- [ ] **Extend `normalize.js` to expose render-config fields** — `client/src/components/media/PromptRefineModal.jsx#getRenderConfig` reaches into `item.raw?.{cfgScale,loraFilenames,loraScales,steps (video),guidanceScale,seed,tiling,disableAudio}` because `normalizeImage`/`normalizeVideo` don't surface those fields. Either lift the snake_case/camelCase fallback chain into normalize.js so the modal reads from `item.*` only, or add `getRenderConfigForItem(item)` co-located with normalize so the sidecar field-naming knowledge lives in one file. Surfaced from the Refine Prompt /simplify pass.

### Better Audit follow-ups

- [ ] **[HIGH][CODE]** `server/services/cos.js:3113` — remove `NODE_ENV !== 'test' && VITEST !== 'true'` init guard (test-specific hack in prod boot path).
- [ ] **[HIGH][TESTS]** Create test files for `server/services/clinvar.js` and `server/services/telegramBridge.js`.
- [ ] **[HIGH][CODE]** Wrap `handleAgentCompletion` body in try/finally so the terminal `runnerAgents.delete(agentId)` (`server/services/agentLifecycle.js:1146`) always runs. Today a throw from `completeAgent` (line 939), `completeAgentRun` (line 949), `updateTask` (lines 954 / 960), or `processAgentCompletion` (line 987) aborts the function and leaks the runner-agents Map entry forever, blocking any retry. Tests added 2026-05-12 in `agentLifecycle.test.js` ("regression-pin" block) document the gap — once the wrap lands, those tests' `runnerAgents.has(...)` assertions flip and need updating. Sister fix to the open Backlog item "Widen `spawningTasks` try/finally in `agentLifecycle.js#spawnAgentForTask`" above.
- [ ] **[MEDIUM][CLIENT]** 4 components still redefine `formatBytes`/`formatTime`/`formatDuration`/`timeAgo`/`formatDate` locally instead of importing from `client/src/utils/formatters.js`: `pages/VideoTimelineEditor.jsx`, `pages/VideoTimeline.jsx`, `components/settings/MortalLoomTab.jsx`, `components/brain/tabs/ImportTab.jsx`. (Down from 8.)
- [ ] **[MEDIUM][PERF]** `server/services/feeds.js#getItems` (lines 303–319) — full-sort-then-paginate on every request. Pre-sort once at write time or maintain a per-feed index.
- [ ] **[MEDIUM][CODE]** Magic numbers in `cos.js:166,357`, `lmStudioManager.js:66`; brittle `err.message.startsWith('unknown piper voice:')` in `routes/voice.js:160` and `err.message.includes('not initialized')` in `services/visionTest.js:124`.

### Deferred Architecture (human-led planning)

- `server/services/cos.js` (3115 LOC) — split into cosTaskStore / cosTaskGenerator / cosJobScheduler / cosHealthMonitor.
- `server/services/agentLifecycle.js` (1446 LOC) — extract prepareAgentWorkspace / resolveProvider / processCompletion.
- `server/services/identity.js` (1917 LOC) — separate genomic markers + longevity + goals + todos.
- `server/services/taskSchedule.js` (2369 LOC) — extract prompt management to `taskPromptService.js`.
- `server/services/taskLearning.js` (1939 LOC) — separate metrics aggregation from heuristic routing.
- `server/services/autonomousJobs.js` (1567 LOC) — extract job registry / scheduler / execution paths.
- `server/services/voice/tools.js` (1284 LOC) — group by domain (UI control / calendar / brain / media) into sibling modules.
- `server/services/git.js` (1271 LOC) — extract command builders + parsers.
- `server/cos-runner/index.js` (1076 LOC) — extract spawn / lifecycle / IPC layers.
- `server/services/memory.js` (1049 LOC) — separate retrieval, classification, and persistence.
- `server/services/xcodeScripts.js` (1131 LOC) — collapse repeated AppleScript builders.
- `server/routes/apps.js` (1180 LOC) — extract `npm install` orchestration to `appBuilder.js`.
- `client/src/pages/VideoGen.jsx` (1361 LOC) — extract mode-specific control panels (i2v / a2v / extend / FFLF) into siblings.
- `client/src/pages/ImageGen.jsx` (1182 LOC) — extract preset picker + multi-reference uploader.
- `client/src/components/goals/GoalDetailPanel.jsx` (1252 LOC) — god component.
- `client/src/components/meatspace/tabs/CalendarTab.jsx` (1269 LOC) — extract grid renderer + goal-link panels.
- `client/src/components/cos/tabs/ScheduleTab.jsx` (1088 LOC) — extract schedule editor + run history table.
- `client/src/components/writers-room/StoryboardPanel.jsx` (1199 LOC) — extract scene tile + render dock subcomponents.
- `autofixer/ui.js` (972 LOC) — inline HTML template needs extraction.
- API contract — standardize error response shapes (`asyncHandler` + `ServerError` everywhere).

**Known low-severity:** pm2 ReDoS (GHSA-x5gf-qvw8-r2rm) — no upstream fix, not exploitable via PortOS routes.

### Depfree audit

All dependencies audited and justified (2026-04-28). 0 removals. See [docs/DEPS.md](./docs/DEPS.md) for the full classification table and per-package rationale.

---

## Future Ideas

- **Identity Context Injection** — Per-task-type digital twin preamble toggle.
- **Content Calendar** — Unified calendar across platforms.
- **Goal Decomposition Engine** — Auto-decompose goals into task sequences.
- **Knowledge Graph Visualization** — Extend BrainGraph 3D to full knowledge graph.
- **Autobiography Prompt Chains** — LLM follow-ups building on prior answers.
- **Legacy Export Format** — Identity as portable Markdown/PDF.
- **Workspace Contexts** — Project context syncing across shell, git, tasks.
- **Inline Code Review Annotations** — One-click fix from self-improvement findings.
- **Major Dependency Upgrades** — React 19, Zod 4, PM2 6, Vite 8.
- **Dynamic Skill Marketplace** — Self-generating skill templates from task patterns.
- **Workflow tab Phase 2** — drag-and-drop ordering of stages, custom user-defined stages, per-app workflow overrides. Builds on the new `/cos/workflow` pipeline.

---

## Writers Room ↔ Pipeline DRY Unification

Steps 1–7 shipped (see DONE.md 2026-05-10). The Writers Room and Pipeline now share one scene-prompt composer, one story-bible schema + sanitizer, one staged-LLM runner, one bible-extraction service, one scene-list extractor, a one-way promote bridge, and a partials-aware prompt template engine. Remaining follow-ups live in the dedicated items above (drop legacy `description` fallback; `mockPathsDataRoot()` test helper; `useAsyncAction` post-unmount guard).

---

## Pipeline — Story Arc Planning (shipped Phases 1–4)

Initiative shipped 2026-05-10 (see DONE.md). The PipelineSeries page now has a two-pane layout (sticky bible sidebar + Arc → Season → Episode canvas), the data model carries `series.arc` + `series.seasons[]` + `issue.seasonId` + `issue.arcPosition`, three LLM passes drive arc / per-season-episodes / cross-season verification, and the `ArcCanvas` UI surfaces all of it.

**Original Phase 5 (deferred — observe first):** Inject a `seasonContext` variable (current season synopsis + last 1–3 episodes' loglines) into the per-episode prose/script stage prompts via `server/services/pipeline/textStages.js#buildStageContext`. The macro continuity is already implicit in the planning artifacts (`series.arc.protagonistArc`, the season synopses generated upfront by `pipeline-arc-overview`, and the episode's idea-stage seed from `pipeline-season-episodes`), and the bible system already enforces character/setting consistency. Revisit only if executed per-episode prose starts contradicting adjacent episodes in practice.

**Out of scope (explicit non-goals):**

- Per-season independent media collections (one folder per season). The collection model is already per-series; per-season splits add UX complexity without clear value.
- Multi-series arcs (a season that spans two related series). Single-series scope keeps the data model flat and the LLM context bounded.
- Auto-promoting an existing flat list of issues into seasons. Users opt in via "Generate arc"; existing issues stay un-grouped (`seasonId: null`) until the user moves them.
- Drag-and-drop reorder of episodes within / between seasons (Phase 4b). Hover-revealed season picker on each episode covers manual cross-season moves; revisit if users hit reorder pain inside a single season.

---

## Pipeline — Deferred

Skeleton landed in `server/services/pipeline/` + `client/src/pages/Pipeline*.jsx`. The core text-to-video creative pipeline is now wired end-to-end (idea → prose → scripts → storyboards → episode video via CD handoff). Items below were scoped out and live here so they don't evaporate:

- [ ] **Wire `storyboards` scene-video rendering** as a separate path from the episode-video handoff. Currently storyboards records `imageJobId` per scene; add optional `sceneVideoJobId` so a user can render an individual scene's video without committing the full episode-video stitch.
- [ ] **Rich-text editor for prose stage.** Currently a plain `<textarea>` in `client/src/components/pipeline/stages/ProseStage.jsx`. Either reuse `client/src/components/writers-room/` editor, or pick a minimal markdown editor.
- [ ] **Versioning / diff view per stage.** No history right now — regenerating overwrites. Could persist last N `lastRunId` snapshots and offer a diff modal.
- [ ] **Episode-video provider picker (RunwayML / third-party).** Stubs are commented in `server/services/videoGen/`. Once that abstraction lands, the `episodeVideo` handoff should expose a provider picker on the EpisodeVideoStage UI (local LTX vs Runway vs …).
- [ ] **Comic-book PDF export.** Once `stages.comicPages` carries enough panel data + rendered images, export a print-ready PDF.
- [ ] **Voice-controlled stage advancement.** "Next stage", "rerun comic script" via the existing voice agent. Register pipeline stage navigation actions in `server/services/voice/tools.js`.
- [ ] **Recent-issues dynamic children under the Pipeline sidebar entry.** Currently Pipeline is a single sidebar link; could mirror Apps' `dynamic: 'apps'` pattern in `client/src/components/Layout.jsx`. **Wrinkle:** Apps is a TOP-LEVEL nav entry; Pipeline lives 2 levels deep under Create. The existing `renderNavItem`'s child render is flat — it emits a NavLink per child and ignores `child.children`. Needs either (a) recursive child render (cleaner, but bigger UX questions: indentation/collapsibility/auto-expand-depth) or (b) promoting Pipeline to a top-level nav entry (changes IA; might be the right call once it has its own subnav anyway). Attempted in this PR, backed out as out-of-scope.
- [ ] **AI-assisted panel/scene prompt generation.** Reserve `pipeline-comic-panel-image-prompt.md` and `pipeline-storyboard-image-prompt.md` template files for a future "AI: turn the script fragment into N image-gen prompts" button on the ComicPages and Storyboards stages.
- [ ] **Per-panel/scene image progress in the Pipeline UI.** Right now ComicPages and Storyboards record `jobId` but don't subscribe to the media-job SSE for live preview. Tie into the existing per-job progress hook so each panel shows live render thumbnails.
