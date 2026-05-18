# PortOS — Development Plan

For project goals, see [GOALS.md](./GOALS.md). For completed work, see [DONE.md](./DONE.md).

---

## Next Up

_Nothing currently parked — pick the next item from the Backlog._

## Backlog

### Sharing

- [ ] [multi-hop-provenance-chains-re-share-authors-a] **Multi-hop provenance chains.** Re-share authors a fresh `origin` block; `chain[]` would preserve full attribution. Defer until users ask.
- [ ] [coverautofiler-dispatcher-redundant-getseries] **`fileCoverIntoAutoCollection` dispatcher reads `series` 3-4× per cover completion.** `server/services/pipeline/coverUniverseFiler.js:43-52` does `seriesSvc.getSeries(seriesId)` purely to branch on `series.universeId`, then both leaf functions (`fileCoverIntoUniverseCollection` lines ~65/~71, `fileCoverIntoSeriesCollection` lines ~133/~154) re-fetch series via their own `getSeries` calls — worst case 4 full series.json reads per universe-linked cover, 3 for a series-linked one. Cover completion is human-pace (one or a few per render burst) so absolute waste is tiny, but trivially fixable: pass the dispatcher's already-fetched `series` into the leaf functions as an optional `_preloaded` arg to skip their first read. The mid-flight re-read (line ~71 in the universe path) is intentional race-detection and must stay. Surfaced by /simplify during the `[same-collection-export-pattern-for-pipeline-series]` PR; deferred to keep that diff focused on the new feature.

### Importer (deferred research)

- [ ] [importer-canonprompt-preview-fragments-helper] **Share a per-kind preview-fragments helper between Importer and `canonPrompt.js`.** Importer's three `CanonReviewSection` callsites (`client/src/pages/Importer.jsx:468-496`) inline `renderSubtitle` + `renderBody` for each of characters/places/objects. Existing `client/src/lib/canonPrompt.js` already centralizes short/rich descriptor fragments for the render-prompt scope but doesn't fit pre-commit preview: (a) Importer wants ALL visible fields (`personality`, `background`, `role`, `slugline`) for the user to judge before committing — wider than `shortCanonDescriptorFragments`; (b) `normalizeKind` accepts `'setting'` but not `'places'` (the importer's canonSelections key), so a drop-in call would silently return `[]`. Add a `previewCanonFragments(kind, entry, { includeAll: true })` variant and teach `normalizeKind` to alias `'places' → 'settings'`. Then collapse the Importer's three inline `renderBody`/`renderSubtitle` callbacks onto the helper. Deferred from `[importer-review-ui-extract-canoncard-once-universe]`.
- [ ] [chunked-extraction-for-source-200k-chars-today-s] **Chunked extraction for source > 200K chars.** Today's `IMPORTER_SOURCE_CHAR_LIMIT` hard-rejects. Once a real import hits the cap, route through per-chunk canon extraction + rolling synopsis. **Investigate chunk-overlap / merge strategy first — research-required, not a drop-in feature.** Plan sketch: pick a chunk size that fits all three importer prompts (canon/arc/issue-proposal) under the smallest provider's context window after overhead; per-chunk canon-extract feeds back into `existingCanon` for the next chunk so dedup is rolling; rolling synopsis is generated after each chunk and prepended as `priorSynopsis` to the next; arc-extract runs against the final concatenated synopsis, not the raw source; issue-proposal honors chunk boundaries only when a chapter/issue marker straddles them. Open questions: (a) is overlap needed at all, or are chapter markers reliable enough to clean-cut at? (b) how to merge per-chunk arcs when chunks disagree on theme/protagonist? (c) progress UI — single bar or per-chunk? Defer until a real import actually hits the 200K cap; the hard-reject + "trim source" guidance is acceptable for now.

### Universe-as-Canon — Phase 2 + extensions

- [ ] [character-bible-simplify-followups] **Character bible / reference-sheet `/simplify` follow-ups.** Captured from the simplify review during the character bible expansion PR; each is deferred-but-cheap and shares the same surface area:
  - Bundle `CanonCard`'s four new character-only props (`universeId`, `onExpandCharacter`, `expanding`, `onSheetCompleted`) into a single `characterExtensions={…}` object; collapses the gate from 4 nulls per non-character call site to `characterExtensions && kind.key === 'characters'`. Touches `client/src/components/pipeline/CanonCard.jsx`, `client/src/components/universe/UniverseCanonSection.jsx` `KindSection`, and any other CanonCard consumer.
  - Mirror `server/lib/storyBible.js` `BIBLE_LIMITS` constants to the client (new `client/src/lib/bibleLimits.js`) and import in `client/src/components/universe/CharacterDetailEditor.jsx` so the editor's `max:` literals can't drift from the server caps.
  - Factor `WardrobeSection`'s draft+blur+pending-row editor (`client/src/components/pipeline/CanonCard.jsx:100-247`) into a shared `<EditableListRow>` / `useFieldDraft()` hook reused by both `WardrobeSection` and `CharacterDetailEditor.jsx`'s `ListRow`. Two implementations will drift.
  - Generalize `server/services/pipeline/refineHelpers.js#runPromptRefine` to handle multi-field merges so `universeCharacterExpand.js` can reuse its empty-guard + rationale-trim + log-tag scaffold instead of inlining them.
  - Collapse `resolveGalleryImage` / `resolveImageRef` / `resolveTemplateAsset` in `server/lib/fileUtils.js` onto a shared `makePathResolver(root, { extensions, cache? })` factory — three near-identical 15-line helpers today.
  - Add a `shortId(id, n=8)` helper in a shared lib for the `String(x).slice(0, 8)` pattern that's now in ~12 console.log call sites across `universeCharacterExpand.js` / `universeCharacterSheet.js` / others.
  - Extract a reusable `subscribeToImageGenJob({ jobId, onComplete, onFailed, timeoutMs })` from `server/services/universeCharacterSheet.js#renderCharacterReferenceSheet`; mirrors the pattern in `server/services/voice/tools.js:1320-1338` and `server/routes/sdapi.js#createCompletionWaiter`.
  - Move `universeCharacterSheet.js`'s `flattenStats`/`flattenPalette`/`flattenWardrobes`/`flattenProps`/`flattenNamedList` next to `RICH_SPEC` in `server/lib/canonPrompt.js` so per-page render prompts can reuse them.
  - Active-purge `character.referenceSheetImageRef` when the underlying file in `data/image-refs/` is deleted. Today there is no delete-route for sheet files, and the GET-time lazy `pruneStaleReferenceSheets` masks staleness at read-time, but when a sheet-delete route lands it must also call into a `purgeReferenceSheetFromAllUniverses(filename)` helper mirroring `purgeImageRefFromAllUniverses` in `server/services/universeCanon.js:263`.
  - Prune `_latestPendingByCharacter` in `server/services/universeCharacterSheet.js:221` when a character or universe is deleted. Map grows bounded by characters ever rendered, but stale slot entries persist across the process lifetime — wire a `clearPendingSheetSlot(universeId, entryId)` helper into the character-delete + universe-delete paths once those exist.
  - Cancel `CharacterReferenceSheetPanel`'s `waitForImageRef` poll on unmount. The `mountedRef` guard prevents the state update at line 77, but the 3 s poll keeps issuing HEAD requests against the dead component. Plumb an `AbortSignal` from a `useEffect` cleanup so the loop exits early.

- [x] ~~**Drop the default `characters` category.**~~ Shipped via the Universe Builder redesign Phase A migration; default `characters` bucket retired, variations backfilled into `universe.characters[]`.
- [x] ~~**Universe expand LLM contract enrichment.**~~ Shipped via the Universe Builder redesign Phase B — expand contract now returns rich canon arrays alongside categories.
- [x] ~~**arcPlanner prompt context — include canon characters/places/objects.**~~ Shipped via the Universe Builder redesign Phase B (`renderCanonForPrompt(world)` + `worldCanonText` + migration 019 for `pipeline-arc-overview`, `pipeline-arc-verify`, `pipeline-arc-resolve`, `pipeline-volume-verify`). Follow-up still open: sweep `grep -rn "world\.categories" server/services/pipeline server/services/universeBuilder*.js` for other prompt builders that read categories but not canon.


- [ ] [use-rendered-reference-images-as-i2i-anchors-in] **Use rendered reference images as i2i anchors in downstream comic-page renders for models that support it.** SDXL/Flux pipelines anchor every panel render on the per-character rendered ref.

### Pipeline continuity / approval

- [ ] [resolve-issues-inherits-verify-gaps-verify-the] **Resolve-issues inherits verify gaps.** Verify the resolve prompt USES episode synopses when patching the arc.
- [ ] [per-season-and-per-field-locks-extend-arc-lock] **Per-season + per-field locks.** Arc-level lock shipped (`LOCKABLE_STAGES = ['arc']` in `server/services/pipeline/series.js:59`, enforced at `server/services/pipeline/arcPlanner.js:231`); extend to seasons and per-field. Gate bulk runners (`bulkReassignSeason` at `server/services/pipeline/issues.js:418` has no lock check today). Surface a stage-progress strip in `client/src/pages/PipelineIssue.jsx`.
- [ ] [pipeline-idea-stage-character-detail-plumbing] **Plumb character `physicalDescription`/`personality`/`background` into idea-stage prompt.** Today `data.sample/prompts/stages/pipeline-idea-expansion.md:16` iterates `{{#series.characters}}` with `name`/`description` only — richer bible fields are dropped.
- [ ] [pipeline-visual-stages-setting-field-injection] **Inject setting `palette`/`era`/`weather`/`recurringDetails` into visual stages.** Storyboard/comic-panel prompts mention these in prose instructions but don't hydrate them from the matched bible entry. Tie this to the bible-SETTING→PLACE rename (`existingPlacesJson` carries them once that lands).
- [ ] [pipeline-text-stages-worldentitiessummary] **Add `worldEntitiesSummary` to text stages.** Zero occurrences in codebase today; a one-string canon synopsis (top-N entities by frequency, name + 1-line descriptor) keeps text-stage prompts under context budget while still giving the LLM continuity anchors.
- [ ] [bible-schema-speech-pattern-field] **Add a dedicated speech-pattern field to the character bible schema.** `voiceId` is the TTS engine pointer, not a written speech-pattern field. Add to `PROMPT_FIELDS[CHARACTER]` in `server/lib/storyBible.js:121` and pipe through extraction + script prompts.

### Creative Director / Audio

- [ ] [whole-episode-audio-generation-strategy-stop] **Whole-episode audio generation strategy.** Stop relying on per-clip audio; drive audio gen from episode-level prose/script arc. Generator candidates: Suno (commercial, duration control), MusicGen-MLX (local, bounded ~30s), AudioLDM2. New `audioMode: 'per-clip' | 'silent' | 'generated' | 'uploaded-track'`. Treat as a new sub-brainstorm when picked up — investigation first.
- [ ] [render-slowness-on-long-sessions-per-scene-render] **Render slowness on long sessions.** Per-scene render time degraded from ~3.5 min to 10–30 min within one project. Profile after sustained use; verify round-22 dedup helped.
- [ ] [pipeline-audio-phase-4c-2-4c-3-4d-2-local-oss] **Pipeline Audio Phase 4c.2/4c.3/4d.2.** Local OSS music gen (MusicGen sidecar; pick generator first); 3rd-party engine stubs; VO line muxing into the CD stitch with per-line offsets + music-bed ducking.
- [ ] [voice-picker-on-character-cards-voiceid-binding] **Voice picker on character cards.** `voiceId` binding via dropdown on `CanonCard` when `kind === 'character'`; audition button hitting `/api/pipeline/tts/preview`. Same picker re-usable as per-line override in `AudioStage.jsx`.

### Video Gen (LTX-2.3)

- [ ] [native-fflf-deeper-test-on-real-keyframe-pairs] **Native FFLF deeper test on real keyframe pairs.** Validate with last frame of clip A + first frame of clip B from the same scene; expose more pipeline knobs (cfg-scale, stg-scale, stage1-steps) if interpolation looks weak.

### Voice agent

- [ ] [voice-cos-tool-expansion-calendar-today-calendar] **Voice CoS tool expansion** — `calendar_today` / `calendar_next` (existing Google Calendar MCP), `meatspace_log_workout` (wraps `meatspaceHealth.js`), `weather_now` (pick API: OpenWeather / WeatherKit / NWS), `timer_set` (reuses `agentActionExecutor.js`).
- [ ] [wire-proactive-cos-speech-to-real-triggers] **Wire proactive CoS speech to real triggers.** Plumbing landed (`POST /api/voice/speak` + `voice:speak` socket event); hook to high-severity `errorEvents`, `task:ready`, and `notificationEvents` with per-source rate-limits.
- [ ] [optimize-voice-ui-index-text-payload-lazy-only-run] **Optimize `voice:ui:index` text payload.** Lazy: only run `extractVisibleText` when server requests via `voice:ui:read-request`. Keep current behavior as fallback.
- [ ] [voice-agent-vision-fallback-ui-describe-visually] **Voice agent vision fallback** — `ui_describe_visually`: screenshot tab and send to a vision-capable model so "what's on this chart?" works on CyberCity / graph views.
- [ ] [voice-agent-explicit-long-term-memory-routing-on] **Voice agent — explicit long-term memory routing.** On retrieval-shaped voice turns, inject top-N relevant memories into the system prompt via `brain_search`.

### Writers Room / CyberCity / Email

- [ ] [writers-room-phases-4-5-phase-4-synced-prose] **Writers Room Phases 4–5.** Phase 4 synced prose/script/media review; Phase 5 realtime CD feedback. Builds on the unified bible/scene model. See [writers-room.md](./docs/features/writers-room.md).
- [ ] [cybercity-v2-phase-2-deeper-drill-down-per-agent] **CyberCity v2 Phase 2+** — deeper drill-down: per-agent spatial trail, system flow lines between buildings, recent-action timeline overlay. See [cybercity-v2.md](./docs/features/cybercity-v2.md).
- [ ] [m50-p9-cos-automation-rules-automated-email] **M50 P9 — CoS Automation & Rules.** Automated email classification, rule-based pre-filtering, email-to-task pipeline.
- [ ] [m50-p10-auto-send-with-ai-review-gate-per-account] **M50 P10 — Auto-Send with AI Review Gate.** Per-account/per-recipient trust level + dual-LLM review (drafter + reviewer). Auto-send only when both approve or trust ≥ 0.9. See [messages-security.md](./docs/features/messages-security.md).
- [ ] [m34-p5-p7-digital-twin-multi-modal-capture-voice] **M34 P5-P7 — Digital Twin.** Multi-modal capture (voice/video/image identity sources), advanced testing, personas. Ties to GOALS.md "Multi-Modal Identity Capture".

### Image / Video Gen UI

- [ ] [flux2-multi-reference-python-runner] **FLUX.2 multi-reference Python runner.** The UI + server contract for multi-reference editing shipped 2026-05-17 (slug `multi-reference-image-editing-for-flux-2-ui`); the Python runner (`scripts/flux2_macos.py`) currently ignores the `--reference-images`/`--reference-strengths` args that `local.js` now passes. Wire diffusers' multi-reference API in the runner and swap `server/lib/mediaModels.js#flux2-klein-9b` `tokenizerRepo` to `FLUX.2-klein-9B-kv` (gated repo — requires the user to accept the license on HF). Validate end-to-end with 2–4 uploaded refs.
- [ ] [world-builder-phase-2-external-sd-api-per-bucket] **World Builder Phase 2 — external SD-API + per-bucket model overrides.** Wire Together / Replicate / Fal into world-builder batch path so high-end renders are practical; let each bucket pick its own model.
- [ ] [unify-videogen-resolutions-with-shared-image-gen] **Unify VideoGen `RESOLUTIONS` with shared image-gen list.** Move to `client/src/lib/videoGenResolutions.js` (or extend imageGenResolutions with `media: 'image'|'video'`) so dropdown + custom-fallback live in one place.

### Sharing — performance follow-ups (deferred from content-addressed asset dedup, 2026-05-18)

- [ ] [sharing-exporter-cache-sourcefile-hash-by-mtime] **Cache `sha256File` results in the exporter by `(sourcePath, mtime, size)`.** `copyAssetIfPresent` (`server/services/sharing/exporter.js`) re-hashes every referenced asset on every export, even when the blob already exists in the bucket. A subscription re-export of a 200MB series re-reads 200MB just to confirm "blob already there." Maintain a sidecar `<bucket>/assets/blobs/.index.json` mapping `<sourcePath>:<mtime>:<size> → <hash>`; skip the hash + copy when the cached entry matches and the blob is present. Invalidate purely on mtime change. ~30 LOC + one JSON file.
- [ ] [sharing-annotationssync-cache-bucket-asset-keys] **Cache `listBucketAssetKeys` per (bucket, manifests-dir mtime).** Today `annotationsSync.js#listBucketAssetKeys` re-scans every manifest in every auto-merge bucket on every 2s-debounced annotation flush (post-v2 because content-addressed blob paths don't carry filenames, so manifests are the only source of truth). Memoize `Map<bucketPath, { mtime, keys }>` keyed on the manifests dir mtime; invalidate when mtime advances. The legacy `assets/{images,videos}/` dir scan is still needed as a fall-through for pre-v2 buckets and can run un-cached.

### Code quality / dedup (from `/simplify` passes)

- [ ] [more-resolveproviderandmodel-migration-candidates] **More `resolveProviderAndModel` migration candidates.** When the helper landed in `server/lib/promptRunner.js` (universe-builder PR), three additional pure two-step provider-resolution chains were left alone to keep scope tight: `server/services/agentContentGenerator.js#runAIGeneration` (line ~80–90), `server/services/agentPersonalityGenerator.js` (line ~68–79), `server/services/loops.js` (line ~64–77). All three are textbook fits (no `enabled` gate, no typed-error throw mid-chain). Migration is one-import + 5-line collapse per file.
- [ ] [extract-assertprovider-provider-errormessage-code] **Extract `assertProvider(provider, { errorMessage, code, status })` helper.** After the `resolveProviderAndModel` migration there are now 4 `if (!provider) throw …` sites with varying error shapes (`Error` vs `ServerError`, `status: 400/503`, codes `NO_PROVIDER`/`UNIVERSE_PROMOTE_NO_PROVIDER`/etc.). One helper that takes the error-shape args would consolidate without forcing each caller to share the same error type.
- [ ] [extract-mergeexpandintodraft-draft-result-from] **Extract `mergeExpandIntoDraft(draft, result)` from `UniverseBuilder.jsx#handleExpand`.** The function is ~150 lines mixing pure-merge logic (categories, sheets, canon, locks) with I/O shell (API call, setDraft, auto-save, toast). Pull the merge into a top-level pure helper so the I/O surface shrinks and the merge is unit-testable. Deferred from Phase B `/simplify` to keep that PR tightly scoped.
- [x] [auto-save-after-expand-can-clobber-concurrent] ~~**Auto-save after expand can clobber concurrent canon edits.**~~ **Fixed in Phase B Copilot iteration 13** — both `handleExpand`'s auto-save and `handleSave`'s manual-save (when `canonDirty`) now refetch the server's canon via `getUniverse(selectedId)` and merge local additions with `mergeCanonByName` before the update payload is sent. Concurrent edits from NounsStage/other tabs are preserved on identity collision.
- [x] [canon-merge-can-revert-concurrent-deletions] ~~**Canon-merge can revert concurrent deletions/renames.**~~ **Fixed in Phase B Copilot iteration 15** — handleExpand records each merge's NEW canon entries in a `pendingCanonAdditionsRef` sidecar; handleSave + handleExpand auto-save + handleCanonChange now merge ONLY that ledger onto the refetched server canon (not the full stale draft). Concurrent deletions in other tabs/surfaces are preserved because the deleted entry isn't in the ledger, so the server response (which already lacks it) wins.
- [ ] [extract-useswipenav-hook-lib-clipboard-js] **Extract `useSwipeNav` hook + `lib/clipboard.js`.** `MediaLightbox` swipe nav; clipboard inlined across 8+ call sites. Clipboard can move now.
- [ ] [route-medialightbox-settings-drawer-through] **Route `MediaLightbox` settings drawer through `components/Drawer.jsx`.** Reconcile `Drawer`'s flat Esc handler with the lightbox's layered Escape cascade.
- [ ] [useasyncaction-post-unmount-setstate-guard-add] **`useAsyncAction` post-unmount setState guard.** Add `mountedRef` to gate `setRunning(false)`. YAGNI today; do at 4th consumer.
- [ ] [scene-level-wardrobe-picking-per-scene] **Scene-level wardrobe picking.** Per-scene `characterAppearances: [{ characterId, wardrobeId? }]` on storyboard scenes with wardrobe-picker dropdown. Decide first: does the extractor guess or does the user pick? Append wardrobe after physicalDescription vs substitute body fields?
- [ ] [extract-usecanonpatch-universe-setuniverse] **Extract `useCanonPatch(universe, setUniverse, universeId, mountedRef)`.** `UniverseCanon.jsx` + `NounsStage.jsx` 95% identical optimistic-patch handlers. Extract when a 3rd caller appears.
- [ ] [client-tests-for-deep-routing-drag-smoke-tests-for] **Client tests for deep routing + drag.** Smoke tests for `goToWorld(id)` URL transitions and chip-reorder ordering (mock `useSortable`).
- [ ] [shallow-equal-guard-in-usemediaannotations-socket] **Shallow-equal guard in `useMediaAnnotations` socket handler.** Speculative micro-opt; theoretical until observed.
- [ ] [extract-a-tryreadfile-path-encoding-utf8-helper] **Extract a `tryReadFile(path, encoding='utf8')` helper into `server/lib/fileUtils.js`.** The `readFile(path).catch(() => null)` pattern is inlined 15+ times across the codebase (`server/routes/apps.js:38` `safeReadJson`, `server/lib/fileUtils.js:505`, `server/lib/hfToken.js:16`, `server/services/agentDrafts.js:22`, `server/services/messageAccounts.js:10`, `server/services/missions.js:35`, `server/lib/tuiPromptRunner.js` new at line ~202, etc.). One helper + migrate; small win, prevents future drift. Defer until next infra pass.
- [ ] [sweep-provider-type-tui-inline-checks-in-client] **Sweep `provider.type === 'tui'` inline checks in client.** New `isTuiProvider` helper in `client/src/utils/providers.js` not yet adopted in `client/src/pages/AIProviders.jsx` (3 remaining inline checks at lines 262, 396, 421 of CONFIG-style chips) and `client/src/components/cos/TaskAddForm.jsx`. Low priority — these are visual chip predicates, not behavioral.
- [ ] [skip-the-text-accumulator-in-promptrunner] **Skip the `text` accumulator in `promptRunner.runPromptThroughProvider` for TUI providers.** `APPEND_CHUNK(acc, chunk)` runs per stream chunk regardless of provider type, but the TUI branch (post `fix-prose-stage-override`) discards the accumulated `text` and uses `result.text` from `executeTuiRun` instead. Streams can hit hundreds of KB of screen redraws per run — gate the accumulator on `effectiveProvider.type !== 'tui'` in `onData` to skip the per-chunk string concat. Pre-existing buffer cap on `outputBuffer` inside `executeTuiRun` already bounds memory; this is a CPU/alloc micro-opt, not a correctness fix.
- [ ] [aitoolkit-loadproviders-corrupt-fallback] **`loadProviders` JSON.parse `try/catch` with `.corrupt` rename fallback.** `server/lib/aiToolkit/providers.js:58-79` calls `JSON.parse` unguarded (lines 65, 71); a corrupt file crashes startup. Catch + rename to `.corrupt` + start from empty, with a single-line `console.error` log.
- [ ] [aitoolkit-createprovider-field-parity-test] **`createProvider` field-parity test.** Existing `providers.test.js` covers basic fields only. Add an exhaustive assertion that every field in `providerSchema` survives the `createProvider → save → loadProviders` round-trip — guards against the `createProvider` field-list regression noted in CLAUDE.md ("`updateProvider` uses spread but `createProvider` has explicit field list").
- [ ] [datasync-migrate-categories-to-atomicwrite] **Migrate all `dataSync.js` categories to `atomicWrite`.** Every category (`goals`, `character`, `digitalTwin`, `meatspace`, `universe`, `pipeline`) inlines `ensureDir + writeFile + JSON.stringify(..., null, 2)` — 6+ duplicate sites. `server/lib/fileUtils.js:124` exports `atomicWrite(path, data)` that handles all three steps as a temp+rename atomic write. One-line collapse per site + meaningful partial-write protection for the larger pipeline JSON files (which other services write concurrently). Surfaced by /simplify during `extend-syncorchestrator-to-cover-pipeline-universe`; deferred to keep that PR focused on the new categories.
- [ ] [datasync-checksum-only-fast-path] **Add a checksum-only fast path to `dataSync.js`.** `getChecksum(category)` currently calls the category's `getSnapshot` and discards `data` (`server/services/dataSync.js:451-456`) — every probe materializes the full payload. With pipeline/universe added the wasted work scales with the largest user-creative payload. Define per-category `getChecksum` shortcuts (e.g. hash file size+mtime, or hash raw bytes without parse) and dispatch via `CATEGORIES[cat].getChecksum`. The orchestrator hits the checksum endpoint every cycle — this is the hottest sync-side I/O. Surfaced by /simplify during `extend-syncorchestrator-to-cover-pipeline-universe`.

### v2.1.0 pre-release review residue (deferred from main→release multi-agent review, 2026-05-16)

- [ ] [med-sharing-server-services-sharing] **[MED][SHARING]** `server/services/sharing/annotationsSync.js:86-103` — `flushAll()` uses one `sourceName` for ALL buckets instead of honoring per-bucket `displayNameOverride`. Annotation manifest envelopes get the global name; series/universe/media manifests honor the override. Call `resolveSourceName(bucket)` per-bucket inside `exportAnnotationsToBucket`.
- [ ] [med-sharing-server-services-mediaannotations-js-38] **[MED][SHARING]** `server/services/mediaAnnotations.js:38-49` — `sanitizeAuthorEntry` stamps `new Date().toISOString()` when `updatedAt` is missing/invalid on the merge path, making malformed peer records always win LWW. Reject entries without a valid `updatedAt` on merge.
- [ ] [med-universe-builder-server-routes-universebuilder] **[MED][UNIVERSE-BUILDER]** `server/routes/universeBuilder.js:407-435` — `registerUniverseBuilderRun(...)` is called AFTER `await svc.recordRun(...)`; worker can pick up the first job and emit `completed` before registration, losing coalescing. Move `registerUniverseBuilderRun` before the enqueue loop.
- [ ] [med-migration-scripts-migrations-014-attribute] **[MED][MIGRATION]** `scripts/migrations/014-attribute-existing-annotations.js:43` — if migrations run before first server boot, `instances?.self?.instanceId || 'unknown'` writes the literal `'unknown'` as a phantom peer forever. Defer the migration to first server boot via `ensureSelf()`, or reconcile `unknown`→real id on read.
- [ ] [med-pipeline-server-services-pipeline-arcplanner] **[MED][PIPELINE]** `server/services/pipeline/arcPlanner.js:863-866` — `sanitizeSeasonList` dedupes by id (LWW); two LLM-emitted seasons with the same id silently drop one before persist while child issues stay attached to the still-present id. Add a duplicate-id detector that fails loud or warns.
- [ ] [med-pipeline-server-services-pipeline-arcplanner-2] **[MED][PIPELINE]** `server/services/pipeline/arcPlanner.js:929-942` — `buildSeasonRemap` Pass 3 (positional fallback) silently invents wrong mappings when the LLM structurally reshapes the arc. Log a warning when Pass 3 fires; consider only firing when unmatched count ≤ 1.
- [ ] [med-pipeline-server-routes-pipeline-js-145-149] **[MED][PIPELINE]** `server/routes/pipeline.js:145-149` — `seasonCoverSchema` is strict but `seasonSchema` is `.passthrough()`. A future "save full series" round-trip with `cover.proofImage`/`finalImage` will 400. Add `.passthrough()` to `seasonCoverSchema`.
- [ ] [med-pipeline-server-routes-pipeline-js-1416-1452] **[MED][PIPELINE]** `server/routes/pipeline.js:1416, 1452, 470-472, 498-500` — cover render routes always overwrite `script` with the resolved value (treats absent vs empty-string identically). Only update `script` from render when the request body actually carried the field, OR drop script writes from render routes entirely (blur-save owns the field).
- [ ] [med-pipeline-server-services-pipeline-volumepdf-js] **[MED][PIPELINE]** `server/services/pipeline/volumePdf.js:60` — `arcPosition`-only sort lacks a tiebreaker; null arcPosition with `number:5` sorts BEFORE `arcPosition:6, number:1`. Use `(a.arcPosition ?? Infinity) - (b.arcPosition ?? Infinity) || (a.number||0) - (b.number||0) || a.id.localeCompare(b.id)`.
- [ ] [med-pipeline-server-services-pipeline] **[MED][PIPELINE]** `server/services/pipeline/seasonCoverFilenameHook.js:42` — returning `{}` from the patch callback still bumps `season.updatedAt` + triggers re-export. Add a no-op short-circuit mirroring `issues.js:601-603`.
- [ ] [med-canon-server-services-pipeline-series-js-210] **[MED][CANON]** `server/services/pipeline/series.js:210` — series PATCH silently strips `characters/settings/objects` with zero logging. Stale browser tab POSTing legacy canon gets 200 OK and the canon vanishes. Emit `console.warn` once per request when legacy fields are stripped so the failure is observable.
- [ ] [med-sharing-server-services-sharing-version-js] **[MED][SHARING]** `server/services/sharing/version.js` — `SHARING_SCHEMA_VERSION` not bumped despite series-schema canon-field removal. Cross-peer share-bucket import from a pre-B.4 install silently loses series-side canon. Either bump the version (force refusal) or mirror migration logic in the importer for legacy canon fields.
- [ ] [med-ai-dispatch-server-services-aidetect-js-242] **[MED][AI-DISPATCH]** `server/services/aiDetect.js:242-250` — still has legacy `if (provider.type === 'cli') ... else if (api) ... else 'Unknown provider type'`. TUI providers fail on Settings → Detect App. Migrate to `runPromptThroughProvider`.
- [ ] [med-ai-dispatch-server-services-digital-twin] **[MED][AI-DISPATCH]** `server/services/digital-twin-helpers.js:56-130` — `callProviderAI` still has ad-hoc CLI/API split with TUI falling into the CLI branch (will hang or render banner into pipe). Migrate to `runPromptThroughProvider`.
- [ ] [med-ai-dispatch-server-lib-tuipromptrunner-js-198] **[MED][AI-DISPATCH]** `server/lib/tuiPromptRunner.js:198-200` — `OUTPUT_BUFFER_CAP = 1MB` silently truncates the _head_ of TUI responses >1.25MB mid-token. Persists to disk AND returns truncated. Either stream incrementally to `output.txt` (like agentTuiSpawning does) or raise the cap + log a warning.
- [ ] [med-tests-no-tests-for-server-lib-ansistrip-js] **[MED][TESTS]** No tests for `server/lib/ansiStrip.js` (streaming escape-split-across-chunks logic) or `server/lib/tuiHandshake.js` (paste timing constants both production paths depend on). Add coverage for: escape split across two chunks, bare `\x1B` at chunk end, OSC sequences, unterminated bytes past the 4096-byte window.
- [ ] [med-tests-no-direct-tests-for-executetuirun-pty] **[MED][TESTS]** No direct tests for `executeTuiRun` PTY mechanics — idle-complete, hard-timeout, missing-binary early-fail, `emitRunStarted` shape, CLAUDECODE env stripping. The new `tuiPromptRunner.test.js` only covers `cleanTuiResponse`.
- [ ] [med-importer-server-routes-importer-test-js-no] **[MED][IMPORTER]** `server/routes/importer.test.js` — no test pins `ERR_PARTIAL_COMMIT_ISSUES → 207` status mapping. Future refactor that drops the entry from `SERVICE_ERROR_STATUS` would 500 on partial commits and trigger pager alerts (the in-code comment's stated regression).
- [ ] [med-importer-server-services-importer-test-js-no] **[MED][IMPORTER]** `server/services/importer.test.js` — no test exercises `existingCanonBlock` dedupe wiring. A regression that wires `null` would silently degrade second-pass imports. Assert `mockRunStagedLLM.mock.calls[0][1].existingCanonBlock` contains a seeded character name.
- [ ] [med-canon-server-services-canonusage-js-zero-test] **[MED][CANON]** `server/services/canonUsage.js` — zero test coverage for `getUniverseCanonUsage`. The "Appears-in sort: issueCount desc + alpha tiebreaker" invariant lives at line ~101 with no test. Add a `canonUsage.test.js`.
- [ ] [low-ai-dispatch-server-lib-promptrunner-js-146] **[LOW][AI-DISPATCH]** `server/lib/promptRunner.js:146` — `effectiveCwd = cwdOverride ?? process.cwd()` doesn't catch empty string. Match `tuiPromptRunner.js:103`'s pattern: `(typeof cwdOverride === 'string' && cwdOverride) ? cwdOverride : process.cwd()`.
- [ ] [low-ai-dispatch-server-services-loops-js-181-fire] **[LOW][AI-DISPATCH]** `server/services/loops.js:181` — fire-and-forget `.then(...).catch(err => ...)` chain causes a throw in `onComplete({success:true})` to be misclassified as iteration-failed and emit `iteration:error`. Split into separate `.then` or wrap onComplete with its own catch.
- [ ] [low-canon-server-services-pipeline-textstages-js] **[LOW][CANON]** `server/services/pipeline/textStages.js:156` — dead-code fallback `|| series.characters` (always `undefined` post-B.4). Drop the middle clause.
- [ ] [low-canon-server-services-pipeline] **[LOW][CANON]** `server/services/pipeline/migrateSeriesCanon.js:61` — `updateSeries({ universeId })` writes mid-loop with the universe still empty. Crash between line 61 and the universe patch leaves series stripped + universe empty. Build the universe patch first, then write both.
- [ ] [low-importer-server-services-importer-js-444-446] **[LOW][IMPORTER]** `server/services/importer.js:444-446` — `arcSummary = arcContent.summary || arcContent.logline || \`${name} — ${type}\``silently swallows a successful arc-extract that returned empty fields. Log a warning or surface`arcExtractFallback: true`.
- [ ] [low-sharing-server-services-mediaannotations-js] **[LOW][SHARING]** `server/services/mediaAnnotations.js:154` — peer `updatedAt` not clamped to `Math.min(now, sane.updatedAt)`; a peer with future-skewed clock dominates all merges.
- [ ] [low-sharing-server-services-mediaannotations-js-2] **[LOW][SHARING]** `server/services/mediaAnnotations.js:132-167` — `mergePeerAnnotations` accepts `peerInstanceId === 'unknown'`; the outgoing path guards but the import side doesn't. Add `if (!peerInstanceId || peerInstanceId === 'unknown') return ...`.
- [ ] [low-sharing-server-services-sharing] **[LOW][SHARING]** `server/services/sharing/annotationsSync.js:38-68` — empty-payload writes fan to every auto-merge bucket per local edit. Skip when both prior and current filtered payloads are empty.
- [ ] [low-ai-dispatch-server-lib-ansistrip-js-14-pattern] **[LOW][AI-DISPATCH]** `server/lib/ansiStrip.js:14` — pattern doesn't strip lone `\x1B` bytes; chunk `\x1B\x1B[31m` leaks a raw escape. Add `.replace(/\x1B(?![@-_\[\]])/g, '')` second pass.

### Better-audit residue

- [x] [high-code-server-services-cos-js-3113-remove-node] ~~**[HIGH][CODE]** `server/services/cos.js:3113` — remove `NODE_ENV !== 'test' && VITEST !== 'true'` init guard (test hack in prod boot path).~~ **Shipped 2026-05-17** — `init()` is now exported and called explicitly from `server/index.js` (alongside the other `*.init()` calls); module-level auto-init removed entirely so the test guard is no longer needed.
- [ ] [high-tests-create-test-files-for-server-services] **[HIGH][TESTS]** Create test files for `server/services/clinvar.js` and `server/services/telegramBridge.js`.
- [ ] [high-tests-add-coverage-for-server-services-shell] **[HIGH][TESTS]** Add coverage for `server/services/shell.js` and `server/services/feeds.js` — both have exported functions but no sibling test. Shell drives all terminal sessions; feeds manages subscriptions. (New — surfaced 2026-05-16 replan.)
- [ ] [medium-client-4-components-still-redefine] **[MEDIUM][CLIENT]** 4 components still redefine `formatBytes`/`formatTime`/`formatDuration`/`timeAgo`/`formatDate` locally: `VideoTimelineEditor.jsx`, `VideoTimeline.jsx`, `MortalLoomTab.jsx`, `ImportTab.jsx`.
- [ ] [medium-perf-feeds-js-getitems-303-319-full-sort] **[MEDIUM][PERF]** `feeds.js#getItems` (303–319) — full-sort-then-paginate on every request. Pre-sort once at write time or maintain a per-feed index.
- [ ] [medium-code-magic-numbers-in-cos-js-166-357] **[MEDIUM][CODE]** Magic numbers in `cos.js:166,357`, `lmStudioManager.js:66`; brittle `err.message.startsWith('unknown piper voice:')` in `routes/voice.js:160` and `err.message.includes('not initialized')` in `services/visionTest.js:124`.
- [ ] [low-client-extract-shared-usepopoverposition-hook] **[LOW][CLIENT]** Extract shared `usePopoverPosition` hook — portal-with-fixed-positioning duplicated across 4 components (`AddToCollectionMenu`, `BulkTargetPicker`, `ThemeSwitcher`, `VisualStylePicker`) with near-identical rAF-coalesced scroll/resize listeners + `useLayoutEffect` measurement.

### Pipeline — deferred

- [ ] [wire-storyboards-scene-video-rendering-as-a] **Wire `storyboards` scene-video rendering** as a separate path from the episode-video handoff. Add optional `sceneVideoJobId` per scene.
- [ ] [rich-text-editor-for-prose-stage-replace-plain] **Rich-text editor for prose stage.** Replace plain textarea in `ProseStage.jsx` — reuse Writers Room editor or pick a minimal markdown editor.
- [ ] [versioning-diff-view-per-stage-persist-last-n] **Versioning / diff view per stage.** Persist last N `lastRunId` snapshots; offer a diff modal.
- [ ] [episode-video-provider-picker-runwayml-third-party] **Episode-video provider picker (RunwayML / third-party).** Once the abstraction lands, expose picker on EpisodeVideoStage.
- [ ] [comic-book-pdf-export-once-stages-comicpages] **Comic-book PDF export.** Once `stages.comicPages` carries enough panel data + rendered images, export print-ready PDF.
- [ ] [voice-controlled-stage-advancement-register] **Voice-controlled stage advancement.** Register pipeline stage navigation actions in `voice/tools.js`.
- [ ] [ai-assisted-panel-scene-prompt-generation-reserve] **AI-assisted panel/scene prompt generation.** Reserve `pipeline-comic-panel-image-prompt.md` and `pipeline-storyboard-image-prompt.md` for a future "turn script fragment into N image-gen prompts" button.
- [ ] [extract-migration-scaffolding-into-scripts] **Extract migration scaffolding into `scripts/migrations/_lib.js`.** Migrations 003, 006, and 019 all implement the same hash-driven prompt-replace pattern (~75 lines of boilerplate each). Lift to a shared helper; next migration becomes ~15 lines.
- [ ] [shots-aware-scene-output-contract-partial-split] **Shots-aware scene-output-contract partial.** Split into `_partials/scene-fields-core.md` + `_partials/scene-fields-shots.md` when a third shots-using stage appears.
- [ ] [per-panel-scene-image-progress-in-the-pipeline-ui] **Per-panel/scene image progress in the Pipeline UI.** ComicPages and Storyboards record `jobId` but don't subscribe to the media-job SSE for live preview.

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
