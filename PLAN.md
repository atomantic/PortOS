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

- [ ] **Whole-episode audio generation strategy.** mlx-video-with-audio generates audio per-clip and the resulting scene-level mini-soundtracks are abruptly different from each other — even a perfect xfade boundary won't fix it (it's like a DJ mixing five unrelated songs). The architectural answer is to STOP relying on per-clip audio and instead drive audio generation from the *whole-episode arc*. Scope of the eventual design:
  - **Source of truth.** The episode's prose/script/storyboards (already in the pipeline data model) define the arc — beats, tone shifts, scene durations. An audio generator should consume this, not the per-clip video output.
  - **Generator candidates.** Suno API (commercial, has duration control), MusicGen-MLX (local, but bounded to ~30s without stitching), AudioLDM2, or a multi-track approach (separate music + ambient + foley layers).
  - **Stitch path change.** `server/services/creativeDirector/stitchRunner.js` after timeline render: strip per-clip audio (`-c:v copy -an`), then a second ffmpeg pass overlays the generated track. New project-level `audioMode: 'per-clip' | 'silent' | 'generated' | 'uploaded-track'`. PLAN today's `'per-clip'` stays the default so existing projects don't regress.
  - **UX.** `EpisodeVideoStage.jsx` toolbar gets an "Audio" dropdown beside aspectRatio/quality. "Generated" kicks off the audio gen as part of the stitch pipeline; "Uploaded" opens a file picker.
  - **Investigation needed first** — pick a generator. Suno has the cleanest UX (give it a vibe prompt + duration); MusicGen-MLX is local but needs sliding-window stitching to exceed 30s; AudioLDM2 is older. ~150 LOC for the stitcher change once the generator is picked; the bigger question is which model and how to prompt it from script-level arc metadata. Treat this as a new sub-brainstorm when we pick it up — not a same-PR fix.
- [ ] **Duplicate evaluator spawn dedup.** During the long E2E run, server logs showed `Task already being spawned, skipping duplicate` followed seconds later by a *second* agent spawning for the exact same task id. The CoS task lane logic ends up double-acquiring. Reproduce in a unit test against `taskSchedule` / `agentLifecycle` and fix the de-dup window (`agentLifecycle.js:114`).
- [ ] **Render slowness on long sessions.** Per-scene render time degraded from ~3.5 min (early) to 10–30 min (late) within one project — likely accumulated listeners + queue races. Profile after sustained use; the round-22 dedup work probably already helps; verify.

### LTX-2.3 dgrauet runtime — wire native modes

The dgrauet/ltx-2-mlx runtime ships with FFLF (true keyframe interpolation), audio-to-video, and native video Extend (see DONE.md 2026-05-06). Remaining gaps:

- [ ] **Native FFLF deeper test on real keyframe pairs.** FFLF wiring is verified on synthetic ball-motion keyframes (commit `ef5d9081`). Validate with REAL pairs: take last frame of clip A + first frame of clip B from the same scene/camera, render an interpolation, confirm temporally-coherent transition. If it looks weak even on similar keyframes, file a follow-up to expose more pipeline knobs in the UI (cfg-scale, stg-scale, stage1-steps).
- [ ] **Add UI hint under FFLF mode.** Current advisory note says "Experimental — last frame is advisory" but doesn't guide users on *what makes a good keyframe pair*. Add: "Use keyframes that share scene geometry — same camera, same subject; the model interpolates between them. Random unrelated images produce a visual cut." Prevents the "looks like two stills" complaint that surfaced during testing. (`client/src/pages/VideoGen.jsx` ~line 917)
- [ ] **Once dgrauet is the default for everything we care about, deprecate notapalindrome models.** Mark `ltx2_unified`, `ltx23_unified`, `ltx23_distilled_q4` with `deprecated: true` in `server/lib/mediaModels.js` so the model dropdown groups them under a "Legacy" section. Eventually drop them and the `runtime: 'mlx_video'` dispatch entirely (~50 LOC removal in videoGen/local.js).

### Other backlog

- [ ] **Writers Room (Phase 4–5)** — Phases 1–3 shipped (authoring core, storyboard companion, character/world/objects bibles, per-stage LLM picker, paragraph-grain Adapt, auto-queue scene image gen, Read view + render dock). Remaining: Phase 4 synced prose/script/media review, Phase 5 realtime CD feedback. See [writers-room.md](./docs/features/writers-room.md). **Cross-cutting:** Phase 4 overlaps with the [Writers Room ↔ Pipeline DRY Unification](#writers-room--pipeline-dry-unification) work below — schedule them together so the synced-review surface lands on the unified bible/scene model rather than the parallel one.
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

## Writers Room ↔ Pipeline DRY Unification

The Writers Room and the Pipeline grew up in parallel and now duplicate enough machinery that bug fixes (e.g. character-physical-description injection, stage prompt drift, JSON extraction quirks) have to be applied twice — and one side usually gets missed. Both systems do the same five things: (1) call an LLM via the active provider, (2) extract characters/settings/objects from prose, (3) hold a project-scoped "bible," (4) generate a scene list, (5) compose per-scene image prompts. They should share a single implementation for each.

Items below are ordered by dependency: each later item builds on earlier ones. Land them as separate PRs — none is so large it can't ship standalone.

- [x] **1a. Drop the `sceneCardHelpers.js` shim** — shipped. Constants moved to new `client/src/lib/wrImageDefaults.js`; SceneCard.jsx + StoryboardPanel.jsx now import `buildScenePrompt` / `matchScene*` / `normCharKey` etc. directly from `client/src/lib/scenePrompt`. Shim file deleted.
- [x] **1b. Mirror `composeStyledPrompt` to `server/lib/`** — shipped. `server/lib/composeStyledPrompt.js` is the verbatim mirror of `client/src/lib/composeStyledPrompt.js`. World Builder's `compileBatchPrompts` now uses it for both the variation and composite-sheet code paths. Side effect: the rendered prompts switch separator from `, ` to `. ` (the composeStyledPrompt convention shared with `scenePrompt`); semantically identical for diffusion models, two pinned test assertions updated. 6 unit tests.
- [x] **1. Shared scene-prompt composer** — shipped. Canonical `server/lib/scenePrompt.js` with mirror `client/src/lib/scenePrompt.js` (Vite fs.allow doesn't reach across to `server/lib`, so we follow the project's existing manual-mirror convention). `writersRoom/settings.js#normalizeSlugline` and `sceneCardHelpers.js` both re-export from the canonical home. Pipeline `composeVisualPrompt` now routes through `buildScenePrompt` so series name + style + universal cast (series.characters[]) + scene visual all flow through the same algorithm with PROMPT_MAX-budgeted truncation. Storyboards stage UI + route schema accept an optional per-scene `slugline` so the eventual settings-bible match (item 2) is plumbed end-to-end. 18 new unit tests in `server/lib/scenePrompt.test.js`; existing 119-test pipeline + writers-room pack stays green.

- [ ] **2a. `bibleStore({ kind, idPrefix, idRegex, fileName, ... })` factory.** After items 1+2, the three writers-room files (`characters.js`/`settings.js`/`objects.js`) still share ~70% structurally — `loadFile`/`saveFile`/`listX`/`getX`/`createX`/`updateX`/`deleteX`/`mergeExtractedX` are byte-similar except for filename + idRegex + the setting-specific "name OR slugline" identifier rule + the post-update "blank-both → reject" guard. Extract into a `createBibleStore({ kind, idPrefix, idRegex, fileName, listKey, dedupKey, validateAfter })` factory in `server/lib/storyBible.js`. Each domain file shrinks to ~15 lines: `export const { list, get, create, update, delete, mergeExtracted } = createBibleStore({...})`. Setting's slugline-aware dedup goes in via the `dedupKey` callback. Estimated -250 LOC.
- [ ] **2b. Share zod bible-entry schemas between writers-room + pipeline routes.** `server/lib/validation.js` already defines `writersRoomCharacterCreateSchema` / `writersRoomSettingCreateSchema` / `writersRoomObjectCreateSchema` mirroring `BIBLE_LIMITS` shape. Pipeline `routes/pipeline.js#bibleEntrySchema = z.record(z.string(), z.any())` is strictly looser — accepts arbitrary keys, no length caps. Re-export the writers-room schemas under generic names (`characterBibleSchema` / `settingBibleSchema` / `objectBibleSchema`) and have pipeline `routes/pipeline.js` extend them with its own back-compat `description` + `imageRefs` overrides.
- [x] **2. Unified story-bible schema** — shipped. `server/lib/storyBible.js` owns the canonical `Character` / `Setting` / `Object` shapes + `sanitizeBibleList` + `mergeExtractedBible` (with per-kind key normalizers — slugline collapsing for settings, name-key for characters/objects). Writers-room `characters.js` / `settings.js` / `objects.js` collapsed onto the shared helpers (-299 LOC of duplicated merge/sanitize logic). Pipeline `series.characters` migrates to the canonical shape via back-compat read (legacy `description` field auto-promotes to `physicalDescription`); `series.settings[]` and `series.objects[]` added with the same sanitizers. `composeVisualPrompt` now activates the slugline-matching plumbed in item 1 — pipeline storyboard scenes that reuse a setting slugline get the canonical setting baseline (description + palette + recurring details) prepended automatically. 30 new tests in `server/lib/storyBible.test.js`; full server pack 3716/3716 green.

- [x] **3. Shared staged-LLM runner** — shipped. `server/lib/stageRunner.js` exposes `runStagedLLM(stageName, variables, { providerOverride, modelOverride, returnsJson, source })` plus `resolveModel` (tier-aware) and `extractJson` (lenient code-fence stripper). Both `writersRoom/evaluator.js#runAnalysis` and `pipeline/textStages.js#generateStage` route through it. Writers-room evaluator went 589 → 435 LOC; the bespoke `callApiProvider` + `callCliProvider` + `buildCliInvocation` (~150 LOC of CLI-spawn drift) deleted. Pipeline text stages went 180 → 118 LOC. Writers-room calls now persist transcripts to `data/runs/<runId>/` (which the bespoke fetch path was silently skipping) and pick up tier-name model resolution for free. Behavioral note: per-stage temperature override (format=0.2, others=0.4) was dropped — the toolkit's `executeApiRun` doesn't expose a temp parameter; if format-stage drift surfaces, plumb temperature through the toolkit. 18 new stageRunner tests; obsolete `evaluator.test.js` (only `buildCliInvocation` coverage, now redundant with `runner.test.js:48`) deleted. Server pack 3733/3733 green.

- [x] **4a. `extractAndMergeIntoSeries(seriesId, { kinds, corpus, ... })`** — shipped. The bible extract → merge → patch orchestration now lives in `server/services/pipeline/series.js`; the route shrinks to a `seriesSvc.extractAndMergeIntoSeries(series.id, {...})` call and `mergeExtractedBible` / `extractBible` are no longer route-layer imports. Mirrors how writers-room exposes `mergeExtractedCharacters(workId, extracted)`. Forwards the `parallel` flag from 4b through to the service so the speedup stays available. Pure refactor — all 23 pipeline route tests green without modification.
- [x] **4b. Opt-in `parallel: true` mode for `/extract-bible`** — shipped. `extractBibleSchema` accepts a `parallel: boolean`; when true the three kinds fan out via `Promise.all` (~3× wall-clock speedup on HTTP-API providers). Default stays sequential — safe for CLI providers that serialize at the provider session anyway. Merge always runs after all extractions complete; `series.<field>` is read once at the top of the route so the merge baseline doesn't race. 2 new route tests: one drives the parallel guarantee (every start fires before the first finish), one drives the sequential guarantee (events alternate start/finish/start/finish/...).
- [ ] **4c. `client/src/hooks/useAsyncAction.js`** — collapse the `setLoading(true) → await ... .catch(toast) → setLoading(false)` pattern that now duplicates across `ProseStage.jsx`, `TextStagePanel.jsx#handleGenerate`, `StoryboardsStage.jsx#handleGenerate`, `EpisodeVideoStage.jsx#handle*`. Returns `[run, running]`. Cross-cutting client cleanup, not WR↔Pipeline-specific — schedule with the next general DRY pass.
- [x] **4. Shared bible-extraction service** — shipped. `server/lib/bibleExtractor.js#extractBible({ kind, corpus, existing, context, providerOverride, source })` runs the staged LLM, pulls the `{ characters | settings | objects }` envelope, and routes through the canonical `sanitizeBibleList`. Returns the sanitized list + run metadata; the caller owns persistence (writers-room → `mergeExtractedX(workId, ...)`, pipeline → `mergeExtractedBible(series.<field>, extracted, kind)`) — splitting extraction from merge avoids the double-merge footgun. Writers-room evaluator's three bible SHAPERS (~75 LOC of duplicated field-trim) deleted; analysis path now goes `runAnalysis → extractBible → mergeExtractedX`. New pipeline route `POST /api/pipeline/series/:id/extract-bible` accepts `{ kinds, issueId, corpus, providerOverride }` and merges results into the series. New "Extract bibles" button on the Pipeline ProseStage that calls it. 12 lib tests + 4 route tests; full server pack 3746/3746 green.

- [x] **5. Shared scene-list extractor** — shipped. `server/lib/sceneExtractor.js#extractScenes({ source, sourceKind, characters, settings, objects, work, series, issue, providerOverride, tag })` mirrors the bibleExtractor.js pattern: caller owns persistence, extractor owns the LLM call + sanitization. Two source modes: `prose` routes through the existing `writers-room-script` prompt; `tvScript` routes through the new `pipeline-extract-scenes` prompt (parses already-present sluglines instead of inventing them). Shared `sanitizeSceneList` is the single source of truth for the canonical scene shape (`{ id, heading, slugline, summary, characters, action, dialogue, visualPrompt, sourceSegmentIds }`) — defensive, every field has a typed fallback so a partial LLM response never crashes downstream. Writers Room evaluator's `script` kind now delegates here (~25 LOC of duplicated SHAPERS.script logic deleted); Pipeline storyboards stage gains a "From TV script" + "From prose" button pair via `POST /api/pipeline/issues/:id/stages/storyboards/extract-scenes` (with a 409 + two-click-arm replace-confirm guard so an extraction can't silently obliterate hand-curated scenes). 14 unit tests + 4 route tests; full server pack 3765/3765 green. **Side fix:** `issuePatchSchema.stages` z.union order swapped so PATCH /issues/:id with a visual stage payload (`scenes` / `pages` / `cdProjectId` / `videoPath`) no longer silently strips those fields — the union picked the strict text-only schema first, hiding the visual fields.

- [x] **6. Pipeline ↔ Writers Room bridge** — shipped (one-way promote). New `server/services/writersRoom/promoteToPipeline.js#promoteWorkToPipeline(workId, { force })` creates a pipeline series + first issue from a writers-room work, carrying over (a) the active draft body → `stages.prose.output` with status `edited`, (b) the latest characters/settings/objects bibles → `series.{characters,settings,objects}` via the canonical sanitizer, and (c) the latest `script` analysis scenes → `stages.storyboards.scenes` with the same `visualPrompt → description` UI-shape alias the storyboards extractor route uses. Records the bidirectional link on both sides (`manifest.pipelineSeriesId` / `manifest.pipelineIssueId` on the WR work; `series.writersRoomWorkId` on the pipeline series). Idempotent by default — re-promoting a linked work returns the existing pair (`reused: true`) unless `{ force: true }`. If either linked record was deleted out-of-band, the stale link is dropped and a fresh series is created. **Re-sync action (one-way writers-room → pipeline on demand) deferred** — promote-once covers the user-stated need; re-sync needs UX work to communicate which fields will overwrite. Route `POST /api/writers-room/works/:id/promote-to-pipeline`. UI: "Promote to pipeline" menu item on `WorkEditor` (flips to "Open in pipeline" once linked); "Writers Room" badge on the `PipelineSeries` page header when `writersRoomWorkId` is set. **Side fix:** pipeline `series.js` + `issues.js` switched to lazy `statePath()` resolution (matching writers-room/local.js) — the previous eager `const STATE_PATH = join(PATHS.data, ...)` crashed under Proxy-based `PATHS.data` mocks that the new promote tests need. 8 service tests + 4 route tests.

- [x] **7. Shared prompt template partials** — shipped. New `server/lib/promptPartials.js` adds Mustache-style `{{> partial-name }}` include support as a pre-processing pass before `applyTemplate` — the existing engine stays sync + pure (`promptTemplate.js` unchanged); partial expansion lives in a sibling module that pre-loads referenced partials from `<promptsDir>/_partials/` via the buildPrompt shim. Recursive expansion with a MAX_DEPTH=8 cycle guard; missing partials throw loudly (typo in `{{> visual-grammr }}` doesn't silently drop the section). Two partials shipped: `_partials/bible-deference.md` (the character + setting bible deference blocks, identical across writers-room-script and pipeline-extract-scenes) and `_partials/scene-output-contract.md` (the canonical scenes[] JSON output shape). Both `writers-room-script.md` and `pipeline-extract-scenes.md` collapse onto these two includes — bug-fixes to bible-deference logic now land in one place. 16 unit tests covering listPartialReferences, sync resolver-based expansion, async fs-backed expansion, cycle detection, missing-partial throws, and the no-partial fast path. **Note for existing installs:** `scripts/setup-data.js`'s `ensureSampleContent` only copies missing files — a user who already has `data/prompts/stages/writers-room-script.md` from a prior install keeps their copy (which is the right default if they've customized it). To pick up the partial-using refactor, manually re-copy from `data.sample/prompts/stages/`.

**Testing strategy:** items 1, 2, 3 each have unit-test siblings already (`scenePrompt.test.js` lives next to the helpers; bible sanitizer + LLM runner get new test files). Items 4 & 5 need both unit tests (the extractor against a fixture prose) AND a small integration test that runs the writers-room and pipeline calling sites against the same input and asserts the same output shape — the whole point is one implementation, so the test should prove it.

---

## Pipeline — Story Arc Planning + Series Page Redesign

Today the PipelineSeries page (`client/src/pages/PipelineSeries.jsx`) is constrained to `max-w-5xl` and presents a single vertical scroll: bible metadata → characters → "Issues / Episodes" list with a one-line "New issue" input at the bottom. On a wide screen most of the viewport is wasted whitespace, and the only way to seed an issue is "type a title, click New, repeat." For a 24-episode show with a 3-season arc this is the wrong primitive — users want to plan the *whole arc* first, decide on the season/volume count, and only then drill into per-episode work.

This initiative adds a structural Arc → Season(s) → Issue hierarchy and the LLM scaffolding to plan top-down. Supersedes the prior "Series-arc grouping" backlog item. Ship in phases so each phase is independently reviewable.

### Phase 1 — Series page layout redesign (no schema change)

The bible/style/world panels move to a left sidebar; the right side becomes the structural canvas. Drop the `max-w-5xl` cap; use a responsive 2-column grid (`grid-cols-1 lg:grid-cols-[360px_minmax(0,1fr)]`) so the page actually uses the viewport at wider widths.

- Left sidebar (sticky, scroll-internal): NAME / TARGET FORMAT / LOGLINE / TARGET ISSUE COUNT / PREMISE / STYLE NOTES / LINKED WORLD / CHARACTERS. This is the "bible" — high-density inputs the user references but doesn't edit constantly.
- Right canvas: Today this is just "Issues / Episodes" — Phase 2 fills it with the Arc tree. For Phase 1 it gets a card-grid view of existing issues (each card showing number / title / status / last-updated / a thumbnail of the most-recent storyboards image) instead of the current text list.
- Collapsible left sidebar (so the canvas can expand to full width when the user is deep in episode work). Persists in localStorage like the existing Layout sidebar collapse.
- Mobile: stays single-column, sidebar reflows above the canvas.

Files: `client/src/pages/PipelineSeries.jsx`. No new server work.

### Phase 2 — Arc + Season schema (Series → Arc → Season → Issue)

Three new shapes; both stored on the existing `data/pipeline-series.json` (no new files — the arc is part of the series bible).

```js
// series.arc — overall multi-season story spine, optional
{
  logline: string,        // one-sentence arc pitch
  summary: string,        // ~500 words: act structure, season-by-season turning points
  themes: string[],
  protagonistArc: string, // character growth across all seasons
  status: 'draft' | 'verified',
}
// series.seasons[] — ordered list of seasons/volumes
{
  id: 'sea-<uuid>',
  number: 1,
  title: string,
  logline: string,
  synopsis: string,       // ~200 words
  episodeCountTarget: 8,  // user-set target; actual issues may differ
  themes: string[],
  endingHook: string,     // the line/image that pulls into season N+1
  status: 'draft' | 'verified' | 'in-production' | 'complete',
}
// issue.seasonId (existing issue schema gains an optional pointer)
{
  ...existing fields,
  seasonId: 'sea-...' | null,  // null for ungrouped issues (back-compat)
  arcPosition: number | null,  // ordinal within the season — drives auto-sort
}
```

- New `seasons` field on the series sanitizer with `sanitizeSeasonList()` in a new `server/lib/storyArc.js` (mirrors `storyBible.js` — canonical shape + sanitization + merge helpers).
- Issue sanitizer gains `seasonId` + `arcPosition` (back-compat: existing un-grouped issues keep `seasonId: null`).
- Service helpers: `listSeasons(seriesId)`, `createSeason(seriesId, input)`, `updateSeason(seriesId, seasonId, patch)`, `deleteSeason(seriesId, seasonId, { reassignTo: seasonId | null })` (reassigns child issues to a sibling or to null on delete).
- No DB migration needed — JSON files take additive fields cleanly.

Files: `server/lib/storyArc.js` (new), `server/services/pipeline/series.js`, `server/services/pipeline/issues.js`, `server/services/pipeline/seasons.js` (new), `server/routes/pipeline.js`. Route additions: `POST/PATCH/DELETE /api/pipeline/series/:id/seasons[/:seasonId]`. Tests follow the same pattern as `seriesService.test.js`.

### Phase 3 — LLM-assisted arc generation (new stage prompts)

Three new staged-LLM prompts in `data.sample/prompts/stages/`:

- **`pipeline-arc-overview`** (returns JSON `{ logline, summary, themes, protagonistArc, seasonOutlines: [{ number, title, logline, endingHook, episodeCountTarget }] }`). Inputs: series bible (name, logline, premise, characters, target format, target issue count). The model proposes a top-level arc + season breakdown. Default `model: 'heavy'` since this is the most expensive single call in the pipeline (reasoning over the full series scope).
- **`pipeline-season-episodes`** (returns JSON `{ episodes: [{ number, title, logline, synopsis, primaryCharacters, arcRole }] }`). Inputs: series bible + chosen season's outline + prior seasons' synopses (for continuity context). Generates the per-episode breakdown for one season. Called per-season so a user can revise season N's outline without re-generating earlier seasons.
- **`pipeline-arc-verify`** (returns JSON `{ issues: [{ severity, location, problem, suggestion }] }`). Inputs: full arc + all seasons + all issues. Sanity-checks for: character arcs that contradict across seasons, dropped subplots, episode-count mismatch vs. arc weight, unresolved hooks at the series finale.

Reuses the shared `stageRunner.js` so each call is replayable from `/runs`. All three stages register in `stage-config.json` and get the `_partials` treatment for the bible-deference block (same as `pipeline-extract-scenes.md`).

Service: `server/services/pipeline/arcPlanner.js` exposing `generateArcOverview(seriesId)`, `generateSeasonEpisodes(seriesId, seasonId, { force })`, `verifyArc(seriesId)`. Each returns `{ result, runId, providerId, model }` and the caller persists via `updateSeries`/`createSeason`/`createIssue` chains.

Routes: `POST /api/pipeline/series/:id/arc/generate`, `POST /api/pipeline/series/:id/seasons/:seasonId/episodes/generate`, `POST /api/pipeline/series/:id/arc/verify`.

### Phase 4 — Arc canvas UI (right-side replacement)

The Phase 1 card-grid evolves into a vertical Arc → Season → Episode tree:

```
┌─ Arc ──────────────────────────────────────┐
│ Logline: "..."                             │
│ Themes: [betrayal] [legacy]                │
│ [Edit arc]  [Verify arc]  [Regenerate]     │
└────────────────────────────────────────────┘

▶ Season 1 — "The Choir Awakens"           [12 episodes]
   Episode 1 — "First Light"               [draft]
   Episode 2 — "Hollow Bones"              [ready]
   ...
   [+ Add episode]  [Generate episodes (LLM)]

▶ Season 2 — "Diaspora"                    [8 episodes]
   ...

[+ Add season]  [Generate arc (LLM)]
```

- Each season collapsible (`<details>` semantics) — collapsed seasons show season # + title + episode count badge; expanded seasons show the issue rows + the "generate season" action.
- "Generate arc" runs `pipeline-arc-overview` and seeds `series.arc` + `series.seasons[]` after a preview/confirm modal (same two-click-arm pattern as the storyboards extractor).
- "Generate episodes" on a season runs `pipeline-season-episodes` and creates the issue records with `seasonId` set + `arcPosition` numbered sequentially.
- "Verify arc" surfaces findings inline as a sidebar list with severity badges, click-through to the offending season/episode.
- Drag-and-drop to reorder episodes within a season + move between seasons (updates `arcPosition` + `seasonId`). Deferrable to Phase 4b.

Files: `client/src/components/pipeline/ArcCanvas.jsx` (new), per-season `<SeasonRow>` + per-issue `<IssueRow>` subcomponents. Replaces today's flat "Issues / Episodes" list at the bottom of PipelineSeries.

### Phase 5 — Cross-season continuity hooks (deferrable)

Once seasons exist, the per-episode prose/script stages can inject "previous episode arc state" + "where we are in this season" into the prompt context automatically — the LLM stops re-inventing where the characters left off. New variable on issue prompts: `seasonContext` = the season's synopsis + the last 1–3 episodes' loglines. Plumbed through the existing `series` / `issue` prompt context object in textStages.js. Small once Phases 2–4 land; the work is mostly prompt-template edits.

### Out of scope / explicitly not doing

- Per-season independent media collections (one folder per season). The collection model is already per-series; per-season splits add UX complexity without clear value.
- Multi-series arcs (a season that spans two related series). Single-series scope keeps the data model flat and the LLM context bounded.
- Auto-promoting an existing flat list of issues into seasons. Users opt in via the "Generate arc" action; existing issues stay un-grouped (`seasonId: null`) until the user moves them.

### Suggested PR sequence

1. **Phase 1** standalone — pure UI refactor, no schema change. Easy review.
2. **Phase 2** standalone — schema + service + route + tests. No UI yet.
3. **Phase 3 + Phase 4 together** — the LLM prompts only have user value once the canvas surfaces them.
4. **Phase 5** standalone — small prompt-context follow-up.

---

## Pipeline — Deferred

Skeleton landed in `server/services/pipeline/` + `client/src/pages/Pipeline*.jsx`. The core text-to-video creative pipeline is now wired end-to-end (idea → prose → scripts → storyboards → episode video via CD handoff). Items below were scoped out and live here so they don't evaporate:

- [ ] **Wire `storyboards` scene-video rendering** as a separate path from the episode-video handoff. Currently storyboards records `imageJobId` per scene; add optional `sceneVideoJobId` so a user can render an individual scene's video without committing the full episode-video stitch.
- [ ] **Rich-text editor for prose stage.** Currently a plain `<textarea>` in `client/src/components/pipeline/stages/ProseStage.jsx`. Either reuse `client/src/components/writers-room/` editor, or pick a minimal markdown editor.
- [ ] **Versioning / diff view per stage.** No history right now — regenerating overwrites. Could persist last N `lastRunId` snapshots and offer a diff modal.
- [ ] **Episode-video provider picker (RunwayML / third-party).** Stubs are commented in `server/services/videoGen/`. Once that abstraction lands, the `episodeVideo` handoff should expose a provider picker on the EpisodeVideoStage UI (local LTX vs Runway vs …).
- [x] **Episode-video aspectRatio / quality picker on the UI** — shipped. Inline `aspectRatio` + `quality` dropdowns on EpisodeVideoStage's pre-kickoff toolbar, plumbed through to the existing route. modelId picker deferred until the video model registry exposes a flagged-stable list for the UI to read.
- [x] **Extract `ScenePreview` + shared CD status helpers** — shipped. New `client/src/components/creative-director/ScenePreview.jsx` owns the `<video controls poster>` + onError-missing-media + Retry + cache-bust idiom; `sceneStatus.js` exports `SCENE_STATUS`, `SCENE_STATUS_BADGE`, `SCENE_STATUS_LABEL`, `getSceneStatusBadge()`, `PROJECT_STATUS_LABEL`. SegmentsTab + EpisodeVideoStage both consume the shared components — EpisodeVideoStage's final-video render now has the missing-onError fallback for free (was hand-rolled and missing it). Side fix: the slim `?slim=1` CD projection was returning `scene.id` but CD scenes are keyed by `sceneId`; corrected the projection + its test fixture.
- [x] **Slim `GET /creative-director/:id?slim=1` endpoint** — shipped. Drops the unbounded `runs[]` history + full treatment text; returns just `{ id, status, updatedAt, finalVideoId, failureReason, treatment: { scenes: [{ id, order, status }] } }`. EpisodeVideoStage's 4s poll now passes `{ slim: true }` to the client API. 2 new route tests.
- [ ] **Series-arc grouping (Series → Arc → Issue).** Superseded by the "Pipeline — Story Arc Planning + Series Page Redesign" section below. Drop this entry once that initiative ships its Phase 1.
- [ ] **Comic-book PDF export.** Once `stages.comicPages` carries enough panel data + rendered images, export a print-ready PDF.
- [ ] **Voice-controlled stage advancement.** "Next stage", "rerun comic script" via the existing voice agent. Register pipeline stage navigation actions in `server/services/voice/tools.js`.
- [ ] **Recent-issues dynamic children under the Pipeline sidebar entry.** Currently Pipeline is a single sidebar link; could mirror Apps' `dynamic: 'apps'` pattern in `client/src/components/Layout.jsx`. **Wrinkle:** Apps is a TOP-LEVEL nav entry; Pipeline lives 2 levels deep under Create. The existing `renderNavItem`'s child render is flat — it emits a NavLink per child and ignores `child.children`. Needs either (a) recursive child render (cleaner, but bigger UX questions: indentation/collapsibility/auto-expand-depth) or (b) promoting Pipeline to a top-level nav entry (changes IA; might be the right call once it has its own subnav anyway). Attempted in this PR, backed out as out-of-scope.
- [ ] **AI-assisted panel/scene prompt generation.** Reserve `pipeline-comic-panel-image-prompt.md` and `pipeline-storyboard-image-prompt.md` template files for a future "AI: turn the script fragment into N image-gen prompts" button on the ComicPages and Storyboards stages.
- [ ] **Per-panel/scene image progress in the Pipeline UI.** Right now ComicPages and Storyboards record `jobId` but don't subscribe to the media-job SSE for live preview. Tie into the existing per-job progress hook so each panel shows live render thumbnails.
- [x] **Background auto-run resumption** — shipped as "demote on boot." New `recoverStuckAutoRuns()` in `autoRunner.js` walks issues at boot and demotes any `status: 'running'` to `needs-review` (the same terminal state a normal-completion path lands on). Wired into `server/index.js` next to the existing brain / writers-room boot recovery calls. 2 new tests. **Not implemented: actual resume** — re-attaching SSE and re-running the missing stages would need the persisted runId + per-stage progress, which we don't write to disk. Falling back to `needs-review` (the user clicks "Run again" if they want to retry) is the safe, low-blast-radius fix.
