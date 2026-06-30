// Barrel for client/src/lib/ — discovery surface, not a forced import path.
// See client/src/lib/README.md for the human-readable catalog and
// CLAUDE.md "Module organization" for the maintenance convention.

// === Prompt & rendering (mirror server/lib/ — keep byte-for-byte in sync) ===
export * from './canonPrompt.js';
export * from './cleanPlatePrompt.js';
export * from './composeStyledPrompt.js';
export * from './personaTraitBlend.js';
export * from './scenePrompt.js';
export * from './seasonStructure.js';
export * from './sheetPointers.js';
export * from './shotContinuity.js';
export * from './shotGrammar.js';
export * from './universeRunTag.js';
export * from './universeStylePreset.js';

// === Pipeline / image-gen defaults ===
export * from './beatColors.js';
export * from './beatGrid.js';
export * from './bibleLimits.js';
export * from './catalogTypes.js';
export * from './editorialRoadmap.js';
export * from './imageCleaners.js';
export * from './imageGenBackends.js';
export * from './imageGenDefaults.js';
export * from './imageGenResolutions.js';
export * from './importerDeepLink.js';
export * from './letteringDensity.js';
export * from './issueLength.js';
export * from './pipelineImageDefaults.js';
export * from './reverseOutlineGrid.js';
export * from './runnerFamilies.js';
export * from './videoGenResolutions.js';
export * from './videoTilingOptions.js';
export * from './wrImageDefaults.js';

// === Graph & sim ===
export * from './brainGraphFocus.js';
export * from './graphSimulation.js';

// === Generic UI / collection utilities ===
export * from './applyManuscriptEdits.js';
export * from './audioRecorder.js';
export * from './boundedMap.js';
export * from './clientErrorReporter.js';
export * from './clinicianReport.js';
export * from './clipboard.js';
export * from './compareHelpers.js';
export * from './consoleFilters.js';
export * from './diffLines.js';
export * from './diffWords.js';
export * from './downloadBlob.js';
export * from './genUtils.js';
export * from './healthProvenance.js';
export * from './joinInfluenceList.js';
export * from './kanbanColumns.js';
export * from './localLlmTargetKey.js';
export * from './loopbackHost.js';
export * from './manuscriptAnchors.js';
export * from './manuscriptFormat.js';
export * from './mediaNavigation.js';
export * from './mediaSearch.js';
export * from './moodBoardItemSrc.js';
export * from './sameJsonShape.js';
export * from './unsorted.js';
export * from './upsertByIdPrepend.js';
export * from './voiceLabel.js';

// === Page-scoped pure helpers ===
export * from './cityPlaybackFrame.js';
export * from './colorMatch.js';
export * from './editorialChecks.js';
export * from './editorialHealth.js';
export * from './lossSparkline.js';
export * from './metronome.js';
export * from './pianoKeyboard.js';
export * from './pitchDetect.js';
export * from './scoreNotation.js';
export * from './scorePlayback.js';
export * from './singToScore.js';
export * from './songCraft.js';
export * from './songPlayback.js';
export * from './songProgress.js';
export * from './syncCounts.js';
export * from './terminalTheme.js';
export * from './tribe.js';
export * from './universeBuilderExpand.js';
export * from './wrSceneCursor.js';
export * from './writingGuide.js';
