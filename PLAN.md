# PortOS — Development Plan

For project goals, see [GOALS.md](./GOALS.md). For completed work, see [DONE.md](./DONE.md).

---

## Next Up

1. **Voice agent next power-ups** — `ui_read` (extract visible page text so "what does this say?" works without hand-navigation), destructive-action confirmation gate (pause and require spoken "confirm" when `ui_click` matches `/delete|remove|discard|reset|clear/i`), proactive CoS speech (server-pushed voice with quiet-hours policy + barge-in contract).
2. **Chronotype-aware CoS scheduling** — M42 ships chronotype derivation but `taskSchedule.js` still routes round-robin. Add a `temporalPreference` field to CoS task schema (`focus` / `low-energy` / `any`) and shift priority by time-of-day from the identity chronotype profile. Targeted addition (~150 lines), no new deps.
3. **God-file test coverage** — `cos.js` (3071 lines) and `agentLifecycle.js` (1314 lines) still have no test sibling. Add tests for `evaluateTasks` priority ordering + `dequeueNextTask` capacity guards (cos), and `spawnAgentForTask` + `handleAgentCompletion` error recovery (agentLifecycle).

## Backlog

### Creative Director follow-ups

The pipeline now has multi-frame evaluation, auto-accept watchdog, and a cheap smoke fixture (see DONE.md 2026-05-06). The first real E2E run surfaced these remaining targets:

- [x] **i2v continuity fidelity.** `useContinuationFromPrior: true` feeds the prior scene's last frame as `sourceImagePath` but doesn't pin `imageStrength`. Renders sometimes drift hard from the seed (a "blue ball" continuation generates a totally new scene that loosely starts from the seed). `imageStrength` is already threaded through `videoGen/local.js`; surface it as a per-scene knob in the treatment schema (default ~0.85 for continuation scenes, lower if the prompt deliberately changes the subject) and pipe it through `sceneRunner.params`.
- [ ] **Audio continuity across scenes.** mlx-video-with-audio generates audio per-clip; concatenated scenes have audible cuts at scene boundaries. Either render scenes silently and add a single backing audio pass at stitch time, or apply a short crossfade in `videoTimeline/local.js#buildFfmpegArgs` (already does video crossfades — extend to audio with `acrossfade`).
- [ ] **Duplicate evaluator spawn dedup.** During the long E2E run, server logs showed `Task already being spawned, skipping duplicate` followed seconds later by a *second* agent spawning for the exact same task id. The CoS task lane logic ends up double-acquiring. Reproduce in a unit test against `taskSchedule` / `agentLifecycle` and fix the de-dup window.
- [ ] **Render slowness on long sessions.** Per-scene render time degraded from ~3.5 min (early) to 10–30 min (late) within one project — likely accumulated listeners + queue races. Profile after sustained use; the round-22 dedup work probably already helps; verify.

### LTX-2.3 dgrauet runtime — wire native modes

The dgrauet/ltx-2-mlx runtime ships with FFLF (true keyframe interpolation), audio-to-video, and native video Extend (see DONE.md 2026-05-06). Remaining gaps:

- [ ] **Native FFLF deeper test on real keyframe pairs.** FFLF wiring is verified on synthetic ball-motion keyframes (commit `ef5d9081`). Validate with REAL pairs: take last frame of clip A + first frame of clip B from the same scene/camera, render an interpolation, confirm temporally-coherent transition. If it looks weak even on similar keyframes, file a follow-up to expose more pipeline knobs in the UI (cfg-scale, stg-scale, stage1-steps).
- [ ] **Add UI hint under FFLF mode.** "Use keyframes that share scene geometry — same camera, same subject; the model interpolates between them. Random unrelated images produce a visual cut." Prevents the "looks like two stills" complaint that surfaced during testing.
- [ ] **Once dgrauet is the default for everything we care about, deprecate notapalindrome models.** Mark `ltx2_unified`, `ltx23_unified`, `ltx23_distilled_q4` with `deprecated: true` in `server/lib/mediaModels.js` so the model dropdown groups them under a "Legacy" section. Eventually drop them and the `runtime: 'mlx_video'` dispatch entirely (~50 LOC removal in videoGen/local.js).

### Other backlog

- [ ] **Writers Room (Phase 4–5)** — Phases 1–3 shipped (authoring core, storyboard companion, character/world/objects bibles, per-stage LLM picker, paragraph-grain Adapt, auto-queue scene image gen, Read view + render dock). Remaining: Phase 4 synced prose/script/media review, Phase 5 realtime CD feedback. See [writers-room.md](./docs/features/writers-room.md).
- [ ] **Voice CoS tool expansion** — `calendar_today` / `calendar_next` (Google Calendar via existing MCP), `meatspace_log_workout` (wraps `meatspaceHealth.js`), `weather_now` (needs API choice — OpenWeather / WeatherKit / NWS), `timer_set` (reuses `agentActionExecutor.js` scheduled actions).
- [ ] **Voice agent vision fallback** — `ui_describe_visually` tool: screenshot the current tab (or a named canvas/chart) and send to a vision-capable model so "what's on this chart?" works on non-DOM content (CyberCity, graph views). Depends on a vision provider in `portos-ai-toolkit`.
- [ ] **Voice agent — explicit long-term memory routing** — pipeline already routes capture verbs to `brain_capture`. Remaining: on retrieval-shaped voice turns, inject top-N relevant memories into the system prompt via `brain_search` so it's self-improving rather than ambient.
- [ ] **CyberCity v2** — Transform from decorative scene to interactive systems map. See [cybercity-v2.md](./docs/features/cybercity-v2.md). Phase 1 (operational legibility) underway: per-building health glyphs, "needs attention" pane, search overlay, status filter chips, clickable HUD stats, hover preview with quick actions, mobile/touch support.
- [ ] **M50 P9 — CoS Automation & Rules** — Automated email classification, rule-based pre-filtering, email-to-task pipeline.
- [ ] **M50 P10 — Auto-Send with AI Review Gate** — Per-account/per-recipient trust level + dual-LLM review (drafter + reviewer). Only auto-send when both approve or trust ≥ 0.9. See [Messages Security](./docs/features/messages-security.md).
- [ ] **M34 P5-P7 — Digital Twin** — Multi-modal capture (voice/video/image identity sources), advanced testing, personas. Ties to GOALS.md secondary "Multi-Modal Identity Capture".
- [ ] **Multi-reference image editing for FLUX.2** — UI on the Image Gen page that accepts 2+ reference images plus an edit prompt (e.g. "put the subject from image A into the scene from image B"). When this lands, swap the model registry's 9B entry to [`black-forest-labs/FLUX.2-klein-9B-kv`](https://huggingface.co/black-forest-labs/FLUX.2-klein-9B-kv) — KV-cache optimization gives up to 2.5× speedup on multi-reference workflows. Work involves: schema for multi-image payload (`referenceImages: [...]`), client multi-uploader, server FormData parsing, and adapting `flux2_macos.py` to call the multi-reference pipeline API. Separately-gated repo on HF — user must request access.

### Better Audit follow-ups

- [ ] **[HIGH][DRY]** `server/services/socket.js` disconnect handler — `broadcastToSet` / `registerSubscriber` extraction is shipped; the `shellService.unsubscribeSessionList(socket)` call is still missing on socket disconnect (lines 487–498).
- [ ] **[HIGH][CODE]** `server/services/cos.js:3069` — remove `NODE_ENV !== 'test' && VITEST !== 'true'` init guard (test-specific hack in prod).
- [ ] **[HIGH][TESTS]** Create test files for `server/services/clinvar.js` and `server/services/telegramBridge.js`.
- [ ] **[MEDIUM][CLIENT]** 4 components still redefine `formatBytes`/`formatTime`/`formatDuration`/`timeAgo`/`formatDate` locally instead of importing from `client/src/utils/formatters.js`: `pages/VideoTimelineEditor.jsx`, `pages/VideoTimeline.jsx`, `components/settings/MortalLoomTab.jsx`, `components/brain/tabs/ImportTab.jsx`. (Down from 8.)
- [ ] **[MEDIUM][PERF]** `server/services/feeds.js:234-260` — full-sort-then-paginate on every request.
- [ ] **[MEDIUM][CODE]** Magic numbers in `cos.js:166,357`, `lmStudioManager.js:66`; brittle `err.message.includes`/`startsWith` checks in `routes/voice.js:160` and `services/visionTest.js:124`.

### Deferred Architecture (human-led planning)

- `server/services/cos.js` (3071 LOC) — split into cosTaskStore / cosTaskGenerator / cosJobScheduler / cosHealthMonitor.
- `server/services/agentLifecycle.js` (1314 LOC) — extract prepareAgentWorkspace / resolveProvider / processCompletion.
- `server/services/identity.js` (1917 LOC) — separate genomic markers + longevity + goals + todos.
- `server/services/taskSchedule.js` (2233 LOC) — extract prompt management to `taskPromptService.js`.
- `server/services/taskLearning.js` (1845 LOC) — separate metrics aggregation from heuristic routing.
- `server/services/autonomousJobs.js` (1567 LOC) — extract job registry / scheduler / execution paths.
- `server/services/voice/tools.js` (1284 LOC) — group by domain (UI control / calendar / brain / media) into sibling modules.
- `server/services/git.js` (1215 LOC) — extract command builders + parsers.
- `server/services/socket.js` — split into domain-specific socket modules.
- `server/cos-runner/index.js` (1076 LOC) — extract spawn / lifecycle / IPC layers.
- `server/services/memory.js` (1049 LOC) — separate retrieval, classification, and persistence.
- `server/services/xcodeScripts.js` (1131 LOC) — collapse repeated AppleScript builders.
- `server/routes/apps.js` (1126 LOC) — extract `npm install` orchestration to `appBuilder.js`.
- `client/src/pages/VideoGen.jsx` (1335 LOC) — extract mode-specific control panels (i2v / a2v / extend / FFLF) into siblings.
- `client/src/pages/ImageGen.jsx` (1136 LOC) — extract preset picker + multi-reference uploader.
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
