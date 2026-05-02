# PortOS — Development Plan

For project goals, see [GOALS.md](./GOALS.md). For completed work, see [DONE.md](./DONE.md).

---

## Next Up

1. **Voice agent next power-ups** — `ui_read` (extract visible page text so "what does this say?" works without hand-navigation), destructive-action confirmation gate (pause and require spoken "confirm" when `ui_click` matches `/delete|remove|discard|reset|clear/i`), proactive CoS speech (server-pushed voice with quiet-hours policy + barge-in contract).
2. **Chronotype-aware CoS scheduling** — M42 ships chronotype derivation but `taskSchedule.js` still routes round-robin. Add a `temporalPreference` field to CoS task schema (`focus` / `low-energy` / `any`) and shift priority by time-of-day from the identity chronotype profile. Targeted addition (~150 lines), no new deps.
3. **God-file test coverage** — `cos.js` (3057 lines) and `agentLifecycle.js` (1283 lines) still have no test sibling. Add tests for `evaluateTasks` priority ordering + `dequeueNextTask` capacity guards (cos), and `spawnAgentForTask` + `handleAgentCompletion` error recovery (agentLifecycle).

## Backlog

### Creative Director follow-ups (post-#191 merge)

The PR landed with full pipeline mechanics + auto-recovery + smoke-test fixture, but the first real E2E run (1 of 6 scenes accepted on subjective grounds, 3 of 6 rejected, terminated cleanly) surfaced concrete improvement targets:

- [x] ~~**Multi-frame evaluator sampling.**~~ Done — `extractEvaluationFrames` in `server/lib/ffmpeg.js` probes total frames and uses ffmpeg `select='eq(n,0)+...'` to write `<jobId>-f1.jpg ... -f5.jpg`; `sceneRunner.handleRenderCompleted` calls it before enqueuing the evaluator and persists the basenames to `scene.evaluationFrames`; `buildEvaluatePrompt` now lists every sampled frame with timeline tags ("start (0%)", "~50% through", "end (~100%)") and instructs the agent to Read each one with explicit late-intent guidance. Falls back to single thumbnail when extraction fails.
- [ ] **i2v continuity fidelity.** `useContinuationFromPrior: true` currently feeds the prior scene's last frame as `sourceImagePath` but doesn't pin `imageStrength`. Renders sometimes drift hard from the seed (a "blue ball" continuation generates a totally new scene that loosely starts from the seed). Surface `imageStrength` as a per-scene knob in the treatment schema (default ~0.85 for continuation scenes, lower if the prompt deliberately changes the subject) and pipe it through `sceneRunner.params`.
- [ ] **Audio continuity across scenes.** mlx-video-with-audio generates audio per-clip; concatenated scenes have audible cuts at scene boundaries. Either render scenes silently and add a single backing audio pass at stitch time, or apply a short crossfade in `videoTimeline/local.js#buildFfmpegArgs` (already does video crossfades — extend to audio with `acrossfade`).
- [ ] **Duplicate evaluator spawn dedup.** During the long E2E run, server logs showed `Task already being spawned, skipping duplicate` followed seconds later by a *second* agent spawning for the exact same task id. The CoS task lane logic ends up double-acquiring. Reproduce in a unit test against `taskSchedule` / `agentLifecycle` and fix the de-dup window.
- [ ] **Render slowness on long sessions.** Per-scene render time degraded from ~3.5 min (early) to 10–30 min (late) within one project — likely accumulated listeners + queue races. Profile after sustained use; the round-22 dedup work probably already helps; verify.
- [ ] **Auto-accept watchdog.** `autoAcceptScenes: true` skips the Claude evaluator entirely. Add a server-side sanity check (file exists, file size > 0, ffprobe can read at least 1 frame) before writing the synthetic accepted evaluation — without it a black/zero-frame render would still be marked accepted.
- [x] ~~**Smoke-test cost reduction.**~~ Done — dropped `durationSeconds` 3s→2s, added a hidden `1:1-small` (384×384) aspect preset for the smoke fixture only (kept out of `ASPECT_RATIOS` so the user-facing dropdown is unchanged). Smoke run now ~63% cheaper in pixel-frame terms. Lets pipeline health checks complete in render time only.

### Other backlog

- [ ] **Writers Room (Phase 2+)** — Phase 1 ships the authoring core (folders/works/drafts, "write for 10" exercise, version snapshots) under a new top-level `Create` sidebar group alongside Media Gen. Phases 2-5 cover manual AI analysis, Creative Director handoff, synced prose/script/media review, and realtime CD feedback. See [writers-room.md](./docs/features/writers-room.md).
- [ ] **Voice CoS tool expansion** — `calendar_today` / `calendar_next` (Google Calendar via existing MCP), `meatspace_log_workout` (wraps `meatspaceHealth.js`), `weather_now` (needs API choice — OpenWeather / WeatherKit / NWS), `timer_set` (reuses `agentActionExecutor.js` scheduled actions).
- [ ] **Voice agent vision fallback** — `ui_describe_visually` tool: screenshot the current tab (or a named canvas/chart) and send to a vision-capable model so "what's on this chart?" works on non-DOM content (CyberCity, graph views). Depends on a vision provider in `portos-ai-toolkit`.
- [ ] **Voice agent — explicit long-term memory routing** — On "remember that …", auto-route to `brain_capture` and inject top-N relevant memories into the voice turn's system prompt via `brain_search`. Some of this is ambient today; make it explicit and self-improving.
- [ ] **CyberCity v2** — Transform from decorative scene to interactive systems map. See [cybercity-v2.md](./docs/features/cybercity-v2.md). Phase 1 (operational legibility) underway: per-building health glyphs, "needs attention" pane, search overlay, status filter chips, clickable HUD stats, hover preview with quick actions, mobile/touch support.
- [ ] **M50 P9 — CoS Automation & Rules** — Automated email classification, rule-based pre-filtering, email-to-task pipeline.
- [ ] **M50 P10 — Auto-Send with AI Review Gate** — Per-account/per-recipient trust level + dual-LLM review (drafter + reviewer). Only auto-send when both approve or trust ≥ 0.9. See [Messages Security](./docs/features/messages-security.md).
- [ ] **M34 P5-P7 — Digital Twin** — Multi-modal capture (voice/video/image identity sources), advanced testing, personas. Ties to GOALS.md secondary "Multi-Modal Identity Capture".
- [ ] **Multi-reference image editing for FLUX.2** — Add a UI on the Image Gen page that accepts 2+ reference images plus an edit prompt (e.g. "put the subject from image A into the scene from image B"). When this lands, swap the model registry's 9B entry to [`black-forest-labs/FLUX.2-klein-9B-kv`](https://huggingface.co/black-forest-labs/FLUX.2-klein-9B-kv) — KV-cache optimization computes reference-image KV pairs once and reuses them across edits, giving up to 2.5× speedup on multi-reference workflows. Single-prompt / single-init paths see no benefit, which is why standard 9B is fine until then. Work involves: schema for multi-image payload (`referenceImages: [...]`), client multi-uploader, server FormData parsing, and adapting `flux2_macos.py` to call the multi-reference pipeline API. Separately-gated repo on HF — user must request access.

### Depfree Audit — 2026-04-28

All dependencies audited and justified. 0 removals. See [docs/DEPS.md](./docs/DEPS.md) for the full classification table and per-package rationale.

### Better Audit — pending (2026-04-21)

- [ ] **[HIGH][DRY]** `server/services/socket.js:595-814` — extract `broadcastToSet` + `registerSubscriber` to collapse 6× duplicated subscriber/broadcast boilerplate (also fixes missing `shellService.unsubscribeSessionList` on disconnect).
- [ ] **[HIGH][CODE]** `server/services/cos.js:3055` — remove `NODE_ENV !== 'test'` init guard (test-specific hack in prod).
- [ ] **[CRITICAL][TESTS]** `server/services/cos.js` and `server/services/agentLifecycle.js` — add test files (covered in Next Up #3).
- [ ] **[HIGH][TESTS]** Create test files for `server/services/clinvar.js`, `telegramBridge.js`.
- [ ] **[MEDIUM][CLIENT]** 8 client components redefine `formatBytes`/`formatTime`/`formatDuration`/`timeAgo`/`formatDate` locally; import from `client/src/utils/formatters.js`.
- [ ] **[MEDIUM][PERF]** `server/services/feeds.js:234-248` — full-sort-then-paginate on every request.
- [ ] **[MEDIUM][CODE]** Various magic numbers in `cos.js:166,357`, `lmStudioManager.js:66`; brittle `err.message.includes`/`startsWith` checks in `visionTest.js:124` and `routes/voice.js:160`.

### Deferred Architecture (human-led planning)

- `server/services/cos.js` (3057 lines) — split into cosTaskStore / cosTaskGenerator / cosJobScheduler / cosHealthMonitor.
- `server/services/agentLifecycle.js` (1283 lines) — extract prepareAgentWorkspace / resolveProvider / processCompletion.
- `server/services/identity.js` (1917 lines) — separate genomic markers + longevity + goals + todos.
- `server/services/taskSchedule.js` (2233 lines) — extract prompt management to `taskPromptService.js`.
- `server/services/socket.js` — split into domain-specific socket modules.
- `server/routes/apps.js` (1126 lines) — extract `npm install` orchestration to `appBuilder.js`.
- `client/src/components/goals/GoalDetailPanel.jsx` (1252 lines) — god component.
- `autofixer/ui.js` (972 lines) — inline HTML template needs extraction.
- API contract — standardize error response shapes (`asyncHandler` + `ServerError` everywhere).

**Known low-severity:** pm2 ReDoS (GHSA-x5gf-qvw8-r2rm) — no upstream fix, not exploitable via PortOS routes.

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
