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
// AGENTS.md "Module organization" for the full convention.

// === Validation (Zod schemas + validators) ===
// Domain-prefixed validators are namespace-exported so generic names that
// collide across domains (e.g. `settingsUpdateInputSchema` exists in both
// brain and digital-twin) can be disambiguated as `brainValidation.X` /
// `digitalTwinValidation.X`. The catch-all `validation.js` stays flat — its
// names are the canonical PortOS-wide schemas.
export * from './appDeployFlags.js';
export * from './apiContractSchemas.js';
export * from './asyncApiSpec.js';
export * as agentValidation from './agentValidation.js';
export * as agentContextValidation from './agentContextValidation.js';
export * as appleHealthValidation from './appleHealthValidation.js';
export * as brainValidation from './brainValidation.js';
export * as catalogValidation from './catalogValidation.js';
export * as cosValidation from './cosValidation.js';
export * from './cosToolContracts.js';
export * as creativeCommissionValidation from './creativeCommissionValidation.js';
export * as creativeDirectorValidation from './creativeDirectorValidation.js';
export * as digitalTwinValidation from './digitalTwinValidation.js';
export * as fableLoomValidation from './fableLoomValidation.js';
export * as genomeValidation from './genomeValidation.js';
export * as identityValidation from './identityValidation.js';
export * as meatspaceValidation from './meatspaceValidation.js';
export * as mediaValidation from './mediaValidation.js';
export * as memoryValidation from './memoryValidation.js';
export * as modelPersonalityValidation from './modelPersonalityValidation.js';
export * as moodBoardValidation from './moodBoardValidation.js';
export * as musicVideoValidation from './musicVideoValidation.js';
export * as notesValidation from './notesValidation.js';
export * as peerSyncValidation from './peerSyncValidation.js';
export * as pipelineValidation from './pipelineValidation.js';
export * as postLlmContracts from './postLlmContracts.js';
export * as postRhetoric from './postRhetoric.js';
export * as postValidation from './postValidation.js';
export * as privacyValidation from './privacyValidation.js';
export * as roundsValidation from './roundsValidation.js';
export * as socketValidation from './socketValidation.js';
export * from './socketEventContracts.js';
export * as spriteValidation from './spriteValidation.js';
export * as storyBuilderValidation from './storyBuilderValidation.js';
export * as telegramValidation from './telegramValidation.js';
export * from './validation.js';
// Cross-domain Zod fragments both `validation.js` and the per-domain files
// import (leaf module, no cycle). Flat because `validation.js` re-exports the
// same objects — same identity, so the collision detector is satisfied.
export * from './sharedSchemas.js';
export * from './threejsModel.js';
export * from './threejsModelAnimation.js';
export * from './threejsModelCoverage.js';
export * from './threejsModelEnvironment.js';
export * from './threejsModelFamilies.js';
export * from './threejsModelPenetration.js';
export * from './threejsModelPhysicalAudit.js';
export * from './threejsModelPlayerSource.js';
export * from './threejsModelRig.js';

// === Story & narrative ===
export * as catalogBulkParsers from './catalogBulkParsers.js';
export * from './catalogChunking.js';
export * from './catalogTypes.js';
export * as catalogUniverseTags from './catalogUniverseTags.js';
export * from './canonPrompt.js';
export * from './comicScriptParser.js';
export * from './composeStyledPrompt.js';
export * from './creativeDirectorPresets.js';
export * from './creativeLatitude.js';
// Namespaced: the editorial-check registry (#1284) lives in the editorial/
// subdir with its own barrel — surface it under `editorial.*` so the root
// discovery surface reaches EDITORIAL_CHECKS + the lookup helpers.
export * as editorial from './editorial/index.js';
export * from './fableLoomGraph.js';
export * from './fableLoomCameraMovements.js';
export * from './fableLoomPlayback.js';
export * from './fableLoomParticipation.js';
export * from './fableLoomLimits.js';
export * from './fableLoomFormats.js';
export * from './fableLoomProduction.js';
export * from './fableLoomContinuity.js';
export * from './scenePrompt.js';
export * from './proseExportSettings.js';
export * from './shotGrammar.js';
export * from './storyboardScenes.js';
export * from './seasonStructure.js';
export * from './seriesCharacterArc.js';
export * from './llmRoutePin.js';
export * from './seriesLlmOverride.js';
export * from './storyArc.js';
export * from './styleGuide.js';
export * from './storyBuilderIntegrity.js';
export * from './storyBuilderSteps.js';
export * from './streamLines.js';
export * from './taskDataInputCatalog.js';
// `storyBible.js` re-exports `normalizeSlugline` from `scenePrompt.js` for
// back-compat — namespace it so the canonical scenePrompt export wins flat.
export * as storyBible from './storyBible.js';
export * from './universeBibleCompleteness.js';
export * from './universeMarkdown.js';
export * from './universePromptRenderers.js';
export * from './writersRoomPresets.js';
export * from './writersRoomStylePresets.js';

// === Prompt & AI (toolkit lives in aiToolkit/ — see its own index.js) ===
export * from './llmText.js';
export * from './aiToolkitState.js';
export * from './ansiStrip.js';
// Namespaced: antigravity.js and providerModels.js both export
// ANTIGRAVITY_CONFIGURED_DEFAULT, so a flat `export *` would trip the
// barrel's duplicate-identifier collision check.
export * as antigravity from './antigravity.js';
export * as childProcess from './childProcess.js';
export * from './cliChildEnv.js';
export * from './cliProviderArgs.js';
export * from './cliProviderRun.js';
export * from './codex.js';
export * from './codexAssistantExtract.js';
export * from './codexCliOutput.js';
export * from './contextBudget.js';
export * from './cursor.js';
export * from './grok.js';
export * from './grokVideoClip.js';
export * from './heavyJobClaim.js';
export * from './hfErrors.js';
export * from './hfCache.js';
export * from './icLoraWeights.js';
export * from './sseDownload.js';
export * from './sseHeaders.js';
export * from './installLogger.js';
export * from './kimi.js';
export * from './mediaModelBuckets.js';
export * from './mediaModels.js';
export * from './videoContinuity.js';
export * from './videoDisclosure.js';
export * from './videoFinishProfiles.js';
export * from './videoSpeedProfiles.js';
export * from './videoModeProfiles.js';
export * from './videoReferenceModes.js';
export * from './videoTextEncoders.js';
export * from './promptPartials.js';
export * from './promptSystemStages.js';
export * from './promptTemplate.js';
export * from './providerCooldown.js';
export * from './providerModels.js';
export * from './providerPrerequisites.js';
// Namespaced: providerVendors.js re-exports `inferTuiCommand` /
// `applyCommandDefaults` (from tuiHandshake.js) and `prepareCliPrompt` (from
// cliProviderArgs.js), which would trip the barrel's duplicate-identifier
// collision check as flat exports.
export * as providerVendors from './providerVendors.js';
export * from './providerTranscriptUsage.js';
export * from './quotaBurnConfig.js';
export * from './quotaBurnPresets.js';
export * from './auditCatalog.js';
export * from './quotaBurnValidation.js';
export * from './quotaReset.js';
export * from './quotaWindows.js';
export * from './recurrenceValidation.js';
export * from './opencodeConfig.js';
export * from './localProviderRuntime.js';
export * from './mtplxModels.js';
export * from './managedDaemon.js';
export * from './vllmQwenProject.js';
export * from './qwenAgentParsers.js';
export * from './vllmQwenProvision.js';
export * from './sglangQwenProject.js';
export * from './sglangQwenRecipe.js';
export * from './openAiModelsProbe.js';
export * from './openAiChatStream.js';
// `runners.js` re-defines `isFlux2`/`isZImage`/`isErnie` that also live in
// mediaModels.js — namespace it so the barrel surface is unambiguous.
export * as runners from './runners.js';
export * from './stagePinPolicy.js';
export * from './tuiHandshake.js';
export * from './tuiShellLaunch.js';
export * from './tuiUsageScrape.js';

// === File & I/O ===
export * from './borderKey.js';
export * from './boundedStateMap.js';
export * from './collectionStore.js';
export * from './conflictJournal.js';
export * from './createKeyCachedQueue.js';
export * from './createNewestWinsGuard.js';
export * from './dataRoot.js';
export * from './agentInstructionsFile.js';
export * from './fileCore.js';
export * as fileUtils from './fileUtils.js';
export * from './fileWriteQueue.js';
export * from './homePath.js';
export * from './jsonIo.js';
export * from './mimeTypes.js';
export * from './paths.js';
export * from './pathSafety.js';
export * from './uploads.js';
export * from './icloudFile.js';
export * from './spawnCwd.js';
export * from './schemaVersions.js';
export * from './imageClean.js';
export * from './imageFrameStats.js';
export * from './imageRgba.js';
export * from './imageWatermark.js';
export * from './localImageFilename.js';
export * from './pgFileFacade.js';
export * from './multipart.js';
export * from './safetensors.js';
export * from './loraEffect.js';
export * from './assetHash.js';
export * from './pdfImageEmbed.js';
export * from './zipStream.js';
export * from './zipWriter.js';

// === Process execution ===
export * from './agentGuard/index.js';
export * from './agentOutputMarkers.js';
export * from './agentRunEvents.js';
export * from './agentRunReconcile.js';
export * from './persistentMind.js';
export * from './persistentMindCapabilities.js';
export * from './persistentMindTrajectory.js';
export * from './persistentMindProfile.js';
export * from './persistentMindPrompt.js';
export * from './persistentMindPublic.js';
export * from './agentSentinel.js';
export * from './bareUrl.js';
export * from './bashResolver.js';
export * from './branchUpstreamGuard.js';
export * from './bufferedSpawn.js';
export * from './commandExists.js';
export * from './commandSecurity.js';
export * from './detachedSpawn.js';
export * from './setupScriptRunner.js';
export * from './hostShutdown.js';
export * from './execGit.js';
export * from './ffmpeg.js';
export * from './ffmpegRenderGuard.js';
export * from './frameQuality.js';
export * from './gitArgs.js';
export * from './gitCommitProbe.js';
export * from './gitForge.js';
export * from './gitOutputParsers.js';
export * from './gitRemote.js';
export * from './githubRepoUrl.js';
export * from './glabArgs.js';
export * from './goalFeatureMap.js';
export * from './interactiveShellResolver.js';
export * from './killWithEscalation.js';
export * from './openFolder.js';
export * from './processEnv.js';
export * from './primaryCheckoutGuard.js';
export * from './pythonSetup.js';
export * from './vttTranscript.js';
export * from './ytdlp.js';

// === Networking ===
export * from './abortTimeout.js';
export * from './connectivity.js';
export * from './fetchWithTimeout.js';
export * from './federatedMediaRequest.js';
export * from './tailnetPeer.js';
export * from './federatedMediaWire.js';
export * from './requestAbort.js';
export * from './httpClient.js';
export * from './httpsState.js';
export * from './isSafeHref.js';
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
export * from './htmlToText.js';
export * from './jsonExtract.js';
export * from './taskParser.js';
export * from './cosTaskPrompt.js';
export * from './taskPauseHold.js';
export * from './taskBlockCategories.js';
export * from './taskRequeue.js';
export * from './taskRetryHold.js';
export * from './taskTargetBranch.js';
export * from './taxonomyTally.js';
export * from './worktreeOwnership.js';
export * from './xmlEntities.js';

// === Curated static data ===
export * from './curatedGenomeMarkers.js';
export * from './songCraftRef.js';

// === Domain utilities ===
export * from './appIdentity.js';
export * from './appResolver.js';
export * from './capabilityMap.js';
export * from './chiptuneRender.js';
export * from './chiptuneScore.js';
export * from './civitai.js';
export * from './huggingfaceLora.js';
export * from './huggingfaceModel.js';
export * from './localLlmCatalog.js';
export * from './localLlmDisk.js';
export * from './specDecodePresets.js';
export * from './localModelHeuristics.js';
export * from './localModelAssessment.js';
export * from './localModelTuning.js';
export * from './modelCapabilityTests.js';
export * from './opencodeStream.js';
export * from './ollamaContext.js';
export * from './loraDataset.js';
export * from './loraTriggers.js';
export * from './issueLength.js';
export * from './musicDuration.js';
export * from './investigationTasks.js';
export * from './learningVerdict.js';
export * from './mediaItemKey.js';
export * from './migrationMarker.js';
export * from './modelPricing.js';
export * from './navManifest.js';
export * from './instanceFeatureRegistry.js';
export * from './usageRange.js';
export * from './subscriptionSavings.js';
export * from './providerFamilies.js';
export * from './providerGateways.js';
export * from './personaTraitBlend.js';
export * from './pipelineIssueOrder.js';
export * from './postAdaptive.js';
export * from './postAppliedNumeracy.js';
export * from './postMultiplicationLadder.js';
export * from './postPowersLadder.js';
export * from './postProgression.js';
export * from './postRotation.js';
export * from './postStreak.js';
export * from './activeDays.js';
export * from './postTopics.js';
export * from './spacedRepetition.js';
export * from './songPractice.js';
export * from './planIds.js';
export * from './markdownText.js';
export * from './renderSlot.js';
export * from './renderTargets.js';
export * from './generationModes.js';
export * from './spriteVocabulary.js';
export * from './spriteChromaKey.js';
export * from './spriteAnimationTracks.js';
export * from './spriteAnimationTrackStore.js';
export * from './postDrillTypes.js';
export * from './telegramClient.js';
export * from './tempPathGuard.js';
export * from './textUtils.js';
export * from './vaultCrypto.js';

// === Model & config ===
export * from './browserConfig.js';
export * from './buildId.js';
export * from './buildIdentity.js';
export * from './condaEnv.js';
export * from './cudaCapability.js';
export * from './db.js';
export * from './pgTimestamp.js';
export * from './pgTools.js';
export * from './platform.js';
export * from './systemCapabilities.js';
export * from './ports.js';
export * from './signalCrypto.js';
export * from './timezone.js';
export * from './tribeCadence.js';
export * from './tribeMatch.js';
export * from './viteAllowedHosts.js';

// === General utilities ===
export * from './apiAccessPolicy.js';
export * from './apiCatalog.js';
export * from './socketEventCatalog.js';
export * from './apiOperationContracts.js';
export * from './apiRegistry.js';
export * from './arrayUtils.js';
export * from './assetRoutePrefixes.js';
export * from './asyncMutex.js';
export * from './concurrencyGate.js';
export * from './dispatchLabels.js';
export * from './domainAutonomy.js';
export * from './domainBudgets.js';
export * from './errorHandler.js';
export * from './extensionErrors.js';
export * from './fetchErrorChain.js';
export * from './isoWeek.js';
export * from './lwwTimestamp.js';
export * from './mapWithConcurrency.js';
export * from './markedSection.js';
export * from './mirrorParity.js';
export * from './objects.js';
export * from './openapiSpec.js';
export * from './openapiDowngrade.js';
export * from './apiToolResource.js';
export * from './prDisposition.js';
export * from './repoStateExpectations.js';
export * from './shellCd.js';
export * from './shellExit.js';
export * from './shellLivenessProbe.js';
export * from './shellQuote.js';
export * from './shellReadinessProbe.js';
export * from './sidecarProcess.js';
export * from './slashdoCatalog.js';
export * from './slashdoInvocation.js';
export * from './slashdoLoader.js';
export * from './singleFlight.js';
export * from './staleWhileRevalidate.js';
export * from './staticImportGraph.js';
export * from './streamAttachment.js';
export * from './streamBackpressure.js';
export * from './streamingSpawn.js';
export * from './sseUtils.js';
export * from './repoIntakeActions.js';
export * from './tombstones.js';
export * from './uploadLimits.js';
export * from './uuid.js';
export * from './versionUtils.js';
export * from './workTracker.js';
export * from './workspaceRoots.js';
export * from './zodCompat.js';

// === Test support (consumed by *.test.js files) ===
export * from './gitTestRepo.js';
export * from './mockPathsDataRoot.js';
export * from './settingsTestUtil.js';
export * from './testHelper.js';
