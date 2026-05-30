# server/lib/ — shared server helpers

Pure / side-effect-free helpers, validators, parsers, prompt builders, and shared constants.
**Before adding a new helper here, grep this catalog first** — if a similar module exists,
extend it. When you add a new module, add it to `index.js` AND add a row here.

Service-layer orchestration (multi-step business logic) lives in `server/services/`, not here.

## Discovery rule

```
grep -i "what you want to do" server/lib/README.md
```

The barrel `server/lib/index.js` is a machine-checkable enumeration of every public surface;
`server/lib/index.test.js` verifies that every non-test `.js` file is re-exported AND appears in this README, AND that no two flat-exported modules share an identifier name.

**Namespace exports.** The validation modules (`brainValidation`, `digitalTwinValidation`, etc.), `runners`, `stageRunner`, and `storyBible` are surfaced through the barrel as namespace exports — `barrel.brainValidation.settingsUpdateInputSchema`, not bare `settingsUpdateInputSchema` — because their generic names collide with peers. Direct deep imports (`import { settingsUpdateInputSchema } from './brainValidation.js'`) are unaffected.

---

## Validation (Zod schemas + request validators)

| Module | Purpose |
|---|---|
| `validation.js` | Catch-all Zod schemas + the `validateRequest` middleware + shared helpers (`optionalBooleanMap`). Most route inputs validate through here. |
| `appleHealthValidation.js` | Apple Health import payloads. |
| `brainValidation.js` | Brain/memory route schemas (search, ingest, edit). |
| `catalogValidation.js` | Creative ingredients catalog route schemas (scraps, ingredients, links, sync envelope). |
| `digitalTwinValidation.js` | Digital twin document/category schemas. |
| `genomeValidation.js` | Genome upload + search schemas. |
| `identityValidation.js` | Identity section + chronotype + scheduling schemas. |
| `meatspaceValidation.js` | Meatspace (location/health log) schemas. |
| `memoryValidation.js` | Memory record + retrieval schemas. |
| `notesValidation.js` | Notes route schemas + safe-relative-path guard. |
| `postValidation.js` | Social post schemas. |
| `socketValidation.js` | Socket event payload schemas. |
| `telegramValidation.js` | Telegram bot config + test schemas. |

## Story & narrative

| Module | Purpose |
|---|---|
| `storyBible.js` | Canonical Character / Place / Object shapes + `BIBLE_LIMITS`. |
| `storyArc.js` | Canonical Arc + Season + Reader-Map shapes for pipeline arc planning. |
| `storyBuilderSteps.js` | Unified Story Builder ordered step definitions + helpers (`STEPS`, `STEP_IDS`, `STEP_STATUSES`, `isValidStepId`, `stepIndex`). |
| `storyBuilderIntegrity.js` | Pure staleness hashing for the Story Builder (`hashUpstream`, `computeStaleSteps`). |
| `canonPrompt.js` | Per-kind field-precedence rules; SHORT/RICH/PREVIEW spec tables; `flattenCanonDescriptorFragments` / `mapCanonDescriptorFragments` / `descriptorForCanonEntry`. |
| `scenePrompt.js` | Scene-prompt composer + bible matchers (chars/places/objects in text). |
| `sceneExtractor.js` | Split prose or teleplay into scene list via LLM. |
| `seasonStructure.js` | Season/episode structure recommendation. |
| `bibleExtractor.js` | LLM bible-extraction stage + sanitization. |
| `comicScriptParser.js` | Marvel/DC-format comic script parser. |
| `composeStyledPrompt.js` | Compose user prompt + negative with an optional style preset. |
| `creativeDirectorPresets.js` | Locked-at-creation aspect ratio + quality presets for the Creative Director. |
| `creativeDirectorPrompts.js` | Creative Director agent prompt builders. |
| `universePromptRenderers.js` | Renderers that turn a universe's `categories` map + canon into prompt context. |
| `writersRoomPresets.js` | Writers Room enums (WORK_KINDS, WORK_STATUSES, ANALYSIS_KINDS). |
| `writersRoomStylePresets.js` | Curated style presets for storyboards + universe. |

## Prompt & AI

| Module | Purpose |
|---|---|
| `aiToolkit/` | Vendored toolkit (providers + runner + prompts + status). See `aiToolkit/index.js`. |
| `aiToolkitState.js` | Module-level singleton for the toolkit instance shared by the `providers`/`runner`/`promptService` shims — `setAIToolkitInstance` / `requireToolkit` (throws `AI_TOOLKIT_NOT_INITIALIZED`) / `getAIToolkitInstance` (no-throw for cleanup paths). |
| `aiProvider.js` | Shared AI provider utilities for LLM calls. |
| `promptRunner.js` | Shared LLM runner wrapper. |
| `tuiPromptRunner.js` | One-shot TUI prompt runner (PTY-driven). |
| `tuiHandshake.js` | Shared TUI invocation + paste-handshake constants. |
| `stageRunner.js` | Shared staged-LLM runner. |
| `promptTemplate.js` | Mustache-flavored, dot-notation-aware prompt template engine. |
| `promptPartials.js` | Mustache-style partial expansion. |
| `mediaModels.js` | Single source of truth for image/video model metadata. |
| `providerModels.js` | Provider model resolution sentinel + helpers. |
| `cliProviderArgs.js` | Per-CLI argv conventions (`buildCliArgs`) for stdin prompt delivery — dependency-light extraction from runner.js so out-of-process callers (autofixer) can import it. |
| `cliProviderRun.js` | One-shot CLI provider invocation (`pickCliProvider` + `runCliProviderPrompt`) — lightweight path for the autofixer + calendar MCP sync to honor the configured provider/model. |
| `runners.js` | Image-runner family constants. |
| `codexAssistantExtract.js` | Strip Codex CLI banner + echoed metadata from session transcript. |
| `codexCliOutput.js` | Network/system error patterns for `agentErrorAnalysis.js`. |
| `ansiStrip.js` | Streaming ANSI / control-byte stripper. |
| `hfToken.js` | HuggingFace token resolution (settings > env > CLI). |
| `hfCache.js` | HuggingFace Hub cache inspection (`inspectModelCache(repoId)` → `{cached,sizeBytes,snapshotPath}`, `isModelCached`, `getHfCacheRoot`). Drives the inline "Available / Download" badge on the image + video gen forms. |
| `hfDownload.js` | `downloadHfRepo({repo,onEvent})` returning `{promise,kill}` — spawns `scripts/hf_download_repo.py` in the FLUX.2 venv (fallback: mflux pythonPath) and emits SSE-friendly stage/progress/complete events. Powers the inline "Download" button next to the model picker. |
| `sseDownload.js` | `startHfDownloadStream({req,res,repo,alreadyDownloadedMessage})` — shared SSE driver used by both image and video gen `/models/:id/download` routes. Owns the cross-route in-flight Map so a double-click (or both pages running) can't spawn two python children against the same repo. |

## File & I/O

| Module | Purpose |
|---|---|
| `collectionStore.js` | Per-type, per-record JSON storage with explicit type-level `schemaVersion` stamping. Use for collections that have outgrown a monolithic JSON file. `createCollectionStore({ dir, type, schemaVersion, sanitizeRecord })` returns `loadOne` / `saveOne` / `saveOneNow` / `listIds` / `loadAll` / `deleteOne` / `loadTypeIndex` / `saveTypeIndex` / `verifySchemaVersion`. Per-id write queue means writes to different records don't serialize; `saveOneNow` is for callers already inside a collection write queue. Boot-time `verifyCollectionVersions([store, ...])` logs schema-version mismatches. |
| `conflictJournal.js` | Non-blocking edit-conflict journal for cross-install LWW merges. `maybeJournalBeforeOverwrite({kind,id,local,remote,source})` (call right before a merge overwrite) archives the losing local version when a true 3-way divergence is detected (`detectConflict` via per-record `syncBaseHash` + `contentHashForRecord`), then advances the base hash; `flushBaseHashes()` persists the batched base-hash side store. `deleteSyncBaseHash(kind,id)` evicts a record's base hash when its tombstone is hard-pruned (called from `pruneTombstonedUniverses`/`pruneTombstonedSeries`) so the side store doesn't grow without bound. `conflictJournalStore()` is the `pending`/`resolved` entry store (discard resolves an entry; DELETE hard-removes it — there is no `dismissed` status). Local-only — never crosses the wire. |
| `schemaVersions.js` | Cross-instance sync version contract. `PORTOS_SCHEMA_VERSIONS` (frozen map of `{ category: layoutVersion }`), `RECORD_KIND_SCHEMA_CATEGORIES` (frozen map of federated record kind → the schema categories it writes), `buildPortosMeta()` (envelope for every outbound sync payload), `compareSchemaVersions(sender, receiver)` returning `{ ahead, behind, compatible }`, `scopeVersionDiff(diff, categories)` (restrict that diff to the categories a specific transfer touches), and `formatVersionGap()` for UI/log lines. Receivers gate `applyIncomingPush` / share-bucket import / snapshot apply per-category on the scoped comparator result so an upgraded sender can't corrupt a downstream peer — and a bump to one category doesn't sever sync of the others. |
| `fileUtils.js` | `PATHS` constants, `atomicWrite`, `tryReadFile`, `safeJSONParse`, `expandHome` (`~/foo` → absolute), JSONL append/read/write helpers, dir scans, hashes, JSON helpers. Most paths/file work goes through here. |
| `fileWriteQueue.js` | Single-tail promise chain for serializing writes to a file. |
| `imageClean.js` | `cleanImageBuffer` (sharp-based denoise + C2PA strip) + `autoCleanGeneratedImage` (in-place clean for post-generation hook). HTTP route in `routes/imageClean.js` wraps `cleanImageBuffer`. |
| `multipart.js` | Streaming multipart/form-data parser. |
| `pdfImageEmbed.js` | PDF image embed helpers for comic / volume PDFs. |
| `zipStream.js` | Streaming ZIP parser. |
| `assetHash.js` | Cross-transport SHA-256 cache for `data/images/*` — persists hashes in the asset's `.metadata.json` sidecar so the share-bucket exporter and the federated peer-sync push pipeline reuse the same value. `sidecarGenParamsHash` canonically hashes a sidecar's gen-params (excludes the machine-local `sha256` cache block) for cross-machine sidecar-convergence comparisons. |

## Process execution

| Module | Purpose |
|---|---|
| `commandSecurity.js` | Allowlist of safe shell commands. |
| `execGit.js` | `execGit` utility imported by `git.js` + worktree manager. |
| `ffmpeg.js` | Shared ffmpeg helpers (videoGen + videoTimeline). |
| `gitRemote.js` | `getOriginInfo`, `parseGitRemoteUrl`, `UPSTREAM_OWNER`/`UPSTREAM_REPO` — classifies the local `origin` remote vs the upstream atomantic/PortOS repo. Used by the update flow to detect forks. |
| `processEnv.js` | `stripDebugMallocEnv(env)` — drop macOS `Malloc*` debug env vars before spawning a child. Pinokio-launched PortOS exports `MallocStackLogging`/`MallocScribble`/etc. that flood Python subprocess stderr with `can't turn off malloc stack logging` lines; route every Node→Python spawn through this. No-op on Linux/Windows. |
| `pythonSetup.js` | Python venv / runner setup helpers. |

## Networking

| Module | Purpose |
|---|---|
| `httpClient.js` | Fetch-based HTTP client factory (axios.create replacement). |
| `fetchWithTimeout.js` | `fetch` wrapper with AbortController timeout. |
| `peerHttpClient.js` | Federation HTTP/Socket.IO client (TLS validation off — Tailnet is the trust boundary). |
| `peerSelfHost.js` | Tailscale-issued hostname this PortOS sends in federation. |
| `peerUrl.js` | Build the base URL for a peer. |
| `sharingOrigin.js` | Origin metadata for records imported from share buckets. |
| `syncIntegrity.js` | Pure diff of local vs remote manifest lists. `INTEGRITY_STATUS` constants + `computeRecordIntegrity(localList, remoteList)` — classifies each record as `in-parity`, `local-only`, `peer-only`, `diverged`, or `assets-missing`. No I/O. |
| `syncWire.js` | Single source of truth for what fields cross the federated-peer wire (snapshot loop + per-record push agree). |
| `tailscale.js` | Locate the Tailscale CLI binary and flag the sandboxed macOS App-bundle build (which can't write `tailscale cert` output outside its container). |
| `httpsState.js` | Captures whether PortOS booted with HTTPS active. |
| `networkExposure.js` | Snapshot of scheme + bind + cert mode for the dashboard's Network Exposure widget. |

## Search & indexing

| Module | Purpose |
|---|---|
| `bm25.js` | BM25 ranking + inverted-index helpers. |
| `vectorMath.js` | Vector math utilities (cosine, etc.). |
| `memoryStats.js` | macOS-correct memory accounting (handles "Pages free" quirk). |

## Extraction & parsing

| Module | Purpose |
|---|---|
| `jsonExtract.js` | Pull JSON blocks out of LLM responses. |
| `taskParser.js` | Parse `TASKS.md` format. |

## Curated static data

| Module | Purpose |
|---|---|
| `curatedGenomeMarkers.js` | Curated SNP database with classification logic. |

## Domain utilities

| Module | Purpose |
|---|---|
| `appResolver.js` | Fuzzy-match a spoken/typed phrase to a managed app (`{ id, name }`). Tiered exact → prefix → substring, used by voice tools that target a specific app. |
| `capabilityMap.js` | Pure row builders for the Capability Map (per-integration status tiers + rollup); fed by `routes/capabilities.js`. |
| `civitai.js` | Civitai URL parsing + API client. |
| `localLlmCatalog.js` | Curated cross-backend (Ollama↔LM Studio) local-LLM catalog + install-id mapping for the migrate flow. Pure. |
| `localLlmDisk.js` | Pure on-disk reasoning for the migrate "copy GGUF locally instead of re-downloading" fast-path (Ollama manifest/blob parsing, LM Studio path layout, MLX/projector/shard detection). |
| `issueLength.js` | Per-issue size targets fed into text stages. |
| `mediaItemKey.js` | `<kind>:<ref>` key vocabulary for media items. |
| `navManifest.js` | Single source of truth for nav (`⌘K` palette + voice). Add an entry when you add a page. |
| `pipelineIssueOrder.js` | Pure renumber algorithm for pipeline issues. |
| `planIds.js` | Utilities for PLAN.md `[slug]` IDs. |
| `renderSlot.js` | Render-slot helpers for `(proof\|final)Image` per stage. |
| `telegramClient.js` | Telegram bot client. |

## Model & config

| Module | Purpose |
|---|---|
| `db.js` | PostgreSQL connection pool. |
| `ports.js` | Canonical PORTS object (re-exported from `ecosystem.config.cjs`). |
| `platform.js` | Platform/OS detection helpers. |
| `timezone.js` | Timezone utilities for scheduling. |
| `buildId.js` | Build-ID derived from the built client bundle. |

## General utilities

| Module | Purpose |
|---|---|
| `asyncMutex.js` | Promise-based async mutex. |
| `errorHandler.js` | `ServerError` + `asyncHandler` middleware. |
| `objects.js` | Object utilities — `deepMerge` (recursive merge w/ array replacement), `isPlainObject` (non-null, non-array `object` guard for JSON / LLM payloads), `POLLUTING_KEYS` (shared `__proto__`/`constructor`/`prototype` denylist for sanitizers), `canonicalStringify` (recursive sorted-key JSON serialization for cross-machine content hashing), `isEmptyScalar` (true for null/undefined/whitespace-string/empty-array — merge gap-fill gate). |
| `sseUtils.js` | Per-job SSE stream helpers (imageGen + others). |
| `uuid.js` | `v4()` thin wrapper over `crypto.randomUUID()`. |

## Test support

| Module | Purpose |
|---|---|
| `mockPathsDataRoot.js` | Shared Vitest helpers for `PATHS.data → temp dir` and no-peer record creation guards. |
| `testHelper.js` | Test HTTP request helper. |
