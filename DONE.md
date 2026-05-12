# PortOS — Completed Milestones

Archive of completed work. For active roadmap, see [PLAN.md](./PLAN.md). For project goals, see [GOALS.md](./GOALS.md).

---

## 2026-05-12

- **Civitai / Z-Image follow-ups — six post-merge cleanups** — Six items off the "Civitai LoRA / Z-Image-Turbo follow-ups" backlog in one pass.
  - **`RUNNER_FAMILIES` constants module** — New `server/lib/runners.js` exports `RUNNER_FAMILIES = { MFLUX, FLUX2, Z_IMAGE, ERNIE }` (frozen) plus typed predicates; `client/src/lib/runnerFamilies.js` mirrors it (Vite fs.allow doesn't cross the server boundary). All bare-string usages in `server/lib/civitai.js` (`baseModelToRunner`, `RUNNER_TO_BASE_MODELS`), `server/lib/mediaModels.js` (`isFlux2`/`isZImage`/`isErnie`, flux2 upgrade path), `client/src/pages/ImageGen.jsx` (current runner gate), `client/src/lib/imageGenResolutions.js` (compatibility keys), `client/src/components/imageGen/ImageGenControls.jsx` (isFlux2 gate), and the `RUNNER_LABEL`/`RUNNER_BADGE_CLASS`/`RUNNER_LABELS_SHORT` maps + section list in `client/src/pages/Loras.jsx` now reference the canonical ids. Shape-invariant + mirror-sync tests in `server/lib/runners.test.js`.
  - **`listLoras` exports collision fix** — `server/services/imageGen/local.js#listLoras` renamed to `listLoraFilenames` so the minimal `{ filename, name }` shape can't be confused with `server/services/loras.js#listLoras` (rich Civitai-aware shape). Route + test mock updated.
  - **Generic `deepMerge` utility** — New `server/lib/objects.js#deepMerge` adopts the cleanest existing implementation (from `voice/config.js`). Three call sites collapsed: `services/voice/config.js`, `services/meatspacePost.js`, and `routes/loras.js#POST /auth/civitai`. Documents array-replacement + null-as-value semantics + missing-base tolerance; 10 unit tests cover override, null, missing-base (null/undefined/non-object), mutation guard, and the patch-not-an-object early return.
  - **`assertSafeFilename` helper** — New shared `server/lib/fileUtils.js#assertSafeFilename(filename, { extensions, subject, requiredMessage })` consolidates `services/loras.js#assertSafeLoraFilename` (`.safetensors`) and `services/imageGen/local.js#assertGalleryFilename` (`.png`). Rejects path separators, null bytes, exact `.`/`..`, and non-allowlisted extensions; case-insensitive extension match; enforces each extension starts with `.` (programmer-error otherwise); throws a 400 ServerError with code `VALIDATION_ERROR`. `requiredMessage` lets wrappers preserve their historical missing-input phrase. 13 unit tests in `fileUtils.test.js`.
  - **`mediaModels.js` drift warning** — `loadMediaModels()` now logs a loud `⚠️ media-models drift` warning at boot for any id present in BOTH `_shippedDefaults` AND `DEFAULT_REGISTRY` but missing from the user's live list. Catches the 2026-05-09 silent-drift class. No auto-recover — surfaces the bug, lets a human decide. Warning is honest that intentional deletions are indistinguishable from drift and will keep firing each boot. Covers `image` plus `video.macos` and `video.windows`. 4 new tests.
  - **CLI `defaultModel` for all CLI providers** — `services/runner.js#buildCliArgs` now appends `--model <id>` to claude-code (after `-p -`; claude-code parses flags positionally) and `-m <id>` to gemini-cli, gated on the provider's stored `args` not already containing `--model`/`-m` (both space- and `=`-joined forms; rejects dangling/empty flag forms). Codex behavior unchanged. New `hasModelFlag`/`extractBakedModel`/`stripBrokenModelFlags` helpers exported for reuse. Stage runner / message evaluator / media prompt refiner / world builder refiner per-call model overrides now actually take effect for all three CLIs instead of silently no-op'ing for claude-code and gemini-cli; refiners report the args-baked model id (not defaultModel) when a model is pinned in args. 15+ new tests + 2 regression tests; surfaced from Copilot review on PR #217 and #222.
- **Extract `scripts/_runner_common.py`** — Pulled the byte-for-byte-duplicated `pick_device` / `make_generator` / `apply_memory_optimizations` / `write_sidecar` / `make_stepwise_callback` / `_emit_user_error` / `_repo_from_hf_error` / HF cause-chain walker (~200 LOC) out of `scripts/flux2_macos.py` + `scripts/z_image_turbo.py` into a shared module. `make_stepwise_callback` now takes an optional `unpack_latents` callable so the flux2 packed-transformer-latent path stays runner-specific while the rest of the decode is shared. `install_hf_error_handler` is a `@decorator` over `main()` that owns the gated/notfound/401 dispatch — `if __name__ == "__main__": main()` collapses to one line in both runners. Mirrors the `lora_utils.py` extraction pattern. Server tests 4012/4012 green; both runners' `--help` resolves cleanly.

## 2026-05-10

- **Pipeline — Story Arc Planning (Phases 1–4 shipped)** — Four-phase rebuild of the PipelineSeries page from a flat issue list into a structural Arc → Season → Episode tree.
  - **Phase 1** — Two-pane layout: sticky bible sidebar (name, format, logline, premise, characters, etc.) + responsive card-grid canvas. Dropped `max-w-5xl` cap; sidebar collapses to a 48px rail (state in `localStorage['portos-pipeline-series-sidebar-collapsed']`); mobile reflows single-column.
  - **Phase 2** — Schema: `series.arc` (logline, summary, themes, protagonistArc, status), `series.seasons[]` (id, number, title, logline, synopsis, episodeCountTarget, themes, endingHook, status, timestamps), and `issue.seasonId` + `issue.arcPosition`. Backed by new `server/lib/storyArc.js` + `server/services/pipeline/seasons.js` (delete-with-reassign re-points child issues atomically). Routes: `GET/POST/PATCH/DELETE /api/pipeline/series/:id/seasons[/:seasonId]`. Pure additive — existing series.json round-trips unchanged.
  - **Phase 3** — Three LLM-driven passes via shared `stageRunner.js`: `pipeline-arc-overview` (proposes arc + season breakdown, `model: 'heavy'`), `pipeline-season-episodes` (per-season episode breakdown with continuity context from prior seasons), `pipeline-arc-verify` (cross-season continuity pass returning `{ severity, location, problem, suggestion }` findings). Backed by `server/services/pipeline/arcPlanner.js`. Routes: `POST /api/pipeline/series/:id/arc/generate`, `POST /api/pipeline/series/:id/seasons/:seasonId/episodes/generate`, `POST /api/pipeline/series/:id/arc/verify`. All accept `{ providerOverride, modelOverride }`; the first two accept `commit: true` to persist in one shot (default returns a preview).
  - **Phase 4** — `client/src/components/pipeline/ArcCanvas.jsx` (~640 LOC): collapsible Season rows with inline edit, episode rows with hover-revealed season picker for cross-season moves + delete, top-of-canvas arc card with logline/themes/collapsible summary + verify panel with severity-badged findings. Generate-arc + per-season-delete use the two-click-arm replace pattern. New client helpers in `apiPipeline.js` wrap all seven new server routes. PipelineSeries.jsx slimmed to a bible-sidebar + `<ArcCanvas />` composition.
  - **Phase 5 deferred** — `seasonContext` prompt injection in `textStages.js#buildStageContext`. Macro continuity already covered by the planning artifacts (series.arc.protagonistArc, season synopses, episode idea-seed); revisit only if executed per-episode prose breaks continuity in practice.
  - Tests: 18 storyArc unit + 13 seasons service + 11 arcPlanner unit + 17 route tests across Phases 2–3. Full server suite 3889/3889 green after Phase 4.
- **CoS agent dedup race fix** — `spawnAgentForTask` released the `spawningTasks` guard before the agent was queued to the runner, so a concurrent `task:ready` could slip a duplicate past the has-check. Spawn call is now wrapped in `try { spawnViaRunner | spawnDirectly } finally { spawningTasks.delete(task.id) }` (`server/services/agentLifecycle.js:536-547`). New behavioral race-repro + source-text regression guard in `agentLifecycle.test.js`; 3831 tests green.
- **Video Gen — FFLF keyframe-pair guidance** — `renderFramePanel` in `client/src/pages/VideoGen.jsx` gained a `hint` prop and an accent-coloured line under FFLF mode telling users to use keyframes that share scene geometry. Distinct styling from the experimental advisory.
- **Deprecate notapalindrome LTX models** — `ltx2_unified`, `ltx23_unified`, `ltx23_distilled_q4` carry `deprecated: true` in `server/lib/mediaModels.js` + the `data.sample/media-models.json` seed; VideoGen + Creative Director dropdowns group them under a `Legacy` `<optgroup>` below the active dgrauet models. `defaultMacos` deliberately stays on `ltx23_distilled_q4` because dgrauet requires an opt-in `INSTALL_LTX2=1` venv install — fresh installs need a model that works out of the box.
- **Step 4c — `useAsyncAction` hook** — `client/src/hooks/useAsyncAction.js` returns `[run, running]`. Migrated `ProseStage.jsx#handleExtract`, `TextStagePanel.jsx#handleSave` + `#handleGenerate`, and `EpisodeVideoStage.jsx#submit` onto the hook. `StoryboardsStage` stays on its keyed loading state pattern — boolean abstraction wouldn't fit.
- **Step 2b — Shared zod bible schemas** — `server/lib/validation.js` re-exports `characterBibleCreateSchema` / `settingBibleCreateSchema` / `objectBibleCreateSchema` under kind-neutral names; pipeline routes extend those with back-compat fields + `.passthrough()`. The loose `bibleEntrySchema = z.record(z.string(), z.any())` is gone. Single sanitizer enforces shape for both writers-room + pipeline.
- **Step 2a — `createBibleStore` factory** — `server/lib/storyBible.js#createBibleStore(...)` derives file paths and id regexes from `kind`; each writers-room domain file (characters / settings / objects) collapses to ~30 LOC. -281 LOC across the three files; 12 new factory tests in `storyBible.test.js`. Settings' slugline-aware dedup and "blank-both → reject" guard flow through the `dedupKey` callback and `validateAfterUpdate`.
- **Step 4b — Parallel bible extraction** — `extractBibleSchema` accepts `parallel: true`; the three kinds fan out via `Promise.all` for ~3× wall-clock speedup on HTTP-API providers. Default stays sequential — safe for CLI providers that serialize at session level. Merge runs after all kinds complete; baseline read once at top of the route.
- **Step 4a — `extractAndMergeIntoSeries`** — Bible extract → merge → patch orchestration lives in `server/services/pipeline/series.js`; the route shrinks to a single `seriesSvc.extractAndMergeIntoSeries(...)` call. `mergeExtractedBible` / `extractBible` no longer route-layer imports. Mirrors WR's `mergeExtractedCharacters(workId, extracted)`.
- **Step 4 — Shared bible-extraction service** — `server/lib/bibleExtractor.js#extractBible({ kind, corpus, existing, context, providerOverride, source })` runs the staged LLM, pulls the `{ characters | settings | objects }` envelope, and routes through canonical `sanitizeBibleList`. Caller owns persistence (avoids the double-merge footgun). Writers-room evaluator's three bible SHAPERS (~75 LOC) deleted; new pipeline route `POST /api/pipeline/series/:id/extract-bible` + an "Extract bibles" button on the Pipeline ProseStage. 12 lib tests + 4 route tests.
- **Step 3 — Shared staged-LLM runner** — `server/lib/stageRunner.js` exposes `runStagedLLM(stageName, variables, { providerOverride, modelOverride, returnsJson, source })` plus `resolveModel` (tier-aware) and `extractJson` (lenient code-fence stripper). Writers Room evaluator + Pipeline text stages both route through it; ~150 LOC of bespoke CLI-spawn drift deleted. WR analyses now persist transcripts to `data/runs/<runId>/` and pick up tier-name resolution for free. Per-stage temperature override dropped (toolkit's `executeApiRun` doesn't expose temp).
- **Step 2 — Unified story-bible schema** — `server/lib/storyBible.js` owns canonical `Character` / `Setting` / `Object` shapes + `sanitizeBibleList` + `mergeExtractedBible` with per-kind key normalizers. Writers-room domain files (`characters.js` / `settings.js` / `objects.js`) collapsed onto shared helpers (-299 LOC). Pipeline gains `series.settings[]` + `series.objects[]`; legacy `description` auto-promotes to `physicalDescription`. `composeVisualPrompt` activates the slugline-matching plumbed in step 1 — pipeline storyboard scenes that reuse a setting slugline get the canonical baseline prepended automatically.
- **Step 1b — `composeStyledPrompt` server mirror** — `server/lib/composeStyledPrompt.js` is the verbatim mirror of the client lib; World Builder's `compileBatchPrompts` now uses it for both variation + composite-sheet paths. Side effect: rendered prompts switch separator from `, ` to `. ` (the composeStyledPrompt convention) — semantically identical for diffusion models. 6 unit tests.
- **Step 1a — Drop `sceneCardHelpers.js` shim** — Constants moved to new `client/src/lib/wrImageDefaults.js`; SceneCard.jsx + StoryboardPanel.jsx now import `buildScenePrompt` / `matchScene*` / `normCharKey` directly from `client/src/lib/scenePrompt`. Shim file deleted.
- **Step 1 — Shared scene-prompt composer** — `server/lib/scenePrompt.js` + mirror `client/src/lib/scenePrompt.js` (Vite fs.allow doesn't reach across, follows the project's manual-mirror convention). Pipeline's `composeVisualPrompt` now routes through `buildScenePrompt` so series name + style + universal cast + scene visual all flow through one algorithm with PROMPT_MAX-budgeted truncation. Storyboards stage UI + route schema accept optional per-scene `slugline` so step 2's settings-bible match is plumbed end-to-end. 18 new unit tests.
- **EpisodeVideoStage aspectRatio + quality picker** — Inline `aspectRatio` + `quality` dropdowns on EpisodeVideoStage's pre-kickoff toolbar, plumbed through to the CD-handoff route. modelId picker deferred until the video-model registry exposes a flagged-stable list.
- **ScenePreview component + shared CD status helpers** — `client/src/components/creative-director/ScenePreview.jsx` owns the `<video controls poster>` + onError-missing-media + Retry + cache-bust idiom; `sceneStatus.js` exports `SCENE_STATUS*` constants + `getSceneStatusBadge()` + `PROJECT_STATUS_LABEL`. SegmentsTab + EpisodeVideoStage both consume the shared components — EpisodeVideoStage's final-video render gains the missing-onError fallback for free. Side fix: slim CD projection was returning `scene.id` but CD scenes are keyed by `sceneId`; projection + fixture corrected.
- **Slim `GET /creative-director/:id?slim=1`** — Drops unbounded `runs[]` history + full treatment text; returns `{ id, status, updatedAt, finalVideoId, failureReason, treatment: { scenes: [{ id, order, status }] } }`. EpisodeVideoStage's 4s poll now passes `slim: true`. 2 new route tests.
- **Pipeline auto-run resumption (demote on boot)** — `recoverStuckAutoRuns()` in `autoRunner.js` walks issues at boot and demotes any `status: 'running'` to `needs-review` (the same terminal state a normal completion lands on). Wired into `server/index.js` alongside brain / writers-room boot recovery. Actual resume deferred — re-attaching SSE + re-running missing stages needs the persisted runId + per-stage progress we don't write to disk. Falling back to `needs-review` is the safe, low-blast-radius fix.
- **Prompt template partials** — Step 7 of the Writers Room ↔ Pipeline DRY unification. PortOS's prompt engine now supports Mustache-style `{{> partial-name }}` includes via a new `server/lib/promptPartials.js` module. Implemented as a pre-processing pass: `buildPrompt` first calls `expandPartials` to inline `<promptsDir>/_partials/<name>.md` files (recursively, with a MAX_DEPTH=8 cycle guard and loud missing-partial throws), then hands the expanded text to the existing `applyTemplate` for the variable + section pass — so partials carry variable refs naturally and the existing engine stays sync + pure. First two partials shipped: `_partials/bible-deference.md` (character + setting bible deference preamble) and `_partials/scene-output-contract.md` (the canonical scenes[] JSON output shape). `writers-room-script.md` and `pipeline-extract-scenes.md` collapse onto these — bug-fixes to "use canonical character names" or "JSON output contract" logic now land in one place instead of N. 16 unit tests covering reference detection, sync + async expansion, cycle detection, missing-partial throws, and the no-partial fast path. Note: existing installs keep their customized stage prompts (`setup-data.js#ensureSampleContent` only copies missing files); to pick up the partial-using refactor on an existing install, manually re-copy from `data.sample/prompts/stages/`.
- **Writers Room ↔ Pipeline bridge — Promote to pipeline** — Step 6 of the DRY unification. New `server/services/writersRoom/promoteToPipeline.js#promoteWorkToPipeline(workId, { force })` lifts a WR work into the Pipeline in one call: copies the active draft body into `stages.prose.output` (status `edited`), the latest characters/settings/objects bibles into the new series (canonical sanitizer applied — wr-char-/wr-setting-/wr-object- ids preserved), and the latest succeeded `script` analysis scenes into `stages.storyboards.scenes` (with the same `visualPrompt → description` alias the storyboards-extractor route uses). Records the bidirectional link on both sides — `manifest.pipelineSeriesId` / `manifest.pipelineIssueId` on the WR work; `series.writersRoomWorkId` on the pipeline series — so the menu flips between "Promote to pipeline" and "Open in pipeline" without state. Idempotent: a second promote returns the existing pair (`reused: true`); pass `{ force: true }` for a fresh series. If either linked record is deleted out-of-band, the stale link is dropped and a fresh series is created. Route `POST /api/writers-room/works/:id/promote-to-pipeline`. UI: menu item on WR `WorkEditor`; "Writers Room" badge on PipelineSeries header when linked. Side fix: pipeline `series.js` + `issues.js` switched to lazy `statePath()` (matches writers-room/local.js convention) so the new tests' Proxy-based PATHS mocks load cleanly. 8 service tests + 4 route tests; full server pack 3777/3777.
- **Pipeline — Storyboards auto-fill from TV script or prose** — Step 5 of the Writers Room ↔ Pipeline DRY unification. New `server/lib/sceneExtractor.js#extractScenes({ source, sourceKind, characters, settings, objects, work, series, issue })` is the single LLM-driven scene-list extractor for both surfaces; mirrors the bibleExtractor pattern (extract→sanitize, caller persists). Two source modes: `prose` uses the existing `writers-room-script` prompt (paragraph-grain breakdown), `tvScript` uses the new `pipeline-extract-scenes` prompt (slugline-grain parse — one entry per teleplay slugline). Shared `sanitizeSceneList` owns the canonical scene shape; Writers Room evaluator's `script` kind now delegates here, deleting ~25 LOC of duplicated SHAPERS.script logic. Pipeline storyboards stage gains "From TV script" + "From prose" buttons via `POST /api/pipeline/issues/:id/stages/storyboards/extract-scenes` — disabled until the source stage has output, two-click-arm guard before replacing existing scenes. Extracted scenes alias `visualPrompt → description` for legacy storyboards-UI compat; rich fields (heading/summary/characters/action/dialogue/sourceSegmentIds) ride along untouched. **Side fix:** `issuePatchSchema.stages` z.union order swapped so visual-stage PATCH bodies (`scenes` / `pages` / `cdProjectId` / `videoPath`) no longer silently strip — the union evaluated the strict text-only schema first, hiding the visual fields. 14 unit tests + 4 route tests; full server pack 3765/3765.
- **Pipeline — episodeVideo wired end-to-end to Creative Director** — `POST /api/pipeline/issues/:id/stages/episodeVideo/visual` no longer returns 501. New `server/services/pipeline/episodeVideo.js#startEpisodeVideoForIssue` builds a CD treatment from the issue's storyboards scenes (series styleNotes prepended to each scene description, i2v continuation auto-enabled from scene 2 onward), creates a CD project with `autoAcceptScenes: true` + `disableAudio: true` (skips the LLM evaluator round-trip since the human already vetted the storyboards), persists `cdProjectId` on `stages.episodeVideo`, and kicks the CD orchestrator. Idempotent: re-POSTing returns the existing `cdProjectId` unless `force: true`. `EpisodeVideoStage.jsx` swapped its placeholder for a real UI that generates / restarts / polls the CD project (`getCreativeDirectorProject` on a 4s interval until terminal), surfaces per-scene render badges + a progress bar, and renders the final stitched `.mp4` inline when `cdProject.status === 'complete'`. `autoRunner.js` gained an optional `includeVideo` flag that fires the same handoff after text stages complete; a second "Run everything (incl. video)" button on the issue page opts users into it. Errors route through standard middleware (`ERR_NO_STORYBOARDS` → 400). 9 new tests + 1 rewritten (covers buildTreatmentFromStoryboards prompt composition, idempotency, force-restart, missing-storyboards rejection, includeVideo auto-run gating).

## 2026-05-09

- **Creative Director — i2v continuity fidelity (per-scene `imageStrength`)** — Added `imageStrength` (0..1, nullable) to `creativeDirectorSceneSchema` + `creativeDirectorSceneUpdateSchema`; `sceneRunner.resolveImageStrength` defaults continuation scenes (`useContinuationFromPrior=true`) to 0.85 and lets the evaluator override on retry. Already threaded through `videoGen/local.js#generateVideo` → mediaJobQueue. `creativeDirectorPrompts.js` surfaces the current setting on the evaluate view; `cd-treatment.md` / `cd-evaluate.md` document the knob; `TreatmentTab.jsx` shows "str X" on the scene chip. (PR #208)
- **CoS Workflow tab + canonical scheduled-task ordering** — New `/cos/workflow` page renders the full set of scheduled tasks + autonomous jobs as a left-to-right pipeline grouped into 7 canonical stages (Hygiene → Review → Plan → Audit → Build → Report → Ambient). Each card surfaces schedule, last-run, run count, enabled state, and live "due / waiting / disabled / waiting-on-dependencies" badge plus inline `runAfter` arrows. Backed by `server/services/workflow.js` + `routes/cosWorkflowRoutes.js` (`GET /api/cos/workflow`, `GET /api/cos/workflow/stages`). Two default `runAfter` wirings ship: `do-replan` runs after `pr-reviewer` + `branch-cleanup`, `feature-ideas` runs after `do-replan`. 16 new unit tests + 3 schedule tests. (PR #212)
- **World Builder for Media Gen** — `/media/world-builder` takes a one-line starter prompt (e.g. "moebius and scavengers reign meets Prophet inspired sci-fi universe") and asks the chosen LLM to expand it into a structured prompt set: positive `stylePrompt` prefix, `negativePrompt`, and 6–10 variations across five canonical buckets (landscapes, environments, characters, structures, vehicles). Per-template provider/model picker, batch-render compiles `stylePrompt + variation.prompt` for every selected bucket and queues through the existing image-gen pipeline (local mflux or Codex). Each batch lands in an auto-named Media Collection ("World: <name> — <timestamp>"). Backed by `server/services/worldBuilder.js`, `worldBuilderExpand.js`, `worldBuilderCollectionHook.js`, `routes/worldBuilder.js`. State in `data/world-builder.json`. 20 new tests. Nav manifest entry `nav.media.world-builder`. (PR #211)
- **Dismissible CoS Learning AI Recommendations** — Each recommendation in the Learning Analytics panel has an X to dismiss. Persists to `data/cos/dismissed-recommendations.json` and filters from future loads. Count-based alerts ("unknown errors occurred 74 times") record the count snapshot and only re-surface if the count grows ≥1.5× and at least +20. Rate-based recommendations stay dismissed until restored. "Show dismissed" expander lets you restore individually or clear all.
- **CoS review-loop tasks loop until clean and merge the PR** — Scheduled or user tasks running with worktree + openPR + reviewLoop now spawn a follow-up internal task once the PR is open and the initial Copilot review is requested. The follow-up agent attaches a fresh worktree to the PR branch (new `existingBranch` option on `createWorktree`), runs the full `/do:rpr`-style poll/fix/push/re-request loop until Copilot returns zero unresolved comments (or hits a 10-iteration guardrail), then `gh pr merge --squash --auto --delete-branch`. The follow-up's cleanup pass passes `skipMerge: true` so the worktree branch isn't re-merged on top of the squash-merge. GitLab MRs and other non-GitHub forges still skip the loop. (`server/services/agentLifecycle.js#spawnReviewLoopFollowUp`, `agentPromptBuilder.js#reviewLoopFollowUpSection`)
- **CyberCity v2 — Phase 1 operational legibility** — Per-building health glyphs, "needs attention" pane, search overlay, status filter chips (`CityFilterBar.jsx`), clickable HUD stats, hover preview with quick actions, mobile/touch support. Phase 2 (interactive systems map / drill-down + agent-paths) still pending — see [docs/features/cybercity-v2.md](./docs/features/cybercity-v2.md).
- **Better Audit follow-up — socket.js disconnect cleanup** — `socket.on('disconnect')` calls `shellService.detachSocketSessions(socket)` which transitively calls `unsubscribeSessionList(socket)` (`server/services/shell.js:217`). The cleanup the audit flagged as missing is wired correctly via the higher-level helper.

## 2026-05-06

- **Creative Director — multi-frame evaluator sampling** — `extractEvaluationFrames` in `server/lib/ffmpeg.js` probes total frames and writes 5 timeline-tagged samples; `sceneRunner.handleRenderCompleted` calls it before evaluator enqueue; `buildEvaluatePrompt` lists every frame with explicit late-intent guidance. Falls back to single thumbnail on extraction failure.
- **Creative Director — auto-accept watchdog** — `verifyVideoPlayable()` in `server/lib/ffmpeg.js` checks file-exists / size > 0 / ffprobe-can-read-at-least-1-frame before marking auto-accept; failures route through `handleRenderFailed` honoring `MAX_SCENE_RETRIES`.
- **Creative Director — smoke-test cost reduction** — `durationSeconds` 3s→2s + hidden `1:1-small` (384×384) aspect preset for the smoke fixture; ~63% pixel-frame cost reduction.
- **LTX-2.3 audio-to-video (a2v)** — `run_a2v` invokes `AudioToVideoPipeline.generate_and_save` with `--audio` (WAV/MP3) and optional first-frame conditioning. Multipart `uploadFields(['sourceImage','lastImage','audioFile'])`, `mode='a2v'` enum, fail-fast guards (`VIDEO_GEN_AUDIO_REQUIRED`, `VIDEO_GEN_AUDIO_MODE_MISMATCH`, `A2V_REQUIRES_LTX2`), client tile + audio picker, queue-boundary `audioFilePath` sanitization.
- **LTX-2.3 native video Extend on dgrauet** — `helperMode='extend'` + `extendFromVideoPath` threading in `videoGen/local.js`, `extendFromVideoId` in `routes/videoGen.js`, client routes Extend to native dgrauet path when model runtime='ltx2'. Legacy chained-i2v retained for `mlx_video` runtime. Tests cover route id resolution.

## 2026-04-28

- **Better Audit follow-up — bugs/perf/test quality** — Added `AbortSignal.timeout` to remaining fetch sites (`aiDetect.js`, `meatspacePostLlm.js`, `memoryEmbeddings.js` ×3, `telegramBridge.js`); fixed `httpClient.js` abort-listener leak via cleanup + `{ once: true }`; fixed `MessageDetail.jsx` iframe `load` listener leak via `{ once: true }`; parallelized `feeds.js` refresh with `Promise.allSettled` over `fetchAndParseFeed`; replaced vacuous `usage.test.js` typeof checks with real streak-calculation assertions; `cosRunnerClient.test.js` now uses `.rejects.toThrow` for capacity/spawn/kill/terminate paths; `subAgentSpawner.test.js` imports the real `selectModelForTask` instead of re-implementing it; added `loops.test.js`.
- **Ask Yourself — slice (b)** — Voice (`ui_ask`) + per-turn promotions ("Save as Brain note" / "Create CoS task" / "Attach to Goal…") with auto-pin to survive 30-day expiry; palette whitelist for `⌘K` → `Ask Yourself`; ask-intent classifier gates the voice tool to RAG-shaped phrasing only; barge-in cancels upstream `askService` stream via `AbortSignal`. 17 new tests; suite 2785/2785 green.

## 2026-04-24

- **Global Command Palette (`⌘K` / `Ctrl+K`)** — `client/src/components/CmdKSearch.jsx` + `server/lib/navManifest.js` (single source of truth) + `server/routes/palette.js` (manifest + action dispatch). Shared backbone with voice agent's `ui_navigate` so navigation, palette, and voice all resolve through one map. See CLAUDE.md "Command Palette & Voice Nav" for the entry shape every new page must register.
- **Customizable Dashboard with Saved Layouts** — Widget registry (`client/src/components/dashboard/widgetRegistry.jsx`, 15 widgets, 3 data-gated) + named layouts persisted to `data/dashboard-layouts.json` via `GET/PUT/DELETE /api/dashboard/layouts`. Built-in layouts: `default` / `focus` / `morning-review` / `ops`. Keyboard-accessible editor with reorder + add/delete + rename + save-as-new. Palette integration: `⌘K` → any layout name switches instantly. See CLAUDE.md "Dashboard Widgets & Layouts" for the widget contract.
- **Ask Yourself — slice (a)** — `/ask` and `/ask/:conversationId` live. `server/services/askService.js` orchestrates parallel retrieval across memory (hybrid) + brain notes + autobiography + goals + calendar with kind-weighted reranking. Three modes (`ask` / `advise` / `draft`). API providers stream SSE; CLI providers single-shot. Conversations persist to `data/ask-conversations/` with 30-day auto-expiry. 40 new tests; suite stayed green.
- **God file decomposition** — `routes/cos.js` (28-line index + 6 modular route files), `routes/scaffold.js`, `client/api.js` (split into 19 focused api*.js modules), `services/digital-twin.js` (split into 10 focused modules), `services/subAgentSpawner.js` (slimmed from monolithic to 192 lines, logic extracted across helper modules).

## 2026-04-21

- **Better Audit remediation — security & overrides** — Added root-package `overrides` for `path-to-regexp` (^8.4.2), `lodash` (^4.18.1), `basic-ftp` (^5.3.0), `follow-redirects` (^1.16.0), `brace-expansion` (^5.0.5), `socket.io-parser` (^4.2.6); upgraded `react-router-dom` to 7.5.2.
- **Better Audit remediation — code/DRY/bugs** — `pgQuoteIdentifier` helper in `routes/database.js`; `escapeJql` in `services/jira.js`; `atomicWrite` extracted to `lib/fileUtils.js`; `dataManager.js` uses `PATHS.data`; `brain.js` setTimeout cleared on close/error; `telegramClient.js` polling retry with 5s backoff; `clinvar.js` 5-minute AbortSignal; `loops.js` floating promise caught + logged; `systemHealth.js` wrapped in `asyncHandler`; SIGTERM/SIGINT graceful shutdown in `server/index.js`; `agents.test.js` and `socket.test.js` rewritten against real exports; autofixer log statements gained emoji prefixes.
- **Test coverage** — `cosRunnerClient.test.js` (37 tests, 497 lines), `agentActionExecutor.test.js` (27 tests), CoS routes (170 tests across 6 test files, 83-100% route coverage).

## 2026-03-31

- **Depfree audit (heavy mode)** — Removed 13 of 15 targeted packages (`uuid`, `cors`, `axios`, `multer`, `unzipper`, `node-telegram-bot-api`, `supertest`, `geist`, `globals`, `fflate`, `react-markdown`, `react-diff-viewer-continued`, `react-hot-toast`). ~1,100 lines of owned replacement code across 9 new files (`server/lib/uuid.js`, `httpClient.js`, `multipart.js`, `zipStream.js`, `telegramClient.js`, `testHelper.js`; `client/src/components/ui/Toast.jsx`; etc.). `@dnd-kit/*` and `recharts` deferred — replacement effort exceeds 300-line heavy-mode ceiling.

## 2026-03-20

- **Keyboard Shortcuts Help Modal** — Press `?` to show all keyboard shortcuts; global overlay with section grouping, accessible dialog

---

## 2026-03-18

- Fixed PromptManager.jsx fetch calls — response.ok checks now present on all endpoints
- Fixed memory.js sort comparison — now type-safe with NaN/Date.parse validation
- Fixed silent catch in useTheme.js — now has console logging instead of swallowing errors
- Fixed agentActionExecutor.js:137 — reformatted complex ternary for readability
- Fixed memorySync.js `rows[0]` — added optional chaining with nullish coalescing fallback
- Fixed db.js `rows[0]` — added optional chaining with empty object fallback
- Resolved hardcoded localhost in lmStudioManager.js/memoryClassifier.js — server-side connections to local LM Studio with env var overrides, not a bug
- Resolved empty `.catch(() => {})` in client files — `request()` in api.js already shows `toast.error()` centrally; catches just prevent unhandled rejection warnings
- Resolved silent catches in runner.js — intentional best-effort writes during error handling
- Resolved Settings.jsx:366 catch — error toast already fires via centralized `request()` handler
- DRY: Extended PATHS object with 15 new centralized path constants in fileUtils.js
- DRY: Migrated 36 files from local `__dirname`/`process.cwd()` path definitions to centralized PATHS
- DRY: Replaced 57 `mkdir({recursive:true})` calls across 26 files with `ensureDir()`/`ensureDirs()`

---

## Milestones

- [x] **M0-M3**: Bootstrap, app registry, PM2 integration, log viewer — Core infrastructure
- [x] **M4**: App Wizard — Register existing apps or create from templates. See [App Wizard](./docs/features/app-wizard.md)
- [x] **M5**: AI Providers — Multi-provider AI execution with headless Claude CLI
- [x] **M6**: Dev Tools — Command runner with history and execution tracking
- [x] **M8**: Prompt Manager — Customizable AI prompts with variables and stages. See [Prompt Manager](./docs/features/prompt-manager.md)
- [x] **M9**: Streaming Import — Real-time websocket updates during app detection
- [x] **M10**: Enhanced DevTools — Provider/model selection, screenshots, git status, usage metrics
- [x] **M11**: AI Agents Page — Process detection and management with colorful UI
- [x] **M12**: History Improvements — Expandable entries with runtime/output capture
- [x] **M13**: Autofixer — Autonomous crash detection and repair. See [Autofixer](./docs/features/autofixer.md)
- [x] **M14**: Chief of Staff — Autonomous agent manager with task orchestration. See [Chief of Staff](./docs/features/chief-of-staff.md)
- [x] **M15**: Error Handling — Graceful error handling with auto-fix. See [Error Handling](./docs/features/error-handling.md)
- [x] **M16**: Memory System — Semantic memory with LLM classification. See [Memory System](./docs/features/memory-system.md)
- [x] **M17**: PM2 Config Enhancement — Per-process port detection and CDP_PORT support
- [x] **M18**: PM2 Standardization — LLM-powered config refactoring
- [x] **M19**: CoS Agent Runner — Isolated PM2 process for agent spawning. See [CoS Agent Runner](./docs/features/cos-agent-runner.md)
- [x] **M20**: AI Error Handling — Enhanced error extraction and CoS integration
- [x] **M21**: Usage Metrics — Comprehensive AI usage tracking and mobile UI
- [x] **M22**: Orphan Auto-Retry — Automatic retry for orphaned agents
- [x] **M23**: Self-Improvement — Automated UI/security/code analysis with Playwright
- [x] **M24**: Goal-Driven Mode — COS-GOALS.md mission file and always-working behavior
- [x] **M25**: Task Learning — Completion tracking and success rate analysis
- [x] **M26**: Scheduled Scripts — Cron-based automation with agent triggering
- [x] **M27**: CoS Capability Enhancements — Dependency updates, performance tracking, learning insights
- [x] **M28**: Weekly Digest UI — Visual digest with insights and comparisons
- [x] **M29**: App Improvement — Comprehensive analysis extended to managed apps
- [x] **M30**: Configurable Intervals — Per-task-type scheduling (daily, weekly, once, on-demand)
- [x] **M31**: LLM Memory Classification — Intelligent memory extraction with quality filtering
- [x] **M32**: Brain System — Second-brain capture and classification. See [Brain System](./docs/features/brain-system.md)
- [x] **M33**: Soul System — Digital twin identity scaffold management. See [Soul System](./docs/features/soul-system.md)
- [x] **M34 P1-P2,P4**: Digital Twin — Quantitative personality modeling and confidence scoring. See [Digital Twin](./docs/features/digital-twin.md)
- [x] **M35**: Chief of Staff Enhancement — Proactive autonomous agent with hybrid memory, missions, LM Studio, thinking levels. See [CoS Enhancement](./docs/features/cos-enhancement.md)
- [x] **M35.1**: CoS UI — Added Arcane Sigil (3D) avatar style option alongside Cyberpunk 3D
- [x] **M36**: Browser Management — CDP/Playwright browser page with status, controls, config, and logs
- [x] **M37**: Autonomous Jobs — Recurring scheduled jobs that the CoS executes proactively using digital twin identity
- [x] **M38**: Agent Tools — AI content generation, feed browsing, and autonomous engagement for Moltbook agents
- [x] **M39**: Agent-Centric Drill-Down — Redesigned Agents section with agent-first hierarchy, deep-linkable URLs, and scoped sub-tabs
- [x] **M40**: Agent Skill System — Task-type-specific prompts, context compaction, negative routing examples, deterministic workflow skills. See [Agent Skills](./docs/features/agent-skills.md)
- [x] **M41**: CyberCity Immersive Overhaul — Procedural synthwave audio, enhanced post-processing, reflective wet-street ground, settings system
- [x] **M42 P1-P4**: Unified Digital Twin Identity System — Identity orchestrator, chronotype derivation, personalized taste prompting, behavioral feedback loop, mortality-aware goal tracking, Identity Tab UI dashboard
- [x] **M43**: Moltworld Platform Support — Second platform integration for AI agents in a shared voxel world
- [x] **M44 P1-P7**: MeatSpace — Health tracker with death clock, LEV 2045 tracker, alcohol logging, blood/body/epigenetic/eye tracking, lifestyle questionnaire, TSV import, dashboard widget, compact grid overview, genome/epigenetic migration cleanup, Apple Health integration
- [x] **M45**: Data Backup & Recovery — Rsync-based incremental backup with SHA-256 manifests, PostgreSQL pg_dump, configurable cron schedule, restore with dry-run preview and selective subdirectory restore, Dashboard widget with health status
- [x] **M46**: Unified Search (Cmd+K) — Global search across brain, memory, history, agents, tasks, and apps
- [x] **M48 P1-P10**: Google Calendar Integration — MCP push sync, direct Google API via OAuth2, subcalendar management, goal-calendar linking, daily review, auto-configure via CDP, color-coded events, 15-min Day/Week views, Life Calendar consolidated under Calendar > Lifetime
- [x] **M49 P1-P4**: Life Goals — Enhanced goal model with todos, progress percentage, velocity tracking, projected completion, time tracking aggregates, AI phase planning, calendar time-blocking, automated weekly check-ins with status tracking
- [x] **M50 P1-P7**: Email Management — Outlook API+Playwright sync, AI triage with security hardening, draft generation, thread capture, per-action models, full Messages UI, Gmail API sync+send
- [x] **M51**: Memory System PostgreSQL Upgrade — PostgreSQL + pgvector backend with HNSW vector search, tsvector full-text search, federation sync, and pg_dump backup integration
- [x] **M52**: Update Detection — GitHub release polling with semver comparison, auto-check every 30 min, Socket.IO real-time notifications, Update tab UI with progress tracking, update executor with health polling
- [x] **M53**: POST (Power On Self Test) — Daily cognitive self-test with mental math drills (P1) and LLM-powered wit & memory drills (P2)
- [x] **M54**: MeatSpace Life Calendar — "4000 Weeks" mortality-aware time mapping with responsive grid, goal-activity linking, and time feasibility analysis
- [x] **M55**: POST Enhancement — Memory builder, imagination drills, training mode, 5-min balanced sessions, wordplay training (4 game modes). See [POST](./docs/features/post.md)
- [x] **M56**: Telegram Bot Integration — External notification channel via Telegram bot with conversational commands, goal check-in persistence
- [x] **GSD Tab**: Smart State Detection, One-Click Agent Spawn, Actionable Dashboard
- [x] **Database Management**: Native PostgreSQL mode (reuses system pg on port 5432), Docker/native switching UI, resource stats, sync/start/stop/destroy controls, per-backend backup buttons
- [x] **Review Hub**: Aggregated review page with alerts, CoS actions, todos, daily briefings, fullscreen toggle, markdown rendering
- [x] **JIRA Sprint Manager**: Autonomous JIRA triage and implementation as opt-in per-app scheduled task. See [JIRA Sprint Manager](./docs/features/jira-sprint-manager.md)
- [x] **App Icons + Non-PM2 Support**: App icon detection/display for iOS/macOS/Swift projects, non-PM2 app type management (Swift/Xcode)

---

## Code Audits

See [Security Audit](./docs/SECURITY_AUDIT.md) for the 2025-02-19 security hardening (all 10 items resolved).

### Audit Findings (2026-03-05) — Resolved

Items fixed from audit Passes 1-3 (PRs #67-72):
- App status computation duplication (apps.js) — unified
- TOCTOU race in addTask/updateTask/deleteTask — withStateLock mutex added
- Fetch timeouts missing in cosRunnerClient.js — fetchWithTimeout added to all calls
- Socket.IO infinite reconnection — capped to 10 attempts with error handler
- Data race in memory.js loadMemory() — withMemoryLock applied
- Duplicate getDateString — centralized in lib/fileUtils.js
- Duplicate HOUR/DAY constants — centralized in lib/fileUtils.js
- Missing fetch timeouts in moltworld/moltbook api.js — timeout-aware patterns added
- ChiefOfStaff.jsx useState hooks — reduced from 24 to 19

**Known low-severity:** pm2 ReDoS (GHSA-x5gf-qvw8-r2rm) — no upstream fix, not exploitable via PortOS routes.

---

## Documentation

### Architecture & Guides
- [Architecture Overview](./docs/ARCHITECTURE.md) - System design, data flow
- [API Reference](./docs/API.md) - REST endpoints, WebSocket events
- [Contributing Guide](./docs/CONTRIBUTING.md) - Code guidelines, git workflow
- [GitHub Actions](./docs/GITHUB_ACTIONS.md) - CI/CD workflow patterns
- [PM2 Configuration](./docs/PM2.md) - PM2 patterns and best practices
- [Port Allocation](./docs/PORTS.md) - Port conventions and allocation
- [Security Audit](./docs/SECURITY_AUDIT.md) - 2025-02-19 hardening audit (all resolved)
- [Troubleshooting](./docs/TROUBLESHOOTING.md) - Common issues and solutions
- [Versioning & Releases](./docs/VERSIONING.md) - Version format, release process

### Feature Documentation
- [Agent Skills](./docs/features/agent-skills.md) - Task-type-specific prompt templates and routing
- [App Wizard](./docs/features/app-wizard.md) - Register apps and create from templates
- [Autofixer](./docs/features/autofixer.md) - Autonomous crash detection and repair
- [Brain System](./docs/features/brain-system.md) - Second-brain capture and classification
- [Browser Management](./docs/features/browser.md) - CDP/Playwright browser management
- [Chief of Staff](./docs/features/chief-of-staff.md) - Autonomous agent orchestration
- [CoS Agent Runner](./docs/features/cos-agent-runner.md) - Isolated agent process management
- [CoS Enhancement](./docs/features/cos-enhancement.md) - M35 hybrid memory, missions, thinking levels
- [Digital Twin](./docs/features/digital-twin.md) - Quantitative personality modeling
- [Error Handling](./docs/features/error-handling.md) - Graceful error handling with auto-fix
- [Identity System](./docs/features/identity-system.md) - Unified identity architecture (M42 spec)
- [JIRA Sprint Manager](./docs/features/jira-sprint-manager.md) - Autonomous JIRA triage and implementation
- [Memory System](./docs/features/memory-system.md) - Semantic memory with LLM classification
- [Messages Security](./docs/features/messages-security.md) - AI prompt injection threat model and defenses
- [POST](./docs/features/post.md) - Cognitive self-test and training system
- [Prompt Manager](./docs/features/prompt-manager.md) - Customizable AI prompts
- [Soul System](./docs/features/soul-system.md) - Digital twin identity scaffold
