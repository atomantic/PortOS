# PortOS — Development Plan

For project goals, see [GOALS.md](./GOALS.md). For completed work, see [DONE.md](./DONE.md).

---

## Next Up

1. **Universe-as-Canon Phase 2 UI** — fold canon into UniverseBuilder, retire the standalone Canon page + route, retire `universe.categories` on the schema. (Backbone shipped; UI still on the two-page split.)
2. **Step-by-step approval/lock UX across Universe → Series → Arc → Seasons → Episodes.** Iteration 1 shipped a single arc-level lock; extend to per-season + per-field locks, lock the bulk runners, surface stage-progress strip, enforce locks server-side before LLM invocations.
3. **Sharing v2 contracts** — per-peer subscription filenames (`sub-<kind>-<recordId>-<senderInstanceId>.json`), tombstone-based item removals, "🔄 live" badge on inbox subscription rows.
4. **Pipeline continuity gaps** — plumb character physicalDescription/personality/background into idea-stage prompt; plumb setting `palette`/`era`/`weather`/`recurringDetails` into visual stages; add `worldEntitiesSummary` to text stages; add a dedicated `voice` / speech-pattern field to the bible schema.
5. **AI Toolkit hardening** — toolkit-side Zod validation on POST/PUT providers; preserve non-sentinel codex `models[]` entries during migration; try/catch around `loadProviders` JSON.parse with `.corrupt` fallback; end-to-end test for `createProvider` field parity.

## Backlog

### Sharing

- [ ] **Content-addressed asset dedup.** Today asset copies skip-if-filename-exists. Hash-based dedup would let multiple manifests share the same blob even when filenames differ.
- [ ] **Extend `syncOrchestrator` to cover pipeline/universe over Tailscale.** Same-network peers should sync these categories without going through a bucket.
- [ ] **Multi-hop provenance chains.** Re-share authors a fresh `origin` block; `chain[]` would preserve full attribution. Defer until users ask.
- [ ] **Same collection-export pattern for pipeline series with auto-collections.** Series renders that get auto-filed into a per-series collection should also flow through `manifest.collection`.

### Importer

- [ ] **Chunked extraction for source > 200K chars.** Today's `IMPORTER_SOURCE_CHAR_LIMIT` hard-rejects. Once a real import hits the cap, route through per-chunk canon extraction + rolling synopsis. Investigate chunk-overlap / merge strategy first.
- [ ] **Auto-detect content type.** A small `importer-classify.md` stage runs first and pre-selects the radio (still user-editable).
- [ ] **Re-running an import to replace (not append) an existing series.** Destructive-confirm UX with a "Replace all" toggle.
- [ ] **Importer review UI: extract `<CanonCard>` once Universe-as-Canon Phase 2 lands.** Today renders an inline minimal card in `Importer.jsx#CanonReviewSection`.
- [ ] **[PERF] `updateAt` re-render cost in `Importer.jsx`.** Wrap issue/arc cards in `React.memo` or move inline edits into per-card local state that lifts on blur. ~50 issues + 500K-char `proseExcerpt` displays go sluggish.
- [ ] **Centralise `ARC_ROLES` source-of-truth + expose `ARC_SHAPE_IDS` via `/importer/config`.** Drop the client-side `IMPORTER_ARC_ROLES_FALLBACK` to avoid drift from `server/lib/storyArc.js#ARC_ROLES`.
- [ ] **Importer screenplay prompt — clarify `targetIssueCount` default vs user-requested.** Pass a separate `isUserRequestedCount` flag and gate the split logic on that.
- [ ] **Importer partial-commit retry — guard against arc re-apply.** When `commitImport` rolls back issues mid-loop, a naive retry overwrites server-side arc edits. Version the arc or return a tagged response telling the client to skip arc on retry.
- [ ] **Importer review UI: in-place `proseExcerpt` edit affordance.** Collapsed-by-default textarea per issue card so the user can trim/correct without re-running Analyze (which burns 3 heavy-tier LLM calls).

### Universe-as-Canon — Phase 2 + extensions

- [ ] **Extract shared `CanonCard`.** Pull `CanonCard` + `KindSection` out of `UniverseCanon.jsx` into `client/src/components/universe/CanonCard.jsx`. Add lock-toggle icon, "from series: <name>" provenance badge, tag chips. Disable Refine + Render when locked.
- [ ] **Fold canon into `UniverseBuilder.jsx`.** Replace the categories grid with three kind-sections (Characters / Settings / Objects) using shared `CanonCard`. Move "Extract from prose" into header. Keep composite sheets unchanged.
- [ ] **Retire the standalone Canon page + route.** Replace `UniverseCanon.jsx` with a Navigate redirect (or delete + drop the route). Update `navManifest.js` + sidebar + tests.
- [ ] **Retire `universe.categories` on the schema.** After UI no longer reads it, drop from `sanitizeTemplate`, route Zod schemas, expand prompt template, `mergeCategoriesWithLocks`, `compilePrompts`'s `'variations'`/`'all'` branches.
- [ ] **Universe expand LLM contract enrichment.** Ask the LLM directly for `characters[]` / `settings[]` / `objects[]` with rich narrative metadata alongside visual `prompt`.
- [ ] **Settings → Places kind rename.** `BIBLE_KIND.SETTING → BIBLE_KIND.PLACE`, `BIBLE_FIELD[SETTING]: 'settings' → 'places'`. Touches ~20 files. Stick the rename to bible context — app settings stays as "settings".
- [ ] **Use rendered reference images as i2i anchors in downstream comic-page renders for models that support it.** SDXL/Flux pipelines anchor every panel render on the per-character rendered ref.

### Pipeline continuity / approval

- [ ] **Extraction after comicScript / teleplay stages.** Decide whether to also run extraction post-script or accept the gap for minor characters introduced only at script time.
- [ ] **Solidify character descriptions before visual render.** "Solidify characters" action in the bible sidebar runs an LLM pass synthesizing one canonical `physicalDescription` from all accumulated evidence.
- [ ] **Resolve-issues inherits verify gaps.** Verify the resolve prompt USES episode synopses when patching the arc.

### Creative Director / Audio

- [ ] **Whole-episode audio generation strategy.** Stop relying on per-clip audio; drive audio gen from episode-level prose/script arc. Generator candidates: Suno (commercial, duration control), MusicGen-MLX (local, bounded ~30s), AudioLDM2. New `audioMode: 'per-clip' | 'silent' | 'generated' | 'uploaded-track'`. Treat as a new sub-brainstorm when picked up — investigation first.
- [ ] **Render slowness on long sessions.** Per-scene render time degraded from ~3.5 min to 10–30 min within one project. Profile after sustained use; verify round-22 dedup helped.
- [ ] **Pipeline Audio Phase 4c.2/4c.3/4d.2.** Local OSS music gen (MusicGen sidecar; pick generator first); 3rd-party engine stubs; VO line muxing into the CD stitch with per-line offsets + music-bed ducking.
- [ ] **Voice picker on character cards.** `voiceId` binding via dropdown on `CanonCard` when `kind === 'character'`; audition button hitting `/api/pipeline/tts/preview`. Same picker re-usable as per-line override in `AudioStage.jsx`.

### Video Gen (LTX-2.3)

- [ ] **Native FFLF deeper test on real keyframe pairs.** Validate with last frame of clip A + first frame of clip B from the same scene; expose more pipeline knobs (cfg-scale, stg-scale, stage1-steps) if interpolation looks weak.

### CoS / Agent lifecycle

- [ ] **TUI providers in manual `/api/runs`.** Add a TUI-specific runner branch in `server/lib/aiToolkit/routes/runs.js` so devtools manual runs also open attachable shell sessions.
- [ ] **Extract `finalizeAgent` helper shared across spawn paths.** Completion sequence is duplicated in `agentTuiSpawning.js`, `agentCliSpawning.js`, and `agentLifecycle.js#handleAgentCompletion`. A divergence in any leg silently breaks one path.
- [ ] **Wrap `runnerAgents.delete` in `handleAgentCompletion` body with try/finally.** A throw from `completeAgent` / `completeAgentRun` / `updateTask` / `processAgentCompletion` leaks the runner-agents Map entry forever. Regression-pin tests in `agentLifecycle.test.js` document the gap.
- [ ] **Shared `isTuiProvider` helper + client palette helper.** Mirror `isClaudeCliProvider`. Add `isTuiProvider` + lift `providerTypeClass` from `AIProviders.jsx` into `client/src/utils/providers.js`.
- [ ] **`spawnTuiAgent` / `spawnDirectly` options-object refactor.** Convert 11 positional args + deps to a single options object before the surface area grows.
- [ ] **Wrap `createShellSession` for agent TUIs.** Move callback/initial-command wiring into a thin `createAgentTuiSession()` in `agentTuiSpawning.js` that registers its own `pty.onData`.

### Voice agent

- [ ] **Voice CoS tool expansion** — `calendar_today` / `calendar_next` (existing Google Calendar MCP), `meatspace_log_workout` (wraps `meatspaceHealth.js`), `weather_now` (pick API: OpenWeather / WeatherKit / NWS), `timer_set` (reuses `agentActionExecutor.js`).
- [ ] **Wire proactive CoS speech to real triggers.** Plumbing landed (`POST /api/voice/speak` + `voice:speak` socket event); hook to high-severity `errorEvents`, `task:ready`, and `notificationEvents` with per-source rate-limits.
- [ ] **Optimize `voice:ui:index` text payload.** Lazy: only run `extractVisibleText` when server requests via `voice:ui:read-request`. Keep current behavior as fallback.
- [ ] **Voice agent vision fallback** — `ui_describe_visually`: screenshot tab and send to a vision-capable model so "what's on this chart?" works on CyberCity / graph views.
- [ ] **Voice agent — explicit long-term memory routing.** On retrieval-shaped voice turns, inject top-N relevant memories into the system prompt via `brain_search`.

### Writers Room / CyberCity / Email

- [ ] **Writers Room Phases 4–5.** Phase 4 synced prose/script/media review; Phase 5 realtime CD feedback. Builds on the unified bible/scene model. See [writers-room.md](./docs/features/writers-room.md).
- [ ] **CyberCity v2 Phase 2+** — deeper drill-down: per-agent spatial trail, system flow lines between buildings, recent-action timeline overlay. See [cybercity-v2.md](./docs/features/cybercity-v2.md).
- [ ] **M50 P9 — CoS Automation & Rules.** Automated email classification, rule-based pre-filtering, email-to-task pipeline.
- [ ] **M50 P10 — Auto-Send with AI Review Gate.** Per-account/per-recipient trust level + dual-LLM review (drafter + reviewer). Auto-send only when both approve or trust ≥ 0.9. See [messages-security.md](./docs/features/messages-security.md).
- [ ] **M34 P5-P7 — Digital Twin.** Multi-modal capture (voice/video/image identity sources), advanced testing, personas. Ties to GOALS.md "Multi-Modal Identity Capture".

### Image / Video Gen UI

- [ ] **Multi-reference image editing for FLUX.2.** UI accepting 2+ reference images + edit prompt. Swap registry's 9B entry to `FLUX.2-klein-9B-kv` for 2.5× speedup on multi-reference workflows. Gated repo — request access.
- [ ] **World Builder Phase 2 — external SD-API + per-bucket model overrides.** Wire Together / Replicate / Fal into world-builder batch path so high-end renders are practical; let each bucket pick its own model.
- [ ] **Unify VideoGen `RESOLUTIONS` with shared image-gen list.** Move to `client/src/lib/videoGenResolutions.js` (or extend imageGenResolutions with `media: 'image'|'video'`) so dropdown + custom-fallback live in one place.

### Code quality / dedup (from `/simplify` passes)

- [ ] **Promote `resolveGalleryImage` to `server/lib/fileUtils.js`.** Basename + `resolvePath` + `startsWith(imagesRoot)` security check reimplemented in 5 places (videoGen, imageGen, visualStages, sceneRunner, imageGen/local). Pick up the `isFile()` symlink-following defense the four non-videoGen sites are missing.
- [ ] **Route-level tests for proof/final `target` + `useProofAsBase`.** Three test cases on `comicPageRenderSchema` + `comicCoverRenderSchema`.
- [ ] **Extract `useSwipeNav` hook + `lib/clipboard.js`.** `MediaLightbox` swipe nav; clipboard inlined across 8+ call sites. Clipboard can move now.
- [ ] **Route `MediaLightbox` settings drawer through `components/Drawer.jsx`.** Reconcile `Drawer`'s flat Esc handler with the lightbox's layered Escape cascade.
- [ ] **Extract `<ModelSelect>` component for the active+Legacy optgroup pattern.** `VideoGen.jsx` + `CreativeDirector.jsx` render identical blocks differing only in `m.name` vs `m.name || m.id`.
- [ ] **Extract `mockPathsDataRoot()` test helper.** 6 test files open with byte-identical PATHS mocking setup.
- [ ] **`useAsyncAction` post-unmount setState guard.** Add `mountedRef` to gate `setRunning(false)`. YAGNI today; do at 4th consumer.
- [ ] **Extract `CollectionPickerShell` from `AddToCollectionMenu` + `BulkTargetPicker`.** Two near-identical portal popovers. While extracting, accept a `collections` prop so `MediaCollectionDetail` avoids per-mount `listMediaCollections` round-trip.
- [ ] **Server-side bulk endpoint for collection items.** `POST /api/media/collections/:id/items/bulk` taking `{ add, remove }` — single read-modify-write per collection. Halves wall-clock for Move; dodges N-call race window. Real use case: "select all" on world-builder collections with 50+ items.
- [ ] **Drop legacy `description` fallback in `sanitizeCharacter`.** Migrate `series.characters[].description` → `physicalDescription`; drop `|| raw.description` at `storyBible.js:246`.
- [ ] **Migrate `worldBuilderRefine.runRefine` onto `runPromptThroughProvider`.** Last LLM-runner site still hand-rolling the createRun → branch → executeApi/CliRun → accumulate-text pattern. ~30 LOC dedup.
- [ ] **Extract `usePersistedState` hook.** Six components repeat `useState(() => localStorage.getItem(KEY) === '1')` + setter. Add `useLocalStorageBool(key, default)` + JSON-blob variant.
- [ ] **Lift `runFfmpegProcess({ args, signal, stderrTailBytes }) → { ok, reason }` into `server/lib/ffmpeg.js`.** Three sites share spawn → stderr-tail → close → SIGTERM-on-abort. Leave `videoTimeline/local.js` (broadcast complicates it).
- [ ] **Scene-level wardrobe picking.** Per-scene `characterAppearances: [{ characterId, wardrobeId? }]` on storyboard scenes with wardrobe-picker dropdown. Decide first: does the extractor guess or does the user pick? Append wardrobe after physicalDescription vs substitute body fields?
- [ ] **Extract `sanitizeListWith(raw, sanitizer, cap)` helper in `storyBible.js`.** Three array-walk + per-item sanitize + cap sites.
- [ ] **Extract `useCanonPatch(universe, setUniverse, universeId, mountedRef)`.** `UniverseCanon.jsx` + `NounsStage.jsx` 95% identical optimistic-patch handlers. Extract when a 3rd caller appears.
- [ ] **AbortSignal listener cleanup in `audioMux.js#runFfmpeg`.** `addEventListener('abort', kill, { once: true })` never removed on normal completion. Theoretical until the stitch step passes a signal.
- [ ] **Extract `listDirectoryByExtension(dir, { extensions, mapEntry })`.** Three readdir + filter + stat-per-entry sites in `fileUtils.js`.
- [ ] **Teach `request()` in `apiCore.js` about FormData.** Drop hard-coded `Content-Type: application/json` when body is FormData. Two helpers (`apiHealth#uploadAppleHealthXml`, `apiPipeline#uploadPipelineMusicTrack`) bypass `request()` today.
- [ ] **`mergeVariations` NPE guard in `UniverseBuilder.jsx`.** Add `.label?.toLowerCase()` + `.filter(Boolean)` parity to the locked variations Set (post-rename file/line drift — agent confirmed line 57 still lacks the guard).
- [ ] **Client tests for deep routing + drag.** Smoke tests for `goToWorld(id)` URL transitions and chip-reorder ordering (mock `useSortable`).
- [ ] **`useMediaAnnotations.getCardProps(key)` helper.** Single `{ starred, hasNote, onToggleStar }` lookup at 6 sites across 4 gallery pages.
- [ ] **Cache `resolveGlobalDisplayName()` settings read.** Memoize for ~30s or invalidate on `settings:updated` event.
- [ ] **Shallow-equal guard in `useMediaAnnotations` socket handler.** Speculative micro-opt; theoretical until observed.
- [ ] **Hoist identity lookup out of `liftLegacyEntry` loop in `mediaAnnotations.js#readAll()`.** Pass `localInstanceId`, `defaultAuthorName` in once; make `liftLegacyEntry` synchronous.
- [ ] **Bulk reassign helper to collapse N+1 writes in `deleteSeason`.** Add `issuesSvc.bulkReassignSeason(seriesId, fromSeasonId, toSeasonId)` — one readState + N in-memory mutations + one writeState + one renumber.

### Better-audit residue

- [ ] **[HIGH][CODE]** `server/services/cos.js:3113` — remove `NODE_ENV !== 'test' && VITEST !== 'true'` init guard (test hack in prod boot path).
- [ ] **[HIGH][TESTS]** Create test files for `server/services/clinvar.js` and `server/services/telegramBridge.js`.
- [ ] **[HIGH][TESTS]** Add coverage for `server/services/shell.js` and `server/services/feeds.js` — both have exported functions but no sibling test. Shell drives all terminal sessions; feeds manages subscriptions. (New — surfaced 2026-05-16 replan.)
- [ ] **[MEDIUM][CLIENT]** 4 components still redefine `formatBytes`/`formatTime`/`formatDuration`/`timeAgo`/`formatDate` locally: `VideoTimelineEditor.jsx`, `VideoTimeline.jsx`, `MortalLoomTab.jsx`, `ImportTab.jsx`.
- [ ] **[MEDIUM][PERF]** `feeds.js#getItems` (303–319) — full-sort-then-paginate on every request. Pre-sort once at write time or maintain a per-feed index.
- [ ] **[MEDIUM][CODE]** Magic numbers in `cos.js:166,357`, `lmStudioManager.js:66`; brittle `err.message.startsWith('unknown piper voice:')` in `routes/voice.js:160` and `err.message.includes('not initialized')` in `services/visionTest.js:124`.
- [ ] **[LOW][CLIENT]** Extract shared `usePopoverPosition` hook — portal-with-fixed-positioning duplicated across 4 components (`AddToCollectionMenu`, `BulkTargetPicker`, `ThemeSwitcher`, `VisualStylePicker`) with near-identical rAF-coalesced scroll/resize listeners + `useLayoutEffect` measurement.

### Pipeline — deferred

- [ ] **Wire `storyboards` scene-video rendering** as a separate path from the episode-video handoff. Add optional `sceneVideoJobId` per scene.
- [ ] **Rich-text editor for prose stage.** Replace plain textarea in `ProseStage.jsx` — reuse Writers Room editor or pick a minimal markdown editor.
- [ ] **Versioning / diff view per stage.** Persist last N `lastRunId` snapshots; offer a diff modal.
- [ ] **Episode-video provider picker (RunwayML / third-party).** Once the abstraction lands, expose picker on EpisodeVideoStage.
- [ ] **Comic-book PDF export.** Once `stages.comicPages` carries enough panel data + rendered images, export print-ready PDF.
- [ ] **Voice-controlled stage advancement.** Register pipeline stage navigation actions in `voice/tools.js`.
- [ ] **AI-assisted panel/scene prompt generation.** Reserve `pipeline-comic-panel-image-prompt.md` and `pipeline-storyboard-image-prompt.md` for a future "turn script fragment into N image-gen prompts" button.
- [ ] **Extract migration scaffolding into `scripts/migrations/_lib.js`.** Migrations 003 and 006 both implement the same hash-driven prompt-replace pattern (~75 lines of boilerplate each). Lift to a shared helper; next migration becomes ~15 lines.
- [ ] **Shots-aware scene-output-contract partial.** Split into `_partials/scene-fields-core.md` + `_partials/scene-fields-shots.md` when a third shots-using stage appears.
- [ ] **Per-panel/scene image progress in the Pipeline UI.** ComicPages and Storyboards record `jobId` but don't subscribe to the media-job SSE for live preview.

---

## Deferred Architecture (human-led planning)

God-file decomposition candidates — none are bugs; pick up when touching the file for unrelated reasons.

- `server/services/cos.js` (3115 LOC) — split into cosTaskStore / cosTaskGenerator / cosJobScheduler / cosHealthMonitor.
- `server/services/agentLifecycle.js` (1446 LOC) — extract prepareAgentWorkspace / resolveProvider / processCompletion.
- `server/services/identity.js` (1917 LOC) — separate genomic markers + longevity + goals + todos.
- `server/services/taskSchedule.js` (2369 LOC) — extract prompt management to `taskPromptService.js`.
- `server/services/taskLearning.js` (1939 LOC) — separate metrics aggregation from heuristic routing.
- `server/services/autonomousJobs.js` (1567 LOC) — extract job registry / scheduler / execution paths.
- `server/services/voice/tools.js` (1284 LOC) — group by domain (UI / calendar / brain / media) into siblings.
- `server/services/git.js` (1271 LOC) — extract command builders + parsers.
- `server/cos-runner/index.js` (1076 LOC) — extract spawn / lifecycle / IPC layers.
- `server/services/memory.js` (1049 LOC) — separate retrieval, classification, persistence.
- `server/services/xcodeScripts.js` (1131 LOC) — collapse repeated AppleScript builders.
- `server/routes/apps.js` (1180 LOC) — extract `npm install` orchestration to `appBuilder.js`.
- `client/src/pages/VideoGen.jsx` (1361 LOC) — extract mode-specific control panels (i2v / a2v / extend / FFLF).
- `client/src/pages/ImageGen.jsx` (1182 LOC) — extract preset picker + multi-reference uploader.
- `client/src/components/goals/GoalDetailPanel.jsx` (1252 LOC) — god component.
- `client/src/components/meatspace/tabs/CalendarTab.jsx` (1269 LOC) — extract grid renderer + goal-link panels.
- `client/src/components/cos/tabs/ScheduleTab.jsx` (1088 LOC) — extract schedule editor + run history table.
- `client/src/components/writers-room/StoryboardPanel.jsx` (1199 LOC) — extract scene tile + render dock subcomponents.
- `autofixer/ui.js` (972 LOC) — inline HTML template needs extraction.
- API contract — standardize error response shapes (`asyncHandler` + `ServerError` everywhere).

**Known low-severity:** pm2 ReDoS (GHSA-x5gf-qvw8-r2rm) — no upstream fix, not exploitable via PortOS routes.

---

## Future Ideas

- **Identity Context Injection** — per-task-type digital twin preamble toggle.
- **Content Calendar** — unified calendar across platforms.
- **Goal Decomposition Engine** — auto-decompose goals into task sequences.
- **Knowledge Graph Visualization** — extend BrainGraph 3D to full knowledge graph.
- **Autobiography Prompt Chains** — LLM follow-ups building on prior answers.
- **Legacy Export Format** — identity as portable Markdown/PDF (closes GOALS "Knowledge Legacy" gap currently at Early status).
- **Workspace Contexts** — project context syncing across shell, git, tasks.
- **Inline Code Review Annotations** — one-click fix from self-improvement findings.
- **Major Dependency Upgrades** — React 19, Zod 4, PM2 6, Vite 8.
- **Workflow tab Phase 2** — drag-and-drop ordering of stages, custom user-defined stages, per-app workflow overrides.
