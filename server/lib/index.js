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
export * as appleHealthValidation from './appleHealthValidation.js';
export * as brainValidation from './brainValidation.js';
export * as digitalTwinValidation from './digitalTwinValidation.js';
export * as genomeValidation from './genomeValidation.js';
export * as identityValidation from './identityValidation.js';
export * as meatspaceValidation from './meatspaceValidation.js';
export * as memoryValidation from './memoryValidation.js';
export * as notesValidation from './notesValidation.js';
export * as postValidation from './postValidation.js';
export * as socketValidation from './socketValidation.js';
export * as telegramValidation from './telegramValidation.js';
export * from './validation.js';

// === Story & narrative ===
export * from './bibleExtractor.js';
export * from './canonPrompt.js';
export * from './comicScriptParser.js';
export * from './composeStyledPrompt.js';
export * from './creativeDirectorPresets.js';
export * from './creativeDirectorPrompts.js';
export * from './sceneExtractor.js';
export * from './scenePrompt.js';
export * from './seasonStructure.js';
export * from './storyArc.js';
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
export * from './codexAssistantExtract.js';
export * from './codexCliOutput.js';
export * from './hfToken.js';
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
export * from './fileUtils.js';
export * from './fileWriteQueue.js';
export * from './schemaVersions.js';
export * from './imageClean.js';
export * from './multipart.js';
export * from './assetHash.js';
export * from './pdfImageEmbed.js';
export * from './zipStream.js';

// === Process execution ===
export * from './commandSecurity.js';
export * from './execGit.js';
export * from './ffmpeg.js';
export * from './gitRemote.js';
export * from './pythonSetup.js';

// === Networking ===
export * from './fetchWithTimeout.js';
export * from './httpClient.js';
export * from './httpsState.js';
export * from './networkExposure.js';
export * from './peerHttpClient.js';
export * from './peerSelfHost.js';
export * from './peerUrl.js';
export * from './sharingOrigin.js';
export * from './syncIntegrity.js';
export * from './syncWire.js';
export * from './tailscale.js';

// === Search & indexing ===
export * from './bm25.js';
export * from './memoryStats.js';
export * from './vectorMath.js';

// === Extraction & parsing ===
export * from './jsonExtract.js';
export * from './taskParser.js';

// === Curated static data ===
export * from './curatedGenomeMarkers.js';

// === Domain utilities ===
export * from './capabilityMap.js';
export * from './civitai.js';
export * from './issueLength.js';
export * from './mediaItemKey.js';
export * from './navManifest.js';
export * from './pipelineIssueOrder.js';
export * from './planIds.js';
export * from './renderSlot.js';
export * from './telegramClient.js';

// === Model & config ===
export * from './buildId.js';
export * from './db.js';
export * from './platform.js';
export * from './ports.js';
export * from './timezone.js';

// === General utilities ===
export * from './asyncMutex.js';
export * from './errorHandler.js';
export * from './objects.js';
export * from './sseUtils.js';
export * from './uuid.js';

// === Test support (consumed by *.test.js files) ===
export * from './mockPathsDataRoot.js';
export * from './testHelper.js';
