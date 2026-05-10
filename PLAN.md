# PortOS — Development Plan

For project goals, see [GOALS.md](./GOALS.md). For completed work, see [DONE.md](./DONE.md).

---

## Next Up

1. **Voice agent next power-ups** — `ui_read` (extract visible page text so "what does this say?" works without hand-navigation), destructive-action confirmation gate (pause and require spoken "confirm" when `ui_click` matches `/delete|remove|discard|reset|clear/i`), proactive CoS speech (server-pushed voice with quiet-hours policy + barge-in contract).
2. **Chronotype-aware CoS scheduling** — M42 ships chronotype derivation (`identity.js#getChronotype` + `getEnergyZones`) but `taskSchedule.js` still routes round-robin. Add a `temporalPreference` field to CoS task schema (`focus` / `low-energy` / `any`) and shift priority by time-of-day from the identity chronotype profile. Targeted addition (~150 lines), no new deps.
3. **God-file test coverage** — `cos.js` (3115 lines) and `agentLifecycle.js` (1435 lines) still have no test sibling. Add tests for `evaluateTasks` priority ordering + `dequeueNextTask` capacity guards (cos), and `spawnAgentForTask` + `handleAgentCompletion` error recovery (agentLifecycle). Both files are still growing — 44 LOC since last replan; add coverage before further surgery.

## Backlog

### Creative Director follow-ups

The pipeline now has multi-frame evaluation, auto-accept watchdog, cheap smoke fixture, and per-scene `imageStrength` continuation anchoring (see DONE.md). Remaining targets surfaced by the long E2E run:

- [ ] **Audio continuity across scenes.** mlx-video-with-audio generates audio per-clip; concatenated scenes have audible cuts at scene boundaries. Either render scenes silently and add a single backing audio pass at stitch time, or apply a short crossfade in `videoTimeline/local.js#buildFfmpegArgs` (already does video crossfades — extend to audio with `acrossfade`).
- [ ] **Duplicate evaluator spawn dedup.** During the long E2E run, server logs showed `Task already being spawned, skipping duplicate` followed seconds later by a *second* agent spawning for the exact same task id. The CoS task lane logic ends up double-acquiring. Reproduce in a unit test against `taskSchedule` / `agentLifecycle` and fix the de-dup window (`agentLifecycle.js:114`).
- [ ] **Render slowness on long sessions.** Per-scene render time degraded from ~3.5 min (early) to 10–30 min (late) within one project — likely accumulated listeners + queue races. Profile after sustained use; the round-22 dedup work probably already helps; verify.

### LTX-2.3 dgrauet runtime — wire native modes

The dgrauet/ltx-2-mlx runtime ships with FFLF (true keyframe interpolation), audio-to-video, and native video Extend (see DONE.md 2026-05-06). Remaining gaps:

- [ ] **Native FFLF deeper test on real keyframe pairs.** FFLF wiring is verified on synthetic ball-motion keyframes (commit `ef5d9081`). Validate with REAL pairs: take last frame of clip A + first frame of clip B from the same scene/camera, render an interpolation, confirm temporally-coherent transition. If it looks weak even on similar keyframes, file a follow-up to expose more pipeline knobs in the UI (cfg-scale, stg-scale, stage1-steps).
- [ ] **Add UI hint under FFLF mode.** Current advisory note says "Experimental — last frame is advisory" but doesn't guide users on *what makes a good keyframe pair*. Add: "Use keyframes that share scene geometry — same camera, same subject; the model interpolates between them. Random unrelated images produce a visual cut." Prevents the "looks like two stills" complaint that surfaced during testing. (`client/src/pages/VideoGen.jsx` ~line 917)
- [ ] **Once dgrauet is the default for everything we care about, deprecate notapalindrome models.** Mark `ltx2_unified`, `ltx23_unified`, `ltx23_distilled_q4` with `deprecated: true` in `server/lib/mediaModels.js` so the model dropdown groups them under a "Legacy" section. Eventually drop them and the `runtime: 'mlx_video'` dispatch entirely (~50 LOC removal in videoGen/local.js).

### Other backlog

- [ ] **Writers Room (Phase 4–5)** — Phases 1–3 shipped (authoring core, storyboard companion, character/world/objects bibles, per-stage LLM picker, paragraph-grain Adapt, auto-queue scene image gen, Read view + render dock). Remaining: Phase 4 synced prose/script/media review, Phase 5 realtime CD feedback. See [writers-room.md](./docs/features/writers-room.md).
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

### Civitai LoRA / Z-Image-Turbo follow-ups (from /simplify pass)

These were flagged by the post-merge code review pass on the Z-Image + Civitai LoRA work but deliberately deferred to keep the original PR scoped.

- [ ] **Detect `_shippedDefaults` ↔ `image[]` drift in mediaModels.js.** A real-install case (2026-05-09) hit a state where `_shippedDefaults.image.list` recorded all default ids but the user's `image[]` array was missing several of them — possibly from a partial editor save or a write race. The deletion-survives-upgrade contract then permanently skipped re-adding those built-ins on every restart. Add a boot-time check in `loadMediaModels()`: for any id present in `_shippedDefaults.image.list` AND `DEFAULT_REGISTRY.image` but missing from the user's `image[]`, log a clear warning (`⚠️ media-models drift: built-in <id> was shipped but is missing from image[] — restore it manually or delete _shippedDefaults.image to re-bootstrap`). Don't auto-recover (would defeat real deletions), just make the drift loud. Same pattern applies to video.

- [ ] **Extract `scripts/_runner_common.py`** — `scripts/flux2_macos.py` and `scripts/z_image_turbo.py` still duplicate `pick_device`, `make_generator`, `apply_memory_optimizations`, `write_sidecar`, `make_stepwise_callback` (~95% identical, only the latents-unpack branch differs), `_emit_user_error`, and the entire bottom-of-file HF cause-chain walker (`_repo_from_hf_error` + the gated/notfound/401 dispatch in `__main__`). Roughly 200 lines of byte-for-byte duplication. Extract into a shared module with `make_stepwise_callback(pipe, h, w, dir, *, unpack_latents=None)` and `install_hf_error_handler()` (decorator/context manager wrapping `main`). The `apply_loras` extraction already shipped via `scripts/lora_utils.py`; this is the same pattern, larger blast radius.
- [ ] **`RUNNER_FAMILIES` constants module** — runner ids `'mflux' | 'flux2' | 'z-image'` are bare strings in `server/lib/civitai.js`, `server/lib/mediaModels.js`, `client/src/pages/ImageGen.jsx`, and the `RUNNER_LABEL` / `RUNNER_BADGE_CLASS` maps in `client/src/pages/Loras.jsx`. Export `RUNNER_FAMILIES = { MFLUX, FLUX2, Z_IMAGE }` from `server/lib/runners.js` (mirror to a small client constant) so a typo can't silently break the LoRA picker's compat filter. `isFlux2()` / `isZImage()` already wrap the server-side comparisons; this is mostly client + civitai.js cleanup.
- [ ] **Two `listLoras` exports collision** — `server/services/imageGen/local.js#listLoras` returns minimal `{ filename, name }` (powers `/api/image-gen/loras`); `server/services/loras.js#listLoras` returns the rich Civitai-aware shape (powers `/api/loras`). Same name, two modules, two shapes — a future caller importing the wrong one gets `undefined` for `civitai` / `runnerFamily`. Rename the legacy one to `listLoraFilenames` (or have it project from the new list) to make the distinction explicit.
- [ ] **Generic `deepMerge` utility** — three call sites now do hand-rolled deep-merge: `server/services/voice/config.js`, `server/services/meatspacePost.js`, and the new `server/routes/loras.js#POST /auth/civitai`. Promote the cleanest impl (voice/config.js) into `server/lib/objects.js` and consolidate. Then loras.js, voice config, and meatspacePost all consume one helper — and `updateSettings()`-via-shallow-merge stops being a footgun for any future settings sub-object.
- [ ] **Project-wide `<Modal>` component** — every modal in the app (`Flux2InstallModal`, `EditAppModal`, `MemoryEditModal`, `ResumeAgentModal`, `MediaLightbox`, `LayoutEditor`, `KeyboardHelp`, `RapidReader`, `DeployPanel`'s confirm, the new `CivitaiAuthModal` in `Loras.jsx`) rolls its own `fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4` backdrop + click-outside + close-button + ESC handler. Extract `client/src/components/ui/Modal.jsx` with backdrop + dialog props and a slot for the body, then convert all call sites. ~300 LOC of duplicated chrome across the codebase.
- [ ] **`assertSafeFilename(filename, { extensions })` in `fileUtils.js`** — `server/services/loras.js#assertSafeLoraFilename` (`.safetensors` whitelist) and `server/services/imageGen/local.js#assertGalleryFilename` (`.png` whitelist) are the same validation pattern with different extensions. One small helper in `fileUtils.js` consolidates both call sites.

### Better Audit follow-ups

- [ ] **[HIGH][CODE]** `server/services/cos.js:3113` — remove `NODE_ENV !== 'test' && VITEST !== 'true'` init guard (test-specific hack in prod boot path).
- [ ] **[HIGH][TESTS]** Create test files for `server/services/clinvar.js` and `server/services/telegramBridge.js`.
- [ ] **[MEDIUM][CLIENT]** 4 components still redefine `formatBytes`/`formatTime`/`formatDuration`/`timeAgo`/`formatDate` locally instead of importing from `client/src/utils/formatters.js`: `pages/VideoTimelineEditor.jsx`, `pages/VideoTimeline.jsx`, `components/settings/MortalLoomTab.jsx`, `components/brain/tabs/ImportTab.jsx`. (Down from 8.)
- [ ] **[MEDIUM][PERF]** `server/services/feeds.js#getItems` (lines 303–319) — full-sort-then-paginate on every request. Pre-sort once at write time or maintain a per-feed index.
- [ ] **[MEDIUM][CODE]** Magic numbers in `cos.js:166,357`, `lmStudioManager.js:66`; brittle `err.message.startsWith('unknown piper voice:')` in `routes/voice.js:160` and `err.message.includes('not initialized')` in `services/visionTest.js:124`.

### Deferred Architecture (human-led planning)

- `server/services/cos.js` (3115 LOC) — split into cosTaskStore / cosTaskGenerator / cosJobScheduler / cosHealthMonitor.
- `server/services/agentLifecycle.js` (1435 LOC) — extract prepareAgentWorkspace / resolveProvider / processCompletion.
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
- `client/src/pages/VideoGen.jsx` (1334 LOC) — extract mode-specific control panels (i2v / a2v / extend / FFLF) into siblings.
- `client/src/pages/ImageGen.jsx` (1161 LOC) — extract preset picker + multi-reference uploader.
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

## Pipeline — Deferred

Skeleton landed in `server/services/pipeline/` + `client/src/pages/Pipeline*.jsx`. Items below were scoped out of MVP and live here so they don't evaporate:

- [ ] **Wire `episodeVideo` stage to Creative Director.** `POST /api/pipeline/issues/:id/stages/episodeVideo/visual` currently returns 501. Refactor `server/services/creativeDirector/sceneRunner.js` + `orchestrator.js` to expose a `runSceneForExternalCaller(projectId, sceneId)` helper, then have `visualStages.js` use it for per-scene video + stitch. Persist `cdProjectId` + `videoPath` into `stages.episodeVideo`.
- [ ] **Wire `storyboards` scene-video rendering** through the same CD handoff once episodeVideo lands. Each scene already records `imageJobId`; add optional `sceneVideoJobId`.
- [ ] **Rich-text editor for prose stage.** Currently a plain `<textarea>` in `client/src/components/pipeline/stages/ProseStage.jsx`. Either reuse `client/src/components/writers-room/` editor, or pick a minimal markdown editor.
- [ ] **Versioning / diff view per stage.** No history right now — regenerating overwrites. Could persist last N `lastRunId` snapshots and offer a diff modal.
- [ ] **"Auto-run everything including video" button.** MVP auto-run stops after the text stages (idea → prose → comic+TV scripts) to avoid burning GPU minutes on un-reviewed content. Add this once `episodeVideo` is wired.
- [ ] **RunwayML / third-party video provider integration.** Stubs are commented in `server/services/videoGen/`. Once that abstraction lands, the Pipeline's episodeVideo stage should expose a provider picker (local LTX vs Runway vs …).
- [ ] **Series-arc grouping (Series → Arc → Issue).** MVP collapses arc into series; some narratives want a 3-issue arc that nests inside the series and shares its own arc-bible. Add an `arc` field on issues or a parallel `data/pipeline-arcs.json`.
- [ ] **Comic-book PDF export.** Once `stages.comicPages` carries enough panel data + rendered images, export a print-ready PDF.
- [ ] **Voice-controlled stage advancement.** "Next stage", "rerun comic script" via the existing voice agent. Register pipeline stage navigation actions in `server/services/voice/tools.js`.
- [ ] **Recent-issues dynamic children under the Pipeline sidebar entry.** Currently Pipeline is a single sidebar link; could mirror Apps' `dynamic: 'apps'` pattern in `client/src/components/Layout.jsx`.
- [ ] **AI-assisted panel/scene prompt generation.** Reserve `pipeline-comic-panel-image-prompt.md` and `pipeline-storyboard-image-prompt.md` template files for a future "AI: turn the script fragment into N image-gen prompts" button on the ComicPages and Storyboards stages.
- [ ] **Per-panel/scene image progress in the Pipeline UI.** Right now ComicPages and Storyboards record `jobId` but don't subscribe to the media-job SSE for live preview. Tie into the existing per-job progress hook so each panel shows live render thumbnails.
- [ ] **Background auto-run resumption.** If the server restarts mid auto-run, the in-memory `runs` map in `autoRunner.js` is lost — the issue is left in `status: running` with no SSE attachable. Add a startup hook that scans for issues in `running` state and either clears them to `needs-review` or resumes them.
