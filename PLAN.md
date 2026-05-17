# PortOS — Development Plan

For project goals, see [GOALS.md](./GOALS.md). For completed work, see [DONE.md](./DONE.md).

---

## Next Up

1. **Universe Builder redesign — trunks + sub-buckets layout.** Replace the vertical-stack layout with a tabbed-trunk layout (`Bible / Cast / Places / Objects / Composites / Render`). Unify custom categories as sub-buckets under one of the 3 canon trunks via a new `kind: 'characters'|'settings'|'objects'` field on each category. Card grids with thumbnails replace the per-category accordion. Multi-phase (each phase is its own PR):
   - **Phase A — Data model + migration.** Add `kind: 'characters'|'settings'|'objects'|'other'` field to category sanitizer (`server/services/universeBuilder.js#sanitizeCategories`) and Zod (`server/routes/universeBuilder.js#categoryShape`); default to `'other'` when missing/invalid. Sub-bucket keys remain **globally unique** (no per-trunk namespacing). Migration `scripts/migrations/NNN-categorize-universe-buckets.js` assigns built-in defaults: `landscapes/environments/structures → settings`, `vehicles → objects`. The default `characters` category is retired; its variations backfill into `universe.characters[]` (reuse `backfillCanonFromCategories` logic). All other existing custom categories get `kind: 'other'`; Phase C surfaces them under an **Other** tab with an **Auto-sort** button that LLM-classifies each bucket into the right trunk + a meaningful name.
   - **Phase B — Expand contract enrichment.** Teach `buildExpansionPrompt()` (`server/services/universeBuilderExpand.js`) to return rich canon arrays (`characters[]`/`settings[]`/`objects[]` with `physicalDescription`/`palette`/`recurringDetails`/`wardrobe`) alongside the existing `categories` (now kind-tagged) + `compositeSheets`. Update `isExpansionShape()` predicate. Client `handleExpand` in `UniverseBuilder.jsx` merges canon entries into the canon arrays parallel to the category merge (dedupe by name, respect per-entry locks). Categories the LLM emits include a `kind` so they land under the right trunk.
   - **Phase C — Layout rewrite.** Tabbed top-level (Bible / Cast / Places / Objects / Other / Composites / Render) with URL state (`?tab=cast&bucket=heroes` per CLAUDE.md linkable-routes convention) — Bible is its own tab (not a sticky header). Per-trunk view = sub-bucket chip filter row + responsive card grid. Unify `CanonCard` + a new card for category variations into a single `EntryCard` component (renders thumbnail from `primaryImageRef` or most recent render). **Canon entries are first-class batch-render targets** alongside category variations and composite sheets: per-bucket actions are "Generate N more" + "Bulk-render this bucket"; per-trunk action is "Bulk-render all Cast/Places/Objects" (includes BOTH canon entries AND every variation in every sub-bucket under that trunk); the Batch Render tab itself offers per-trunk, per-bucket, and "All canon" selectors plus the existing composite-sheets mode. Composite reference images stay intact as their own render mode (no regression). Server-side: extend `compilePrompts` to accept canon entries as render sources (synthesize a prompt from `name + physicalDescription/palette/description`, layered with the universe style preset the same way variations are today). The **Other** tab only appears when un-kinded buckets exist, and shows the **Auto-sort with AI** action. Mobile: tabs collapse to a select dropdown.
   - **Phase D — Polish & promotion.** "Promote variation to canon" action: take a `{label, prompt}` variation, expand it via LLM into a full canon entry (`name`, `physicalDescription`, etc.) and move it from the category bucket into the canon array. Tests for the new components. Extract design to `docs/features/universe-builder.md` if the doc warrants it.
   - **Phase C follow-ups (deferred from the Phase C PR):**
     - [ ] **Auto-sort with AI** — LLM-classify each `kind: 'other'` bucket into characters/settings/objects + suggest a meaningful name. New server route `POST /api/universe-builder/:id/auto-sort` that sends bucket keys + variation labels to the active LLM and applies the classification. Currently the Other-tab button is a stub that points users at re-running Generate From Idea (Phase B's expand emits kind tags). Land in a follow-up to keep the Phase C PR scoped.
     - [ ] **Unify `CanonCard` + variation card into a single `EntryCard`.** Phase C reuses `CanonCard` for canon and `CategoryEditor` for variations inside the same TrunkView. Visual consistency is achieved through shared Tailwind classes; an actual single-component unification (with thumbnail-from-`primaryImageRef`-or-recent-render) is the Phase D card-extraction task.
     - [ ] **Extract a shared `<TabPills>` primitive in `client/src/components/ui/`.** Phase C's `TabNav` in `UniverseBuilder.jsx` duplicates the pattern in `StoryboardPanel.jsx` `TabNav` + 5 inline tab-button pages (`Calendar.jsx`, `ChiefOfStaff.jsx`, `DigitalTwin.jsx`, `Messages.jsx`, etc.). One primitive that accepts `{ tabs: [{id,label,icon,count}], activeTab, onChange }` would consolidate. Cross-cutting refactor — defer until next time we touch tab UI somewhere.
     - [ ] **Extract `descriptorForCanonEntry(kind, entry)` into `server/lib/canonPrompt.js` (mirror in client).** The new server-side `synthesizeCanonPrompt()` in `server/services/universeBuilder.js` duplicates the per-kind descriptor logic already present in `client/src/components/universe/UniverseCanonSection.jsx`'s `KINDS[].descFor` closures and overlaps with `server/lib/scenePrompt.js` (`settingFrags`). One helper would let canon-render synthesis, the canon UI summary, and scene-prompt framing all share the same field-precedence rules.
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

### Importer (deferred research)

- [ ] **Chunked extraction for source > 200K chars.** Today's `IMPORTER_SOURCE_CHAR_LIMIT` hard-rejects. Once a real import hits the cap, route through per-chunk canon extraction + rolling synopsis. **Investigate chunk-overlap / merge strategy first — research-required, not a drop-in feature.** Plan sketch: pick a chunk size that fits all three importer prompts (canon/arc/issue-proposal) under the smallest provider's context window after overhead; per-chunk canon-extract feeds back into `existingCanon` for the next chunk so dedup is rolling; rolling synopsis is generated after each chunk and prepended as `priorSynopsis` to the next; arc-extract runs against the final concatenated synopsis, not the raw source; issue-proposal honors chunk boundaries only when a chapter/issue marker straddles them. Open questions: (a) is overlap needed at all, or are chapter markers reliable enough to clean-cut at? (b) how to merge per-chunk arcs when chunks disagree on theme/protagonist? (c) progress UI — single bar or per-chunk? Defer until a real import actually hits the 200K cap; the hard-reject + "trim source" guidance is acceptable for now.
- [ ] **Importer review UI: extract `<CanonCard>` once Universe-as-Canon Phase 2 lands.** Today renders an inline minimal card in `Importer.jsx#CanonReviewSection`. Blocked on Phase 2 — revisit when that section's first item ships.

### Universe-as-Canon — Phase 2 + extensions

- [ ] **CanonCard "from series: <name>" full provenance label.** Card currently shows a "from series" chip with the series id in the tooltip. Plumb a `seriesNameMap` (or `sourceSeriesName` per entry) so the chip can render the actual series name. Needs the parent (`UniverseCanonSection` / `NounsStage`) to pass a `{ [seriesId]: name }` lookup.
- [x] ~~**Retire `universe.categories` on the schema.**~~ **Rejected 2026-05-17** — categories are an active user-facing exploration workflow (custom buckets like `factions`/`colonies`/`raider_clans`, bulk variation generation, batch render). Canon has no equivalent. See "Categories vs canon — decision" below.
- [→] **Drop the default `characters` category.** Folded into Next Up #1 Phase A.
- [→] **Universe expand LLM contract enrichment.** Folded into Next Up #1 Phase B.
- [→] **arcPlanner prompt context — include canon characters/places/objects.** Folded into Next Up #1 Phase B (Phase B PR shipped `renderCanonForPrompt(world)` + `worldCanonText` + migration 019 for all four arc/volume templates: `pipeline-arc-overview`, `pipeline-arc-verify`, `pipeline-arc-resolve`, `pipeline-volume-verify`). Follow-up: sweep `grep -rn "world\.categories" server/services/pipeline server/services/universeBuilder*.js` for other prompt builders that read categories but not canon.
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

- [ ] **Extract `mergeExpandIntoDraft(draft, result)` from `UniverseBuilder.jsx#handleExpand`.** The function is ~150 lines mixing pure-merge logic (categories, sheets, canon, locks) with I/O shell (API call, setDraft, auto-save, toast). Pull the merge into a top-level pure helper so the I/O surface shrinks and the merge is unit-testable. Deferred from Phase B `/simplify` to keep that PR tightly scoped.
- [x] ~~**Auto-save after expand can clobber concurrent canon edits.**~~ **Fixed in Phase B Copilot iteration 13** — both `handleExpand`'s auto-save and `handleSave`'s manual-save (when `canonDirty`) now refetch the server's canon via `getUniverse(selectedId)` and merge local additions with `mergeCanonByName` before the update payload is sent. Concurrent edits from NounsStage/other tabs are preserved on identity collision.
- [x] ~~**Canon-merge can revert concurrent deletions/renames.**~~ **Fixed in Phase B Copilot iteration 15** — handleExpand records each merge's NEW canon entries in a `pendingCanonAdditionsRef` sidecar; handleSave + handleExpand auto-save + handleCanonChange now merge ONLY that ledger onto the refetched server canon (not the full stale draft). Concurrent deletions in other tabs/surfaces are preserved because the deleted entry isn't in the ledger, so the server response (which already lacks it) wins.
- [ ] **Extract `useSwipeNav` hook + `lib/clipboard.js`.** `MediaLightbox` swipe nav; clipboard inlined across 8+ call sites. Clipboard can move now.
- [ ] **Route `MediaLightbox` settings drawer through `components/Drawer.jsx`.** Reconcile `Drawer`'s flat Esc handler with the lightbox's layered Escape cascade.
- [ ] **`useAsyncAction` post-unmount setState guard.** Add `mountedRef` to gate `setRunning(false)`. YAGNI today; do at 4th consumer.
- [ ] **Scene-level wardrobe picking.** Per-scene `characterAppearances: [{ characterId, wardrobeId? }]` on storyboard scenes with wardrobe-picker dropdown. Decide first: does the extractor guess or does the user pick? Append wardrobe after physicalDescription vs substitute body fields?
- [ ] **Extract `useCanonPatch(universe, setUniverse, universeId, mountedRef)`.** `UniverseCanon.jsx` + `NounsStage.jsx` 95% identical optimistic-patch handlers. Extract when a 3rd caller appears.
- [ ] **Client tests for deep routing + drag.** Smoke tests for `goToWorld(id)` URL transitions and chip-reorder ordering (mock `useSortable`).
- [ ] **Shallow-equal guard in `useMediaAnnotations` socket handler.** Speculative micro-opt; theoretical until observed.
- [ ] **Extract a `tryReadFile(path, encoding='utf8')` helper into `server/lib/fileUtils.js`.** The `readFile(path).catch(() => null)` pattern is inlined 15+ times across the codebase (`server/routes/apps.js:38` `safeReadJson`, `server/lib/fileUtils.js:505`, `server/lib/hfToken.js:16`, `server/services/agentDrafts.js:22`, `server/services/messageAccounts.js:10`, `server/services/missions.js:35`, `server/lib/tuiPromptRunner.js` new at line ~202, etc.). One helper + migrate; small win, prevents future drift. Defer until next infra pass.
- [ ] **Sweep `provider.type === 'tui'` inline checks in client.** New `isTuiProvider` helper in `client/src/utils/providers.js` not yet adopted in `client/src/pages/AIProviders.jsx` (3 remaining inline checks at lines 262, 396, 421 of CONFIG-style chips) and `client/src/components/cos/TaskAddForm.jsx`. Low priority — these are visual chip predicates, not behavioral.
- [ ] **Skip the `text` accumulator in `promptRunner.runPromptThroughProvider` for TUI providers.** `APPEND_CHUNK(acc, chunk)` runs per stream chunk regardless of provider type, but the TUI branch (post `fix-prose-stage-override`) discards the accumulated `text` and uses `result.text` from `executeTuiRun` instead. Streams can hit hundreds of KB of screen redraws per run — gate the accumulator on `effectiveProvider.type !== 'tui'` in `onData` to skip the per-chunk string concat. Pre-existing buffer cap on `outputBuffer` inside `executeTuiRun` already bounds memory; this is a CPU/alloc micro-opt, not a correctness fix.

### v2.1.0 pre-release review residue (deferred from main→release multi-agent review, 2026-05-16)

- [ ] **[MED][SHARING]** `server/services/sharing/annotationsSync.js:86-103` — `flushAll()` uses one `sourceName` for ALL buckets instead of honoring per-bucket `displayNameOverride`. Annotation manifest envelopes get the global name; series/universe/media manifests honor the override. Call `resolveSourceName(bucket)` per-bucket inside `exportAnnotationsToBucket`.
- [ ] **[MED][SHARING]** `server/services/mediaAnnotations.js:38-49` — `sanitizeAuthorEntry` stamps `new Date().toISOString()` when `updatedAt` is missing/invalid on the merge path, making malformed peer records always win LWW. Reject entries without a valid `updatedAt` on merge.
- [ ] **[MED][UNIVERSE-BUILDER]** `server/routes/universeBuilder.js:407-435` — `registerUniverseBuilderRun(...)` is called AFTER `await svc.recordRun(...)`; worker can pick up the first job and emit `completed` before registration, losing coalescing. Move `registerUniverseBuilderRun` before the enqueue loop.
- [ ] **[MED][MIGRATION]** `scripts/migrations/014-attribute-existing-annotations.js:43` — if migrations run before first server boot, `instances?.self?.instanceId || 'unknown'` writes the literal `'unknown'` as a phantom peer forever. Defer the migration to first server boot via `ensureSelf()`, or reconcile `unknown`→real id on read.
- [ ] **[MED][PIPELINE]** `server/services/pipeline/arcPlanner.js:863-866` — `sanitizeSeasonList` dedupes by id (LWW); two LLM-emitted seasons with the same id silently drop one before persist while child issues stay attached to the still-present id. Add a duplicate-id detector that fails loud or warns.
- [ ] **[MED][PIPELINE]** `server/services/pipeline/arcPlanner.js:929-942` — `buildSeasonRemap` Pass 3 (positional fallback) silently invents wrong mappings when the LLM structurally reshapes the arc. Log a warning when Pass 3 fires; consider only firing when unmatched count ≤ 1.
- [ ] **[MED][PIPELINE]** `server/routes/pipeline.js:145-149` — `seasonCoverSchema` is strict but `seasonSchema` is `.passthrough()`. A future "save full series" round-trip with `cover.proofImage`/`finalImage` will 400. Add `.passthrough()` to `seasonCoverSchema`.
- [ ] **[MED][PIPELINE]** `server/routes/pipeline.js:1416, 1452, 470-472, 498-500` — cover render routes always overwrite `script` with the resolved value (treats absent vs empty-string identically). Only update `script` from render when the request body actually carried the field, OR drop script writes from render routes entirely (blur-save owns the field).
- [ ] **[MED][PIPELINE]** `server/services/pipeline/volumePdf.js:60` — `arcPosition`-only sort lacks a tiebreaker; null arcPosition with `number:5` sorts BEFORE `arcPosition:6, number:1`. Use `(a.arcPosition ?? Infinity) - (b.arcPosition ?? Infinity) || (a.number||0) - (b.number||0) || a.id.localeCompare(b.id)`.
- [ ] **[MED][PIPELINE]** `server/services/pipeline/seasonCoverFilenameHook.js:42` — returning `{}` from the patch callback still bumps `season.updatedAt` + triggers re-export. Add a no-op short-circuit mirroring `issues.js:601-603`.
- [ ] **[MED][CANON]** `server/services/pipeline/series.js:210` — series PATCH silently strips `characters/settings/objects` with zero logging. Stale browser tab POSTing legacy canon gets 200 OK and the canon vanishes. Emit `console.warn` once per request when legacy fields are stripped so the failure is observable.
- [ ] **[MED][SHARING]** `server/services/sharing/version.js` — `SHARING_SCHEMA_VERSION` not bumped despite series-schema canon-field removal. Cross-peer share-bucket import from a pre-B.4 install silently loses series-side canon. Either bump the version (force refusal) or mirror migration logic in the importer for legacy canon fields.
- [ ] **[MED][AI-DISPATCH]** `server/services/aiDetect.js:242-250` — still has legacy `if (provider.type === 'cli') ... else if (api) ... else 'Unknown provider type'`. TUI providers fail on Settings → Detect App. Migrate to `runPromptThroughProvider`.
- [ ] **[MED][AI-DISPATCH]** `server/services/digital-twin-helpers.js:56-130` — `callProviderAI` still has ad-hoc CLI/API split with TUI falling into the CLI branch (will hang or render banner into pipe). Migrate to `runPromptThroughProvider`.
- [ ] **[MED][AI-DISPATCH]** `server/lib/tuiPromptRunner.js:198-200` — `OUTPUT_BUFFER_CAP = 1MB` silently truncates the *head* of TUI responses >1.25MB mid-token. Persists to disk AND returns truncated. Either stream incrementally to `output.txt` (like agentTuiSpawning does) or raise the cap + log a warning.
- [ ] **[MED][TESTS]** No tests for `server/lib/ansiStrip.js` (streaming escape-split-across-chunks logic) or `server/lib/tuiHandshake.js` (paste timing constants both production paths depend on). Add coverage for: escape split across two chunks, bare `\x1B` at chunk end, OSC sequences, unterminated bytes past the 4096-byte window.
- [ ] **[MED][TESTS]** No direct tests for `executeTuiRun` PTY mechanics — idle-complete, hard-timeout, missing-binary early-fail, `emitRunStarted` shape, CLAUDECODE env stripping. The new `tuiPromptRunner.test.js` only covers `cleanTuiResponse`.
- [ ] **[MED][IMPORTER]** `server/routes/importer.test.js` — no test pins `ERR_PARTIAL_COMMIT_ISSUES → 207` status mapping. Future refactor that drops the entry from `SERVICE_ERROR_STATUS` would 500 on partial commits and trigger pager alerts (the in-code comment's stated regression).
- [ ] **[MED][IMPORTER]** `server/services/importer.test.js` — no test exercises `existingCanonBlock` dedupe wiring. A regression that wires `null` would silently degrade second-pass imports. Assert `mockRunStagedLLM.mock.calls[0][1].existingCanonBlock` contains a seeded character name.
- [ ] **[MED][CANON]** `server/services/canonUsage.js` — zero test coverage for `getUniverseCanonUsage`. The "Appears-in sort: issueCount desc + alpha tiebreaker" invariant lives at line ~101 with no test. Add a `canonUsage.test.js`.
- [ ] **[LOW][AI-DISPATCH]** `server/lib/promptRunner.js:146` — `effectiveCwd = cwdOverride ?? process.cwd()` doesn't catch empty string. Match `tuiPromptRunner.js:103`'s pattern: `(typeof cwdOverride === 'string' && cwdOverride) ? cwdOverride : process.cwd()`.
- [ ] **[LOW][AI-DISPATCH]** `server/services/loops.js:181` — fire-and-forget `.then(...).catch(err => ...)` chain causes a throw in `onComplete({success:true})` to be misclassified as iteration-failed and emit `iteration:error`. Split into separate `.then` or wrap onComplete with its own catch.
- [ ] **[LOW][CANON]** `server/services/pipeline/textStages.js:156` — dead-code fallback `|| series.characters` (always `undefined` post-B.4). Drop the middle clause.
- [ ] **[LOW][CANON]** `server/services/pipeline/migrateSeriesCanon.js:61` — `updateSeries({ universeId })` writes mid-loop with the universe still empty. Crash between line 61 and the universe patch leaves series stripped + universe empty. Build the universe patch first, then write both.
- [ ] **[LOW][IMPORTER]** `server/services/importer.js:444-446` — `arcSummary = arcContent.summary || arcContent.logline || \`${name} — ${type}\`` silently swallows a successful arc-extract that returned empty fields. Log a warning or surface `arcExtractFallback: true`.
- [ ] **[LOW][SHARING]** `server/services/mediaAnnotations.js:154` — peer `updatedAt` not clamped to `Math.min(now, sane.updatedAt)`; a peer with future-skewed clock dominates all merges.
- [ ] **[LOW][SHARING]** `server/services/mediaAnnotations.js:132-167` — `mergePeerAnnotations` accepts `peerInstanceId === 'unknown'`; the outgoing path guards but the import side doesn't. Add `if (!peerInstanceId || peerInstanceId === 'unknown') return ...`.
- [ ] **[LOW][SHARING]** `server/services/sharing/annotationsSync.js:38-68` — empty-payload writes fan to every auto-merge bucket per local edit. Skip when both prior and current filtered payloads are empty.
- [ ] **[LOW][AI-DISPATCH]** `server/lib/ansiStrip.js:14` — pattern doesn't strip lone `\x1B` bytes; chunk `\x1B\x1B[31m` leaks a raw escape. Add `.replace(/\x1B(?![@-_\[\]])/g, '')` second pass.

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
- [ ] **Extract migration scaffolding into `scripts/migrations/_lib.js`.** Migrations 003, 006, and 019 all implement the same hash-driven prompt-replace pattern (~75 lines of boilerplate each). Lift to a shared helper; next migration becomes ~15 lines.
- [ ] **Shots-aware scene-output-contract partial.** Split into `_partials/scene-fields-core.md` + `_partials/scene-fields-shots.md` when a third shots-using stage appears.
- [ ] **Per-panel/scene image progress in the Pipeline UI.** ComicPages and Storyboards record `jobId` but don't subscribe to the media-job SSE for live preview.

---

## Design decisions

### Categories vs canon — decision (2026-05-17)

**First framing (rejected same day):** retire `universe.categories` entirely, assuming canon subsumed it. This was wrong — canon and categories serve different workflows (consistency vs. exploration) and custom buckets like `factions`/`colonies` have no clean home in canon.

**Second framing (rejected same day):** keep canon and categories as *complementary siblings* (two top-level sections of the Universe Builder page). Rejected because it preserves the bifurcated mental model — the user sees `Cast` and `Factions` as separate top-level concepts even though factions are characters.

**Final framing (accepted 2026-05-17):** **unify under 3 canon trunks.** The Universe Builder has 3 first-class trunks — `Characters`, `Places`, `Objects` — and every entity in the universe (canon entries AND category variations) lives under exactly one trunk. Each category gets a new `kind` field tagging it to its trunk:

- **Canon entries** = first-class entities with rich production metadata (`physicalDescription`, `palette`, `recurringDetails`, `wardrobe`, `imageRefs`). Named, consistent across episodes.
- **Sub-buckets** (formerly "categories") = organizational + bulk-generation surfaces *within* a trunk. `Cast > Heroes/Villains/Factions`, `Places > Colonies/Ruins`, `Objects > Vehicles/Weapons`. Each holds flat `{label, prompt}` variations for visual exploration.
- **Promotion**: a variation can be promoted to canon — the LLM expands it into a full canon entry and moves it from the bucket into the canon array.

This collapses the page to 3 navigable trunks (plus Bible/Composites/Render), supports inline thumbnails per entry, and gives every entity one obvious home. See Next Up #1 for the multi-phase implementation.

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
