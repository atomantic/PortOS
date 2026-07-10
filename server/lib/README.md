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
| `validation.js` | Catch-all Zod schemas (app/process/provider, social accounts, GitHub, backup/sharing, document/legacy-export) + the `validateRequest` middleware + shared helpers (`optionalBooleanMap`, `isSafeRecordId`, `parsePagination`). Re-exports the per-domain validation files below so existing deep imports keep working. |
| `agentSentinel.js` | The `.agent-done` completion sentinel: `DONE_SENTINEL_NAME` + pure `parseSentinelPayload(contents)` → `{ summary, payload }`. Back-compat — a plain-markdown sentinel yields `payload: null`; a JSON object yields its structured `payload` for a programmatic-I/O task type's `processTaskOutput` hook. |
| `agentValidation.js` | Social-bot agent schemas (personality, Moltbook/Moltworld accounts, automation schedules, agent tools + Moltworld payloads) and CoS Feature Agent definitions. |
| `appleHealthValidation.js` | Apple Health import payloads. |
| `brainValidation.js` | Brain/memory route schemas (search, ingest, edit). |
| `catalogValidation.js` | Creative ingredients catalog route schemas (scraps, ingredients, links, relations, tags, revisions, sync envelope). |
| `cosValidation.js` | Chief-of-Staff task/job/loop/learning schemas, the Review-Loop reviewer vocabulary + helpers (`normalizeReviewers`/`buildReviewWithArgs`), the Code-Review settings slice, and the task-metadata sanitizer. |
| `creativeDirectorValidation.js` | Creative Director project/treatment/scene + Create-Suite importer schemas. |
| `digitalTwinValidation.js` | Digital twin document/category schemas. |
| `genomeValidation.js` | Genome upload + search schemas. |
| `identityValidation.js` | Identity section + chronotype + scheduling schemas. |
| `meatspaceValidation.js` | Meatspace (location/health log) schemas. |
| `mediaValidation.js` | Media-generation & local-model infra schemas (LoRA training, local-LLM/Ollama/LM Studio management, CyberCity snapshots, media-collection bulk ops). |
| `memoryValidation.js` | Memory record + retrieval schemas. |
| `moodBoardValidation.js` | Mood board + board-item create/update schemas. |
| `musicVideoValidation.js` | Music Video project/scene/reorder + cached audio-analysis schemas. |
| `notesValidation.js` | Notes route schemas + safe-relative-path guard. |
| `peerSyncValidation.js` | Federated peer-sync wire/request schemas (push payload, subscribe, sync-now, pull-metadata). |
| `pipelineValidation.js` | Creative-production pipeline schemas (Writers Room works/folders/live-mode/drafts, story-bible character/place/object, editorial checks, storyboard shots/scenes, prompt-stage config, issue-list query). |
| `postValidation.js` | MeatSpace POST (Power On Self Test) schemas — drill config (incl. adaptive toggle), drill generation/scoring, sessions, memory builder, training log. |
| `privacyValidation.js` | Privacy Center schemas — PII Vault (issue #2140): vault record create/update (partial PUT), list query, UUID params; the vault type/status vocabularies + the sensitive-type (`ssn`/`passport`/`drivers_license`/`financial_account`) `useForScans` hard-false rule and per-type scan defaults. Trusted Organizations registry (issue #2141): org create/update (partial PUT), list query, UUID params, and the replace-set holdings schema. Data-broker database + case ledger (issue #2144): broker list/case-list query filters, the scan-start + refresh action bodies, and the `PRIVACY_BROKER_CASE_STATES` vocabulary. |
| `socketValidation.js` | Socket event payload schemas. |
| `storyBuilderValidation.js` | Unified Story Builder session/step schemas. |
| `telegramValidation.js` | Telegram bot config + test schemas. |

## Story & narrative

| Module | Purpose |
|---|---|
| `editorial/` | Extensible editorial-check registry (#1284) — `EDITORIAL_CHECKS` + fail-fast guards + lookup/state helpers. See `editorial/README.md`. The runner that executes checks lives at `server/services/pipeline/editorial/checkRunner.js`. |
| `storyBible.js` | Canonical Character / Place / Object shapes + `BIBLE_LIMITS`. Also the reveal-gated canon / spoiler-scoping helpers (#2178): `filterCanonForIssue` / `filterCanonListForIssue` / `isCanonEntryGatedForIssue` (hide or surface-substitute a gated entry in a drafting prompt), `canonHasRevealGated` + `revealGatedCanonRows` (for the `continuity.premature-reveal` check gate/summary). |
| `storyArc.js` | Canonical Arc + Season + Reader-Map shapes for pipeline arc planning. |
| `styleGuide.js` | Per-series house style (tense/POV/audience/rating/reading-level/tone/conventions): `sanitizeStyleGuide` + `renderStyleGuide` generation block + enums. |
| `storyBuilderSteps.js` | Unified Story Builder ordered step definitions + helpers (`STEPS`, `STEP_IDS`, `STEP_STATUSES`, `isValidStepId`, `stepIndex`). |
| `storyBuilderIntegrity.js` | Pure staleness hashing for the Story Builder (`hashUpstream`, `computeStaleSteps`, `computeSyncDrift`). |
| `canonPrompt.js` | Per-kind field-precedence rules; SHORT/RICH/PREVIEW spec tables; `flattenCanonDescriptorFragments` / `mapCanonDescriptorFragments` / `descriptorForCanonEntry`. |
| `scenePrompt.js` | Scene-prompt composer + bible matchers (chars/places/objects in text). |
| `sceneExtractor.js` | Split prose or teleplay into scene list via LLM. |
| `proseExportSettings.js` | Per-series prose-export settings (#2181): `sanitizeProseExportSettings` + `resolveExportSettings` + `TRIM_SIZES`/`INTERIOR_FONTS` for the manuscript/ePub/PDF exports. |
| `shotGrammar.js` | Pure shot-grammar vocabularies (`SHOT_TYPES`, `SCREEN_DIRECTIONS`) + normalizers (`normalizeShotType`, `normalizeScreenDirection`) for a storyboard shot's camera framing + on-screen direction. Shared by the scene extractor's sanitizer, the storyboards Zod schema, and the `visual.shot-continuity` editorial check (#1315). |
| `seasonStructure.js` | Season/episode structure recommendation. |
| `seriesCharacterArc.js` | Per-character story-arc shapes (`series.characterArcs[]`): want/need, start → end state, transition beats. Sanitizers + `renderCharacterArcsForPrompt` for the `arc.transitions` editorial check. |
| `seriesLlmOverride.js` | Pure `resolveSeriesLlmOverride(series, { overrideProvider, overrideModel })` → `{ provider, model, providerMatchesSeries }` — shared fallback so Pipeline LLM actions honor the series' configured provider/model, only inheriting the series model when the effective provider still matches. |
| `bibleExtractor.js` | LLM bible-extraction stage + sanitization. |
| `catalogBulkParsers.js` | Dependency-free markdown/CSV/JSON parsers for `POST /api/catalog/bulk-import` and YAML/markdown serializers for `GET /api/catalog/export`. |
| `catalogChunking.js` | Pure lossless scrap-text chunker (`chunkRawText`, `CATALOG_CHUNK_MAX_CHARS`) — splits a long paste into ≤maxChars chunks on paragraph/newline/sentence/whitespace boundaries so the catalog extractor processes each child and unions results. |
| `catalogTypes.js` | Shared catalog ingredient TYPE REGISTRY — one entry per type drives validation enum, ID prefix, FTS field set, extraction shape, per-record `payloadSchemaVersion` + upgraders, per-type `defaultTags`. Also exports the relation-kind registry and the tag-taxonomy helpers (`canonicalTagKey`, `tagIdForKey`, `defaultTagsForType`). Mirrored on the client at `client/src/lib/catalogTypes.js`. |
| `catalogUniverseTags.js` | Pure transform that rewrites legacy machine universe tags (`from-universe`, `universe:<id>`) on backfilled catalog ingredients into friendly universe-NAME tags, preserving user tags + the structured `catalog_ingredient_refs` link. Used by the boot-time repair and the bible→catalog backfill. |
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
| `antigravity.js` | Antigravity (`agy`) CLI provider helpers — id/sentinel constants (`ANTIGRAVITY_CLI_ID`, `ANTIGRAVITY_CONFIGURED_DEFAULT`, `LEGACY_GEMINI_*`), `isAntigravityCommand`/`isAntigravityCliProvider` predicates, and `ensureAntigravityPrintArgs`/`ensureAntigravityTuiArgs`/`stripAntigravityUnsupportedArgs` argv normalizers (strip legacy Gemini `--yolo`/`-m`/`--output-format`). |
| `aiProvider.js` | Shared AI provider utilities for LLM calls. |
| `promptRunner.js` | Shared LLM runner wrapper. |
| `tuiPromptRunner.js` | One-shot TUI prompt runner (PTY-driven). |
| `tuiHandshake.js` | Shared TUI invocation + paste-handshake constants. |
| `stageRunner.js` | Shared staged-LLM runner. |
| `promptTemplate.js` | Mustache-flavored, dot-notation-aware prompt template engine. |
| `promptPartials.js` | Mustache-style partial expansion. |
| `mediaModels.js` | Single source of truth for image/video model metadata. |
| `providerModels.js` | Provider model resolution sentinels + helpers (`CODEX_CONFIGURED_DEFAULT` / `ANTIGRAVITY_CONFIGURED_DEFAULT` / `GROK_CONFIGURED_DEFAULT`, `resolveCliModel`, `filterSelectableModels`, Bedrock/OpenCode model mappers, model-flag scan helpers). |
| `opencodeConfig.js` | OpenCode config builder — `buildOpencodeEnvVars(provider, model)` builds dynamic `OPENCODE_CONFIG_CONTENT` declaring the models map under `provider.ollama.models` (bare ids) for Ollama-backed OpenCode providers. Fixes --model rejection. |
| `cliProviderArgs.js` | Per-CLI argv conventions (`buildCliArgs`) for stdin prompt delivery — dependency-light extraction from runner.js so out-of-process callers (autofixer) can import it. |
| `cliProviderRun.js` | One-shot CLI provider invocation (`pickCliProvider` + `runCliProviderPrompt`) — lightweight path for the autofixer + calendar MCP sync to honor the configured provider/model. |
| `grok.js` | xAI Grok Build (`grok`) provider helpers — id/endpoint constants (`GROK_API_ID`/`GROK_CLI_ID`/`GROK_TUI_ID`/`GROK_API_ENDPOINT`), `isGrokCommand`/`isGrokCliProvider`/`isGrokTuiProvider` predicates, `ensureGrokHeadlessArgs`/`ensureGrokTuiArgs` argv builders (grok reads its prompt from `--prompt-file /dev/stdin`, not raw stdin; model selection uses the `GROK_CONFIGURED_DEFAULT` sentinel in `providerModels.js` so PortOS omits `--model` like Antigravity), and `prepareGrokPromptFile` (Windows temp-file delivery fallback). |
| `runners.js` | Image-runner family constants. |
| `codexAssistantExtract.js` | Strip Codex CLI banner + echoed metadata from session transcript. |
| `codexCliOutput.js` | Network/system error patterns for `agentErrorAnalysis.js`. |
| `contextBudget.js` | Context-window budgeter for editorial passes. `estimateTokens` (chars/4), `usableInputTokens`, `manuscriptContentBudgetChars` (single-block content cap floored at a manuscript minimum so a standalone stage trims to fit a small window instead of overflowing a fixed 48–60K floor, #1488), `planManuscriptPass({ contextWindow, sections })` → `{ mode: 'whole' \| 'chunked', chunks }`. Also `fitContextToManuscriptFloor`/`capContextOverhead`/`trimContextToBudget` — trim a re-sent context block (scene map, character arcs, …) so a large reverse outline on a small window can't starve the manuscript chunk below a budget floor (#1459). Decides whole-manuscript vs chunked given a model's window. |
| `ansiStrip.js` | Streaming ANSI / control-byte stripper. |
| `hfToken.js` | HuggingFace token resolution (settings > env > CLI). |
| `hfErrors.js` | Parse huggingface_hub gated-access errors: `extractGatedRepo(text)` → `owner/name` (or null) for the UI's license deep-link. Shared by the image runner and LoRA trainer. Pure. |
| `hfCache.js` | HuggingFace Hub cache inspection (`inspectModelCache(repoId)` → `{cached,sizeBytes,snapshotPath}`, `isModelCached`, `getHfCacheRoot`). Drives the inline "Available / Download" badge on the image + video gen forms. Also `verifyModelCache(repoId,{deep})` (structural safetensors-header + optional sha256 integrity check) and `repairModelCache(repoId,{deep})` (delete corrupt weight files so the download path re-fetches them) — power the "Repair model" banner. `verifySafetensorsStructure(path,size)` is the reusable header/size structural check (reads only the header region) — also used by the Civitai/HF LoRA install path to reject truncated downloads. |
| `hfDownload.js` | `downloadHfRepo({repo,onEvent})` returning `{promise,kill}` — spawns `scripts/hf_download_repo.py` in the FLUX.2 venv (fallback: mflux pythonPath) and emits SSE-friendly stage/progress/complete events. Powers the inline "Download" button next to the model picker. |
| `sseHeaders.js` | `SSE_HEADERS` — the canonical SSE response headers (incl. `X-Accel-Buffering:no`) in a dependency-free module so any producer (`sseDownload.js`, `sseUtils.js`) can share them without pulling in a heavier module's transitive imports. |
| `sseDownload.js` | `startHfDownloadStream({req,res,repo,alreadyDownloadedMessage})`, `openSseStream(res)` (`{send,safeEnd}` SSE boilerplate; uses `SSE_HEADERS` from `sseHeaders.js`) — shared SSE driver used by both image and video gen `/models/:id/download` routes. Owns the cross-route in-flight Map so a double-click (or both pages running) can't spawn two python children against the same repo. |

## File & I/O

| Module | Purpose |
|---|---|
| `collectionStore.js` | Per-type, per-record JSON storage with explicit type-level `schemaVersion` stamping. Use for collections that have outgrown a monolithic JSON file. `createCollectionStore({ dir, type, schemaVersion, sanitizeRecord })` returns `loadOne` / `saveOne` / `saveOneNow` / `listIds` / `loadAll` / `deleteOne` / `loadTypeIndex` / `saveTypeIndex` / `verifySchemaVersion`. Per-id write queue means writes to different records don't serialize; `saveOneNow` is for callers already inside a collection write queue. Boot-time `verifyCollectionVersions([store, ...])` logs schema-version mismatches. **Type-index `config` slot** holds cross-record state (see the `TypeIndexConfig` typedef + header convention): `{ runs?: [], featureFlags?: {}, lockPolicies?: {} }` — `runs` is the shipped slot (universeBuilder's capped history log), the other two are reserved names; consumers may add their own keys but should reuse a reserved name when it fits and document the shape next to the consumer. `saveTypeIndex({ config })` shallow-merges `config` one level deep (a patched `runs` replaces the whole array), so a read-modify-write of a slot must load → mutate a copy → write inside `queueTypeIndexWrite(fn)`. |
| `conflictJournal.js` | Non-blocking edit-conflict journal for cross-install LWW merges. `maybeJournalBeforeOverwrite({kind,id,local,remote,source})` (call right before a merge overwrite) archives the losing local version when a true 3-way divergence is detected (`detectConflict` via per-record `syncBaseHash` + `contentHashForRecord`), then advances the base hash; `flushBaseHashes()` persists the batched base-hash side store; `withBaseHashFlushBatch(fn)` defers every interior flush so an await-separated multi-record push loop (peer:online convergence) collapses N `sync_base_hashes.json` rewrites into one terminal write (re-entrant; flushes in `finally`). `deleteSyncBaseHash(kind,id)` evicts a record's base hash when its tombstone is hard-pruned (called from every `pruneTombstoned*` path — universe/series/issue/collection) so the side store doesn't grow without bound; `pruneOrphanedBaseHashes(resolves)` is the backstop sweep (`resolves(kind,id) => bool`; unknown kinds kept) that drops keys whose record no longer resolves, wired into the tombstone GC sweep. `conflictJournalStore()` is the `pending`/`resolved` entry store (discard resolves an entry; DELETE hard-removes it — there is no `dismissed` status). Local-only — never crosses the wire. |
| `schemaVersions.js` | Cross-instance sync version contract. `PORTOS_SCHEMA_VERSIONS` (frozen map of `{ category: layoutVersion }`), `RECORD_KIND_SCHEMA_CATEGORIES` (frozen map of federated record kind → the schema categories it writes), `buildPortosMeta()` (envelope for every outbound sync payload), `compareSchemaVersions(sender, receiver)` returning `{ ahead, behind, compatible }`, `scopeVersionDiff(diff, categories)` (restrict that diff to the categories a specific transfer touches), and `formatVersionGap()` for UI/log lines. Receivers gate `applyIncomingPush` / share-bucket import / snapshot apply per-category on the scoped comparator result so an upgraded sender can't corrupt a downstream peer — and a bump to one category doesn't sever sync of the others. |
| `dataRoot.js` | Data-root resolution + worktree-checkout detection (#1947). `resolveInstallRoot(fallbackRoot)` prefers the `PORTOS_DATA_ROOT` env var (pinned at real launch in `ecosystem.config.cjs`) over an `import.meta.url`-derived fallback, so a process booted from inside a CoS agent git worktree still resolves `data/`/`data.reference/` to the real install instead of the worktree's empty tree. `isWorktreeRoot(rootDir)` is the boot-migration backstop — true when `rootDir` lives under `data/cos/worktrees/` (keyed on the path segment only, so a fresh install's empty `data/` isn't a false positive). `DATA_ROOT_ENV` is the env-var name constant. Consumed by `fileUtils.js` (`PATHS`), `server/index.js`, and `scripts/run-migrations.js`. |
| `fileUtils.js` | `PATHS` constants, `atomicWrite`, `tryReadFile`, `pathExists` (async `existsSync` replacement for request/hot paths), `safeJSONParse`, `expandHome` (`~/foo` → absolute), `sleep(ms)`, `sanitizeFilename`, `importFileToUploads(tempPath, name)` (land a server-produced temp file in `PATHS.uploads` with `/api/uploads` naming), JSONL append/read/write helpers, dir scans, hashes, JSON helpers. Most paths/file work goes through here. |
| `createKeyCachedQueue.js` | Per-KEY serialized async work queue (sibling to `fileWriteQueue.js`'s single tail). `createKeyCachedQueue()` returns `queue(key, work)` that chains each `work` thunk onto the prior in-flight promise for that `key` — same-key work runs one-after-another (later sees earlier's committed result), different keys run concurrently. Self-pruning tail Map; `work` runs on both fulfil and reject so one failure can't stall the chain; carries `.clear()` for test reset. Used by the media-job completion hooks (writers-room / catalog / music-video scene-image attach) to serialize per-record. |
| `createNewestWinsGuard.js` | Newest-render-wins ordering guard for out-of-order async completions. `createNewestWinsGuard()` returns `{ isStale(key, at), mark(key, at), clear() }` — tracks the newest applied `queuedAt` per slot `key` so an older render completing after a newer one is dropped (`isStale` true) instead of clobbering the newer frame. ISO timestamps compare as strings; absent `at` is never stale. Used by `createMediaJobImageHook`'s opt-in guard and the catalog hook's portrait slot. |
| `fileWriteQueue.js` | Single-tail promise chain for serializing writes to a file. |
| `imageClean.js` | `cleanImageBuffer(buf, { metadata, denoise })` (composable opt-in pipeline: lossless metadata/C2PA strip + optional median/sharpen denoise) · `stripPngMetadataChunks` / `stripPngC2PAChunk` (lossless PNG-chunk removers) · `compositeIgnoreZone(base, original, mask, { feather })` (preserve-region compositing: restore original pixels into a feathered mask over a diffused result) · `autoCleanGeneratedImage` (in-place clean for post-generation hook). HTTP route in `routes/imageClean.js` wraps `cleanImageBuffer` and appends a CPU light diffusion pass (`applyLightRegen` from `services/imageGen/regen.js`) for the `diffusion=light` SynthID-disruption step. |
| `imageWatermark.js` | `removeCornerWatermark` (erases the visible Gemini/Nano-Banana bottom-right ✦ via dependency-free harmonic/Laplace inpaint) + pure helpers `resolveWatermarkRegion` / `inpaintRegion`. Distinct from SynthID regen — this targets the *visible* corner logo. |
| `localImageFilename.js` | `localImageFilename(urlOrPath)` resolves a stored image reference to the bare gallery-image filename under `data/images/` (or null for empty/external-URL/non-image-path) — the unit the peer-sync asset pipeline hashes + transfers. Single source of truth for the authors/artists/albums/Creative-Director filename resolvers (`headshotImageFilename`/`portraitImageFilename`/`coverImageFilename`/`startingImageFilename` are thin wrappers). Also exports `assetBasename(pathOrName)`, the shared strip-querystring→basename primitive (reused by moodBoard's `imageUrlToAppAsset`). |
| `multipart.js` | Streaming multipart/form-data parser. |
| `safetensors.js` | `readSafetensorsHeader(path)` reads only the JSON header of a `.safetensors` file (never the tensor payload). `detectFlux2VariantFromHeader(header)` / `detectFlux2Variant(path)` classify a LoRA as FLUX.2 Klein `'4b'` (hidden dim 3072) vs `'9b'` (4096) by transformer-block tensor shapes, so the LoRA picker can hide off-variant weights that would silently fail to load. |
| `pdfImageEmbed.js` | PDF image embed helpers for comic / volume PDFs. |
| `zipStream.js` | Streaming ZIP parser (`parseZip`, unzipper-style); `collectZipEntry(entry, maxBytes?)` buffers one `parseZip` entry into a Buffer (size-capped); `collectZipEntries(path, { match, onMatch, maxBytes? })` owns the multi-entry import lifecycle (teardown, autodrain, per-entry await) leaving callers only match/parse; `isZipUpload(file)` predicate for an uploaded ZIP; `extractZipEntryToBuffer(path, match)` cracks one member out to a Buffer. |
| `zipWriter.js` | Minimal ZIP writer — `createZip(entries)` builds a stored (uncompressed) archive Buffer that round-trips through `parseZip`; `crc32(buf)` is the dependency-free checksum it uses. |
| `assetHash.js` | Cross-transport SHA-256 cache for `data/images/*` — persists hashes in the asset's `.metadata.json` sidecar so the share-bucket exporter and the federated peer-sync push pipeline reuse the same value. `sidecarGenParamsHash` canonically hashes a sidecar's gen-params (excludes the machine-local `sha256` cache block) for cross-machine sidecar-convergence comparisons. |

## Process execution

| Module | Purpose |
|---|---|
| `agentGuard/` | `agentGuardEnv(baseEnv?)` + `AGENT_GUARD_BIN` — env patch that prepends a guarded `pm2` shim (`bin/pm2`) to a spawned AI agent's PATH so a confused `--dangerously-skip-permissions` agent can't `pm2 kill` / `pm2 delete all` the shared daemon (which would down every app, incl. PortOS). Blocked-subcommand list mirrors `validatePm2Command` in `commandSecurity.js`. POSIX-only (no-op on Windows). |
| `bashResolver.js` | `resolveBashBinary()` — resolves the POSIX `bash` for running bundled `*.sh` scripts (e.g. `scripts/db.sh`). On Windows a bare `bash` often resolves (via PM2's PATH) to WSL, which mounts drives at `/mnt/h` and can't see a `H:/...` drive path (exit 127); this prefers Git Bash (PORTOS_BASH override → standard install dirs → derived from `git` on PATH → bare `bash`). No-op (`bash`) on non-Windows. |
| `openFolder.js` | `openFolderInSystemExplorer(localPath)` — cross-platform "open in Finder/Explorer/Nautilus" via detached spawn; child `error` handler prevents spawn failures from crashing the process. |
| `bufferedSpawn.js` | `bufferedSpawn(cmd, args, opts)` (structured non-throwing result) + `bufferedSpawnOrThrow` (throwing adapter), plus `killProcessTree`, `resolveWindowsExecutable`, `prepareWindowsSafeSpawn`, `prepareCliSpawn(command, args, env)` (composed resolve+wrap for a `spawn()`-safe pair), `needsShell`, `IS_WIN32`, `WIN_CMD_SHIMS`, `MAX_OUTPUT_BYTES` — shared buffered-spawn machinery with capped stdout/stderr, timeout-kill, Windows `.cmd`/`.bat` shim resolution, and `taskkill /T /F` tree-kill. Used by `appBuilder.js`, `appUpdater.js`, and the CoS agent spawners. |
| `commandSecurity.js` | Allowlist of safe shell commands + `validatePm2Command(args)` (rejects daemon-wide `pm2 kill`/`startup`/`unstartup` and `<verb> all`). `validateCommand` runs the pm2 check for `pm2` base commands. Mirrored by the `agentGuard/` PATH shim for agentic paths. |
| `detachedSpawn.js` | `spawnDetached(bin, args, {controlDir,env,cwd})` → ChildProcess-like handle for a long media job that SURVIVES `pm2 restart portos-server`. A pure-`sh` double-fork reparents the job to init (escaping pm2's PPID-based TreeKill — `detached:true` alone doesn't, since it only changes the process group); the server tails on-disk log files for `stdout`/`stderr`/`close`. Used by loraTraining + videoGen. Also exports `reattachDetached(controlDir)` / `isReattachable(controlDir)` to RE-ATTACH a survivor after a restart (boot re-attach, #1332) and `reapDetached` to checkpoint-kill one when re-attach isn't possible. |
| `execGit.js` | `execGit` utility imported by `git.js` + worktree manager. |
| `ffmpeg.js` | Shared ffmpeg helpers (videoGen + videoTimeline). |
| `gitArgs.js` | `PROTECTED_BRANCHES`, `validateFilePaths(files)` — pure command-arg builders/validators for `git.js` (reject injection/traversal in staged paths). |
| `gitForge.js` | `parseGitRemote`, `parseGitHubOwnerFromRemote`, `pickGhAccountForOwner`, `detectForgeCli`, `parsePullRequestUrl` — pure GitHub/GitLab remote + PR/MR URL parsers and forge/account selectors used by `git.js`. |
| `gitOutputParsers.js` | `parseStatus`, `parseDiffStat`, `parseBranchVerboseLine`, `parseSubmoduleStatusLine`/`SUBMODULE_STATUS_RE`, `extractAgentSummary` — pure parsers turning git command output into structured data for `git.js`. |
| `gitRemote.js` | `getOriginInfo`, `parseGitRemoteUrl`, `UPSTREAM_OWNER`/`UPSTREAM_REPO` — classifies the local `origin` remote vs the upstream atomantic/PortOS repo. Used by the update flow to detect forks. |
| `killWithEscalation.js` | `killWithEscalation(proc, {label, stillRunning, delayMs=8000})` — shared SIGTERM→grace→SIGKILL cancel-escalation for spawn-based media jobs. Sends SIGTERM, then escalates to SIGKILL after `delayMs` only when `stillRunning()` holds and the child hasn't exited (`exitCode===null && signalCode===null`). The timer is unref'd and the callback is try/catch-wrapped (runs outside the request lifecycle). Converges musicVideo/render, videoTimeline, imageGen local+codex, videoGen, loraTraining, and the yt-dlp track import cancel paths. |
| `processEnv.js` | `stripDebugMallocEnv(env)` — drop macOS `Malloc*` debug env vars before spawning a child. Pinokio-launched PortOS exports `MallocStackLogging`/`MallocScribble`/etc. that flood Python subprocess stderr with `can't turn off malloc stack logging` lines; route every Node→Python spawn through this. No-op on Linux/Windows. |
| `pythonSetup.js` | Python venv / runner setup helpers. |
| `ytdlp.js` | `findYtDlp()` — cached discovery of the `yt-dlp` binary on PATH, mirrors `findFfmpeg()` in `ffmpeg.js`. Used by the track YouTube-import job. |

## Networking

| Module | Purpose |
|---|---|
| `httpClient.js` | Fetch-based HTTP client factory (axios.create replacement). |
| `abortTimeout.js` | `withAbortTimeout(timeoutMs, fn)` — runs `fn(signal)` under an `AbortController` that aborts after `timeoutMs` and always clears the timer on settle. Generic lifecycle helper for callers that need the insecure-agent `peerFetch` (so can't use `fetchWithTimeout`) or one signal across parallel fetches. |
| `fetchWithTimeout.js` | `fetch` wrapper with AbortController timeout. |
| `safeUrlFetch.js` | SSRF-guarded public-URL fetch: `isPublicHttpUrlSafe`/`assertPublicHttpUrl` (scheme + blocked-host-literal via `catalogValidation.isBlockedIngestHost` + DNS-resolve), plus `fetchPublicText`/`fetchPublicBinary` (timeout, redirect revalidation, size cap). Reuse instead of copying the SSRF guard for any "fetch this remote thing the user pointed us at" flow. |
| `pinterestFeed.js` | Pure Pinterest board RSS helpers: `normalizePinterestFeedUrl(input)` (board URL or `.rss` → `{ feedUrl, boardUrl }`, host-gated) + `parsePinterestRss(xml)` (per-pin `pinUrl`/`imageUrl`/title/description, 736x size upgrade). Feeds the mood-board Pinterest importer. |
| `requestAbort.js` | `abortSignalFromResponse(res)` — AbortSignal that fires only when an Express client disconnects *before the response finishes* (keyed off `res` close + `writableEnded`). Plus `anyAbortSignal(signals)` — combine several signals into one (native `AbortSignal.any` with a Node-18 fallback). |
| `readResponseJson.js` | Read a `Response` body as JSON, tolerating a non-JSON/HTML error page (no `Unexpected token <` crash). Object callers need no opts; pass `{ fallback, emptyValue }` for arrays or to surface the raw error text. |
| `peerHttpClient.js` | Federation HTTP/Socket.IO client (TLS validation off — Tailnet is the trust boundary). |
| `peerSelfHost.js` | Tailscale-issued hostname this PortOS sends in federation. |
| `peerUrl.js` | Build the base URL for a peer. |
| `sharingOrigin.js` | Origin metadata for records imported from share buckets. |
| `syncIntegrity.js` | Pure diff of local vs remote manifest lists. `INTEGRITY_STATUS` constants + `computeRecordIntegrity(localList, remoteList)` — classifies each record as `in-parity`, `local-only`, `peer-only`, `diverged`, or `assets-missing`. No I/O. |
| `syncWire.js` | Single source of truth for what fields cross the federated-peer wire (snapshot loop + per-record push agree). |
| `tailscale.js` | Locate the Tailscale CLI binary, flag the sandboxed macOS App-bundle build (which can't write `tailscale cert` output outside its container), and read backend state (`getTailscaleStatus` / `isTailscaleUp`) to know whether we're actually connected to the tailnet. |
| `httpsState.js` | Captures whether PortOS booted with HTTPS active. |
| `networkExposure.js` | Snapshot of scheme + bind + cert mode for the dashboard's Network Exposure widget. |

## Search & indexing

| Module | Purpose |
|---|---|
| `bm25.js` | BM25 ranking + inverted-index helpers. |
| `vectorMath.js` | Vector math utilities (cosine, etc.). |
| `memoryQuery.js` | Pure memory-index helpers: meta projection, filter/sort, search/hybrid meta filters, RRF fusion. |
| `memoryStats.js` | macOS-correct memory accounting (handles "Pages free" quirk). |
| `rrfRanking.js` | Pure `reciprocalRankFusion(textResults, vectorResults, options)` — merges two ranked lists via RRF scoring (Cormack 2009). Used by `catalogDB.hybridSearchIngredients`. |

## Extraction & parsing

| Module | Purpose |
|---|---|
| `jsonExtract.js` | Pull JSON blocks out of LLM responses. |
| `taskParser.js` | Parse `TASKS.md` format. |
| `xmlEntities.js` | Shared dependency-free XML/HTML entity decoder. `decodeXmlEntities(str, extraEntities?)` — single-pass (double-decode-safe) decode of the five predefined named entities + decimal/hex numeric refs, with an optional caller-supplied extra-entity map (e.g. `{ nbsp: ' ', zwnj: '' }`). Unknown/out-of-range refs left untouched. Used by the Apple Health XML parser, Claude changelog feed, Pinterest RSS, generic feeds, and Gmail HTML-to-text. |

## Curated static data

| Module | Purpose |
|---|---|
| `curatedGenomeMarkers.js` | SNP classification logic (`classifyGenotype`, `formatGenotype`, `resolveApoeHaplotype`) + `MARKER_CATEGORIES`; loads the ~116-marker dataset from the co-located `curatedGenomeMarkers.json` at module init. |
| `songCraftRef.js` | Server-side mirror of the a cappella rhythm-shape + voice-layer vocabulary (`RHYTHM_SHAPES`, `VOICE_LAYERS`, `DIRGE_RHYTHM_SHAPES`) injected into the song generate/evaluate prompts so the model returns ids the editor pickers understand. Mirrors `client/src/lib/songCraft.js`. |

## Domain utilities

| Module | Purpose |
|---|---|
| `appResolver.js` | Fuzzy-match a spoken/typed phrase to a managed app (`{ id, name }`). Tiered exact → prefix → substring, used by voice tools that target a specific app. |
| `capabilityMap.js` | Pure row builders for the Capability Map (per-integration status tiers + rollup); fed by `routes/capabilities.js`. |
| `civitai.js` | Civitai URL parsing + API client. |
| `huggingfaceLora.js` | HuggingFace LoRA import helpers: parse HF ref → `{repo,revision}`, fetch `/api/models` metadata, pick the `.safetensors`, detect the video-LoRA family (`ltx-video`), build the sidecar + `resolve` download URL. The HF analogue of `civitai.js` for video LoRAs. Pure. |
| `huggingfaceModel.js` | HuggingFace base-model (image/video) classifier for the self-service "add a model" flow (#2124): inspect repo siblings + card → decide the loadable runtime/runner, STRICTLY refuse GGUF-only / wan / hunyuan / unclassifiable repos (so a bad add can't wedge the picker), build the `media-models.json` entry (`source:'user'`), + a `searchHuggingfaceModels` Hub-search helper. Pure. |
| `localLlmCatalog.js` | Curated cross-backend (Ollama↔LM Studio) local-LLM catalog + install-id mapping for the migrate flow. Pure. |
| `localLlmDisk.js` | Pure on-disk reasoning for the migrate "copy GGUF locally instead of re-downloading" fast-path (Ollama manifest/blob parsing, LM Studio path layout, MLX/projector/shard detection). |
| `localModelHeuristics.js` | Capability heuristics for untyped local (Ollama/LM Studio) models. `isEmbeddingModel`/`isGenerationModel` (so a generation/fallback run never picks an embedding model like `nomic-embed-text`); `isVisionModel(model)` (string id or model card — prefers explicit `type:'vlm'`/`capabilities:['vision']` metadata, falls back to id regex; used by the LoRA captioner); `recommendEditorialModel(models)` ranks installed models for editorial review/editing. Pure. Mirror `isEmbeddingModel`/`isVisionModel` in `client/src/utils/providers.js`. |
| `loraDataset.js` | Pure helpers for character LoRA training datasets (`data/lora-datasets/`): `sanitizeLoraDataset` (collectionStore sanitizer), `deriveTriggerWord` (name → single-token slug with collision suffix), `prefixCaption` (idempotent trigger-word prefixing), `buildVariationMatrix` (deterministic view/pose/expression/outfit tuples for batch generation), `computeDatasetReadiness` (trainable gate: ≥`MIN_TRAINING_IMAGES` ready+captioned images, plus an advisory `recommended`/`quality` tier via `datasetQualityTier` nudging toward `RECOMMENDED_TRAINING_IMAGES`), `analyzeCaptionInvariants` (flags identity fragments repeated across ≥`INVARIANT_SHARE_THRESHOLD` of captions — those bind to the caption phrases instead of the trigger token, issue #1320) + `stripSharedFragments` (rewrite one caption with those fragments removed, trigger preserved). Prompt building + I/O live in `services/loraDatasetGenerate.js` / `services/loraDatasets.js`. |
| `issueLength.js` | Per-issue size targets fed into text stages. |
| `mediaItemKey.js` | `<kind>:<ref>` key vocabulary for media items. |
| `navManifest.js` | Single source of truth for nav (`⌘K` palette + voice). Add an entry when you add a page. |
| `personaTraitBlend.js` | Digital-twin persona trait-blending (M34 P7). Blends a persona's `traitAdjustments` against the base twin's communication profile + Big-Five into a "Communication Calibration" directive. Mirrored to `client/src/lib/`. |
| `textUtils.js` | Pure server-side prose helpers. `countWords(text)` — canonical whitespace-token count (`\S+`), the single home for what `writersRoom/local.js`, `issueLength.js`, and the client's `formatters.js` used to each re-implement. |
| `pipelineIssueOrder.js` | Pure renumber algorithm for pipeline issues. |
| `postAdaptive.js` | Pure POST adaptive-difficulty policy — nudges a math drill's primary knob (`steps`/`maxDigits`/`maxExponent`/`tolerancePct`) up/down within clamped bounds from recent scored performance. Opt-in via the config Adaptive toggle. |
| `postMultiplicationLadder.js` | Pure progressive multiplication ladder — mastery-gated difficulty rungs (`[1,1]` → `[1,2]` → `[1,1,1]` → …). Resolves the user's current level from per-level speed+accuracy stats so the plain multiplication drill ramps up instead of starting at a fixed hard difficulty. On by default. Built on `postProgression.js`. |
| `postProgression.js` | Generic mastery-gated progression ladder (extracted from `postMultiplicationLadder.js`) — `createProgression({ levels, describeLevel, speedTargetForLevel? })` resolves a user's current rung from per-level stats with an anti-demotion floor. Also defines the cognitive-drill ladders (n-back / digit-span / schulte / mental-rotation / stroop) and their level→generator-config mapping. |
| `postStreak.js` | Pure DST-safe POST practice-streak math — the single `computePostStreaks` implementation shared by scored sessions and the training log, plus `computeUnifiedStreak` (a day is active with EITHER a session or a practice entry). |
| `planIds.js` | Utilities for PLAN.md `[slug]` IDs. |
| `renderSlot.js` | Render-slot helpers for `(proof\|final)Image` per stage. |
| `telegramClient.js` | Telegram bot client. |
| `vaultCrypto.js` | Privacy Center PII Vault field-level encryption (issue #2140). AES-256-GCM `encryptValue`/`decryptValue` (`v1:<iv>:<tag>:<ct>` format, per-value 12-byte IV), `ensureVaultKey()` self-heal (generates `PRIVACY_VAULT_KEY` into the install root's `.env` on first write, replacing any invalid line; never logs the value), key resolution that falls back to reading `.env` so decrypt/status survive a server restart, `isVaultKeyConfigured()`, and the per-type `maskValue(type, plaintext)` display masking (last-4 / domain-visible / street-masked). Plaintext must never be logged by callers. |

## Model & config

| Module | Purpose |
|---|---|
| `browserConfig.js` | Shared custom browser path helpers for deriving macOS app bundles, detecting configured browser choices, normalizing browser config, and validating Chrome-compatible binary paths. |
| `db.js` | PostgreSQL connection pool. |
| `pgTimestamp.js` | `mirrorTimestamp(value, fallback)` — coerce a hand-editable timestamp into a value Postgres TIMESTAMPTZ always accepts (or fall back), guarding boot-time binds against `Date.parse` rollover + out-of-range years. |
| `pgTools.js` | `pg_dump` binary resolution shared by the backup snapshot path and the native↔Docker export path: `resolvePgDumpBinary(serverMajor)` (PORTOS_PGDUMP override → version-aware auto-select → bare `pg_dump`), plus the lower-level `pickPgDump` / `discoverPgDumpCandidates` / `resolvePgDump`. Picks the closest installed `pg_dump` whose major is ≥ the running server's. |
| `ports.js` | Canonical PORTS object (re-exported from `ecosystem.config.cjs`). |
| `platform.js` | Platform/OS detection helpers — listening-port probes plus `isAppleSilicon()` (arm64 darwin; gates MLX model features, detect at the route boundary). |
| `signalCrypto.js` | Pure, dependency-free crypto for reading Signal Desktop's encrypted chat DB (#2154): SQLCipher-4 page decryption (`decryptSqlcipherDatabase`, `deriveSqlcipherKeys`, `sqlcipherPageHmac` — PBKDF2-SHA512 HMAC key + AES-256-CBC per page + HMAC-SHA512 verify → plaintext SQLite buffer the built-in `node:sqlite` can open) and Chromium/Electron `safeStorage` unwrap (`decryptSafeStorageValue`, `deriveSafeStorageKey` — macOS AES-128-CBC + PBKDF2-SHA1 over the keychain password). All functions return `{ ok, ... }` reports (never throw) for graceful degradation. Consumed by `services/signalSync.js`. |
| `timezone.js` | Timezone utilities for scheduling. |
| `tribeCadence.js` | Authoritative, pure Tribe care-cadence rules (single source of truth, mirrored to `client/src/lib/tribeCadence.js`): `cadenceStatus(entity)` → `{ state: external/missing/overdue/soon/steady, daysRemaining, daysOverdue }`, `daysSinceDate(dateStr)`, `DEFAULT_CADENCE_DAYS` (45), `SOON_WINDOW_DAYS` (7). Consumed by `personCadenceStatus` / `getCareSummary` in `services/tribe.js` (proactive alert + Care widget) and by the client Tribe page/map. |
| `tribeMatch.js` | Pure, deterministic matcher mapping a calendar attendee / message counterpart (`{ email, phone, name }`) to a tracked Tribe person for auto-logged touchpoints (#2033, #2151): `buildPersonMatchIndex(people)` → `{ byIdentifier, byPhone, byName }`, `matchPerson(identity, index)` (email/handle authoritative, then E.164 phone, then exact unique name fallback — no fuzzy matching), `matchPeople(identities, index)` → de-duplicated Set of personIds, `normalizeIdentifier(value)`, `normalizePhone(value)` (E.164 normalization for iMessage/Signal handles), `identityFromHandle(handle)` (classify a raw `chat.db` handle into email-or-phone). Consumed by `autoLogTouchpoints` in `services/tribe.js` from the calendar, message, and iMessage sync producers. |
| `viteAllowedHosts.js` | Detect and remediate a managed app's Vite `server.allowedHosts`. `findViteConfig(repoPath)` locates the config; `parseAllowedHosts(src)` / `hostIsAllowed(parsed, host)` decide whether a Tailscale/IP host would be accepted (mirrors Vite's localhost+IP-always-allowed and leading-dot-suffix rules); `rewriteAllowedHosts(src)` deterministically injects `allowedHosts: true` (or bails `ok:false` on ambiguous shapes so the caller can fall back to an LLM fix); `checkViteHost(repoPath, host)` is the one-shot status used by `GET /api/apps/:id/vite-host-check`. |
| `buildId.js` | Build-ID derived from the built client bundle. |

## General utilities

| Module | Purpose |
|---|---|
| `apiRegistry.js` | Single source of truth for which PortOS services are externally-callable HTTP APIs (`voice`, `sdapi`). `API_REGISTRY` declares each API's `publicPrefixes` (read/compute-safe surface only) + defaults; `isRegistryPublic(settings, path)` tells `authGate` when an `exposed && !requireAuth` API re-opens its prefix; `resolveApiAccess(settings)` merges persisted `apiAccess` flags for the Settings UI + OpenAPI docs. |
| `arrayUtils.js` | `shuffle(arr)` — Fisher-Yates shuffle (new array, never mutates). The canonical uniform shuffle — never `arr.sort(() => Math.random() - 0.5)`, which is biased. Shared by `meatspacePostCognitive.js` (Schulte table / mental rotation) and `meatspacePostMemory.js` (memory drill generators). |
| `asyncMutex.js` | Promise-based async mutex. |
| `authGate.js` | Express + Socket.IO middleware that gates `/api/*` and `/data/*` behind the password set in `settings.secrets.auth`. No-op when auth is off; emits 401 `AUTH_REQUIRED` (or plain text for `/data/*`) when on and the request has no valid session token. Consults `apiRegistry.isRegistryPublic` so an exposed+passwordless API (voice/sdapi) bypasses the gate on its public prefix only. |
| `domainAutonomy.js` | Per-domain autonomy guardrails (pure). `AUTONOMY_DOMAINS`/`DOMAIN_IDS`/`DOMAIN_MODES` (`off`/`dry-run`/`execute`), `getDomainMode(config, id)`, and `normalizeDomainAutonomy(raw)` to coerce a hand-edited/partial map. Default per domain is `execute` (reproduces pre-#711 behavior, so no migration needed). Also `CREATIVE_DOMAIN`/`getCreativeAutonomyMode(config)` (#2183) — the Creative Director orchestrator domain, kept out of `DOMAIN_IDS` and defaulting to mirror the `cos` mode. |
| `domainBudgets.js` | Per-domain daily autonomy budgets (pure). `BUDGET_LIMIT_FIELDS` (`maxActionsPerDay`/`maxMinutesPerDay`), `getDomainBudget(config, id)`, `normalizeDomainBudgets(raw)`, `hasBudget(budget)`, and `evaluateBudget(budget, usage)` → `{ withinBudget, exceeded }`. A `null`/non-positive cap means unlimited (default per domain, so no migration needed). Token/$ caps are intentionally absent — CLI subscription providers expose no per-run metering. Usage ledger + gate wiring live in `services/domainUsage.js`. |
| `errorHandler.js` | `ServerError` + `asyncHandler` middleware. |
| `lwwTimestamp.js` | Last-writer-wins timestamp comparison for cross-instance sync merges. `parseTsMs(s)` (Date.parse → epoch ms or null), `compareNewerWins(candidate, incumbent)` (true iff candidate strictly newer; unparseable-loses, tie → incumbent — used to decide remote-overwrites-local), `compareEarlierWins(a, b)` (−1/0/1 earliest-wins tiebreak; unparseable-loses). Single source of the LWW polarity shared by `mergeMediaCollectionsFromSync` / `mergeAuthorsFromSync` etc. |
| `mapWithConcurrency.js` | Generic bounded-concurrency async mapper that preserves input order while capping in-flight work. |
| `markedSection.js` | Marker-delimited section replacement (pure). `buildMarkers(id)` → `{ start, end }` HTML-comment marker pair; `replaceMarkedSection(content, body, markers)` splices/replaces/removes an auto-generated region without touching surrounding user content (idempotent); `extractMarkedSection` / `hasMarkedSection` read it back. Powers the daily-log activity-digest auto-drafts (#2155) via `brainJournal.upsertAutoSection()`. |
| `objects.js` | Object utilities — `deepMerge` (recursive merge w/ array replacement), `isPlainObject` (non-null, non-array `object` guard for JSON / LLM payloads), `POLLUTING_KEYS` (shared `__proto__`/`constructor`/`prototype` denylist for sanitizers), `canonicalStringify` (recursive sorted-key JSON serialization for cross-machine content hashing), `isEmptyScalar` (true for null/undefined/whitespace-string/empty-array — merge gap-fill gate). |
| `openapiSpec.js` | `buildOpenApiSpec(settings, { baseUrl, version })` — builds an OpenAPI 3.1 document for the currently-exposed public APIs from `apiRegistry`, reusing route Zod schemas via `z.toJSONSchema`. Exposed+`requireAuth` operations get a `security` requirement; passwordless ones don't. Served by `routes/apiDocs.js`. |
| `shellQuote.js` | `shellQuote(value)` — POSIX single-quote escaping for values interpolated into shell command strings (display command lines, copy-paste blocks in agent prompts). Bare-safe tokens pass through; everything else is single-quoted. Canonical escaper — don't hand-roll. |
| `sidecarProcess.js` | `runSidecarProcess({bin,args,env,signal,onStage,onProcess})` + `parseSidecarResult(stdout)` — the shared Python-sidecar STAGE:/RESULT: wire-protocol runner (spawn, tail-capped stdout/stderr, per-STAGE-line callback, abort/SIGTERM → `canceled`, non-zero exit → stderr-tail reason). Used by `pipeline/musicGen.js` (all music backends) and `audioMidiTranscription.js` (MuScriptor). |
| `singleFlight.js` | `createSingleFlight()` → `run(key, fn)` — keyed in-flight coalescer: concurrent calls for the same key share one `fn()` execution and result; the slot auto-clears on settle. Minimal by design (no TTL/result cache layered on top, doesn't reject concurrent callers). Used by `promptRunner.js`'s fallback mark-and-pick. |
| `sseUtils.js` | Per-job SSE stream helpers (imageGen + others) plus `createSseRunner` — the shared batch-runner lifecycle (runs map, terminal-frame replay, cancel, fire-and-forget coordinator) used by the pipeline completeness/analysis/checks runners. |
| `streamBackpressure.js` | `awaitWritableDrain(res)` — park a streaming-response producer on the socket's next `drain` (or `close`) when `res.write()` returned false, so SSE/NDJSON writes stay bounded for a slow reader. Shared by `routes/ask.js` (SSE) and `routes/localLlm.js` (NDJSON). |
| `uuid.js` | `v4()` thin wrapper over `crypto.randomUUID()`. |
| `versionUtils.js` | `compareSemver(a, b)` — semver ordering (-1/0/1) with pre-release precedence and build-metadata stripping. Shared by the self-update checker (`updateChecker.js`) and the local-LLM Ollama update detector (`localLlm.js`). Inputs must be `v`-stripped. |
| `workTracker.js` | `WORK_TRACKERS`/`CONCRETE_WORK_TRACKERS`/`DEFAULT_WORK_TRACKER`, `workTrackerLabel`, `hostToWorkTracker`, `forgeCliForTracker`, `trackerToClaimTaskType`, `hostFromOriginUrl` (subgroup-tolerant host parse), pure `resolveWorkTracker({configured,host})`, async `resolveAppWorkTracker(app)` — resolves a managed app's autonomous work source (PLAN.md / GitHub / GitLab / JIRA), defaulting `'auto'` to the git origin host. Consumed by the `claim-work` router in `cosTaskGenerator.js` and `routes/apps.js`. |
| `workspaceRoots.js` | Shared allow-list for routes that take a caller-supplied filesystem path. `ALLOWED_WORKSPACE_ROOTS` (defaults + `PORTOS_WORKSPACE_ROOTS`, symlink-resolved), `isWithinRoot(resolvedPath, root)` (separator-safe containment), `isWithinAllowedRoots(realPath)`, and `WORKSPACE_ROOTS_CONFIGURED` (true when the operator set the env var — lets a permissive-by-default route like `routes/detect.js` opt into confinement). Used by `routes/commands.js` (always scoped) and `routes/detect.js` (scoped only when configured). |
| `zodCompat.js` | Zod 4 compatibility helpers. `partialWithoutDefaults(objectSchema)` — like `.partial()` but strips inner field defaults first, so a PATCH/update schema doesn't inject (and clobber) the stored values of fields the caller didn't send. Use for any update schema derived from a defaulted base. |

## Test support

| Module | Purpose |
|---|---|
| `mockPathsDataRoot.js` | Shared Vitest helpers for `PATHS.data → temp dir` and no-peer record creation guards. |
| `settingsTestUtil.js` | `bindSettingsFile(dataRoot)` → `writeSettingsFile`/`mergeSettingsFile`: direct settings.json disk writes that also drop the `getSettings()` read cache (dynamic-import reset) so a stale cache can't survive a bypass-`save()` write. |
| `testHelper.js` | Test helpers: `request()` (supertest-style HTTP) + `mockJsonResponse`/`mockTextResponse` (fetch `Response` mocks read via `.text()`). |
