// Barrel for server/lib/ — discovery surface, not a forced import path.
//
// Existing deep imports (e.g. `import { x } from '../lib/fileUtils.js'`)
// continue to work; this barrel exists so new code (and grep-driven
// discovery) can find every shared helper from one place. See
// `server/lib/README.md` for the human-readable catalog.
//
// MAINTENANCE RULE: any new module added to server/lib/ MUST be re-exported
// here AND get a one-line entry in README.md. The same rule applies to
// client/src/lib/, client/src/hooks/, and client/src/services/. See
// CLAUDE.md "Module organization" for the full convention.

// === Validation (Zod schemas + validators) ===
// Domain-prefixed validators are namespace-exported so generic names that
// collide across domains (e.g. `settingsUpdateInputSchema` exists in both
// brain and digital-twin) can be disambiguated as `brainValidation.X` /
// `digitalTwinValidation.X`. The catch-all `validation.js` stays flat — its
// names are the canonical PortOS-wide schemas.
export * as agentValidation from './agentValidation.js';
export * as appleHealthValidation from './appleHealthValidation.js';
export * as brainValidation from './brainValidation.js';
export * as catalogValidation from './catalogValidation.js';
export * as cosValidation from './cosValidation.js';
export * as creativeDirectorValidation from './creativeDirectorValidation.js';
export * as digitalTwinValidation from './digitalTwinValidation.js';
export * as genomeValidation from './genomeValidation.js';
export * as identityValidation from './identityValidation.js';
export * as meatspaceValidation from './meatspaceValidation.js';
export * as mediaValidation from './mediaValidation.js';
export * as memoryValidation from './memoryValidation.js';
export * as moodBoardValidation from './moodBoardValidation.js';
export * as musicVideoValidation from './musicVideoValidation.js';
export * as notesValidation from './notesValidation.js';
export * as peerSyncValidation from './peerSyncValidation.js';
export * as pipelineValidation from './pipelineValidation.js';
export * as postValidation from './postValidation.js';
export * as socketValidation from './socketValidation.js';
export * as storyBuilderValidation from './storyBuilderValidation.js';
export * as telegramValidation from './telegramValidation.js';
export * from './validation.js';

// === Story & narrative ===
export * from './bibleExtractor.js';
export * as catalogBulkParsers from './catalogBulkParsers.js';
export * from './catalogChunking.js';
export * from './catalogTypes.js';
export * as catalogUniverseTags from './catalogUniverseTags.js';
export * from './canonPrompt.js';
export * from './comicScriptParser.js';
export * from './composeStyledPrompt.js';
export * from './creativeDirectorPresets.js';
export * from './creativeDirectorPrompts.js';
// Namespaced: the editorial-check registry (#1284) lives in the editorial/
// subdir with its own barrel — surface it under `editorial.*` so the root
// discovery surface reaches EDITORIAL_CHECKS + the lookup helpers.
export * as editorial from './editorial/index.js';
export * from './sceneExtractor.js';
export * from './scenePrompt.js';
export * from './shotGrammar.js';
export * from './seasonStructure.js';
export * from './seriesCharacterArc.js';
export * from './seriesLlmOverride.js';
export * from './storyArc.js';
export * from './styleGuide.js';
export * from './storyBuilderIntegrity.js';
export * from './storyBuilderSteps.js';
// `storyBible.js` re-exports `normalizeSlugline` from `scenePrompt.js` for
// back-compat — namespace it so the canonical scenePrompt export wins flat.
export * as storyBible from './storyBible.js';
export * from './universePromptRenderers.js';
export * from './writersRoomPresets.js';
export * from './writersRoomStylePresets.js';

// === Prompt & AI (toolkit lives in aiToolkit/ — see its own index.js) ===
export * from './aiProvider.js';
export * from './aiToolkitState.js';
export * from './ansiStrip.js';
// Namespaced: antigravity.js and providerModels.js both export
// ANTIGRAVITY_CONFIGURED_DEFAULT, so a flat `export *` would trip the
// barrel's duplicate-identifier collision check.
export * as antigravity from './antigravity.js';
export * from './cliProviderArgs.js';
export * from './cliProviderRun.js';
export * from './codexAssistantExtract.js';
export * from './codexCliOutput.js';
export * from './contextBudget.js';
export * from './hfToken.js';
export * from './hfErrors.js';
export * from './hfCache.js';
export * from './hfDownload.js';
export * from './sseDownload.js';
export * from './mediaModels.js';
export * from './promptPartials.js';
export * from './promptRunner.js';
export * from './promptTemplate.js';
export * from './providerModels.js';
// `runners.js` re-defines `isFlux2`/`isZImage`/`isErnie` that also live in
// mediaModels.js — namespace it so the barrel surface is unambiguous.
export * as runners from './runners.js';
// `stageRunner.js` defines its own `extractJson` distinct from `jsonExtract.js`.
export * as stageRunner from './stageRunner.js';
export * from './tuiHandshake.js';
export * from './tuiPromptRunner.js';

// === File & I/O ===
export * from './collectionStore.js';
export * from './conflictJournal.js';
export * from './createKeyCachedQueue.js';
export * from './createNewestWinsGuard.js';
export * from './fileUtils.js';
export * from './fileWriteQueue.js';
export * from './schemaVersions.js';
export * from './imageClean.js';
export * from './imageWatermark.js';
export * from './localImageFilename.js';
export * from './multipart.js';
export * from './safetensors.js';
export * from './assetHash.js';
export * from './pdfImageEmbed.js';
export * from './zipStream.js';
export * from './zipWriter.js';

// === Process execution ===
export * from './agentGuard/index.js';
export * from './bashResolver.js';
export * from './bufferedSpawn.js';
export * from './commandSecurity.js';
export * from './detachedSpawn.js';
export * from './execGit.js';
export * from './ffmpeg.js';
export * from './gitArgs.js';
export * from './gitForge.js';
export * from './gitOutputParsers.js';
export * from './gitRemote.js';
export * from './openFolder.js';
export * from './processEnv.js';
export * from './pythonSetup.js';

// === Networking ===
export * from './abortTimeout.js';
export * from './fetchWithTimeout.js';
export * from './requestAbort.js';
export * from './httpClient.js';
export * from './httpsState.js';
export * from './networkExposure.js';
export * from './peerHttpClient.js';
export * from './peerSelfHost.js';
export * from './peerUrl.js';
export * from './pinterestFeed.js';
export * from './readResponseJson.js';
export * from './safeUrlFetch.js';
export * from './sharingOrigin.js';
export * from './syncIntegrity.js';
export * from './syncWire.js';
export * from './tailscale.js';

// === Search & indexing ===
export * from './bm25.js';
export * from './memoryQuery.js';
export * from './memoryStats.js';
export * from './rrfRanking.js';
export * from './vectorMath.js';

// === Extraction & parsing ===
export * from './jsonExtract.js';
export * from './taskParser.js';

// === Curated static data ===
export * from './curatedGenomeMarkers.js';
export * from './songCraftRef.js';

// === Domain utilities ===
export * from './appResolver.js';
export * from './capabilityMap.js';
export * from './civitai.js';
export * from './huggingfaceLora.js';
export * from './localLlmCatalog.js';
export * from './localLlmDisk.js';
export * from './localModelHeuristics.js';
export * from './loraDataset.js';
export * from './issueLength.js';
export * from './mediaItemKey.js';
export * from './navManifest.js';
export * from './personaTraitBlend.js';
export * from './pipelineIssueOrder.js';
export * from './planIds.js';
export * from './renderSlot.js';
export * from './telegramClient.js';

// === Model & config ===
export * from './browserConfig.js';
export * from './buildId.js';
export * from './db.js';
export * from './pgTimestamp.js';
export * from './pgTools.js';
export * from './platform.js';
export * from './ports.js';
export * from './timezone.js';
export * from './viteAllowedHosts.js';

// === General utilities ===
export * from './apiRegistry.js';
export * from './asyncMutex.js';
export * from './authGate.js';
export * from './domainAutonomy.js';
export * from './domainBudgets.js';
export * from './errorHandler.js';
export * from './lwwTimestamp.js';
export * from './mapWithConcurrency.js';
export * from './objects.js';
export * from './openapiSpec.js';
export * from './shellQuote.js';
export * from './singleFlight.js';
export * from './streamBackpressure.js';
export * from './sseUtils.js';
export * from './uuid.js';
export * from './versionUtils.js';
export * from './workTracker.js';
export * from './workspaceRoots.js';
export * from './zodCompat.js';

// === Test support (consumed by *.test.js files) ===
export * from './mockPathsDataRoot.js';
export * from './testHelper.js';
