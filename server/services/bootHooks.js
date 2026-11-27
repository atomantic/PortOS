/**
 * Boot-time registration of the callbacks lower modules use to reach higher ones.
 *
 * Each registry below replaced a lazy `import()` whose target statically imports
 * the importer. Such an edge keeps a module out of a static closure, but
 * `vitest related` follows it, so it held the CoS, git, worktree and media-queue
 * hubs in one CI-selection cycle (#12285, #17499). The loaders live here, above
 * both sides: nothing in that cycle imports this module.
 *
 * `bootstrapServices()` calls `registerBootHooks()` before it initializes any
 * consumer (the CoS daemon, the media queue, or the routes that serve git
 * cleanup). A suite that runs one of those consumers calls it too, or registers
 * doubles in the leaf directly. Feature-agent lifecycle listeners must already
 * be present when CoS reattaches agents. Media loaders stay lazy.
 */
import { warmModuleLoads } from '../lib/moduleWarmup.js';
import {
  registerCosOrphanRecoveryHandlers, registerMediaJobTerminalHooks, registerMediaRuntimeModules,
  registerManagedVisitorCredentialRestore, registerMergedBranchCleanup, registerMusicVideoRecovery,
} from './bootHookRegistry.js';
import { parseComicPagesOwner, parseSeasonCoverOwner, parseStoryboardsShotOwner } from './pipeline/owners.js';
import './featureAgents.js';
import { registerAutoReviewCompletionListeners } from './musicVideo/autoReviewCompletionListeners.js';

const agentManagement = () => import('./agent/agentManagement.js');
const tag = key => job => job.params?.[key];
const musicProject = job => job.params?.musicVideo || job.params?.musicVideoProjectId;
const collectionOwned = job => ['deckCard', 'moodBoardPoster', 'storyboardPanelRender', 'fableLoom', 'creativeDirector', 'spriteRef']
  .some(key => job.params?.[key]);

const mediaRuntimeLoaders = {
  topazUpscale: () => import('./videoGen/topazJob.js'),
  falUpscale: () => import('./videoGen/falUpscaleJob.js'),
  realesrganUpscale: () => import('./videoGen/realesrganUpscaleJob.js'),
  ltxUpscale: () => import('./videoGen/upscaleJob.js'),
  stitch: () => import('./videoGen/stitchJob.js'),
  vertical: () => import('./videoGen/verticalJob.js'),
  videoLocal: () => import('./videoGen/local.js'),
  videoGrok: () => import('./videoGen/grok.js'),
  videoFal: () => import('./videoGen/fal.js'),
  videoReactor: () => import('./videoGen/reactor.js'),
  videoRunway: () => import('./videoGen/runway.js'),
  videoGemini: () => import('./videoGen/geminiWeb.js'),
  videoHiggsfield: () => import('./videoGen/higgsfield.js'),
  videoGoogle: () => import('./videoGen/google.js'),
  imageLocal: () => import('./imageGen/local.js'),
  imageCodex: () => import('./imageGen/codex.js'),
  imageGrok: () => import('./imageGen/grok.js'),
  imageAgy: () => import('./imageGen/agy.js'),
  imageFal: () => import('./imageGen/fal.js'),
  imageRunway: () => import('./imageGen/runway.js'),
  imageHiggsfield: () => import('./imageGen/higgsfield.js'),
  imageGoogle: () => import('./imageGen/google.js'),
  audioLocal: () => import('./audioGen/local.js'),
  sharingCopy: () => import('./musicVideo/sharingCopy.js'),
  htmlComposition: () => import('./htmlComposition/index.js'),
  superCollider: () => import('./superColliderRender.js'),
  audioRemote: () => import('./audioGen/remote.js'),
  imageRemote: () => import('./imageGen/remote.js'),
  videoRemote: () => import('./videoGen/remote.js'),
  reviewedReference: () => import('./imageGen/reviewedReference.js'),
  finishVisualProfile: () => import('./imageGen/finishVisualProfile.js'),
  imageVerifier: () => import('./imageVerifier.js'),
  topazStaging: () => import('./videoGen/topazStaging.js'),
  videoModelSelection: () => import('./videoGen/modelSelection.js'),
  creativeDirectorVideoExecution: () => import('./creativeDirector/videoExecution.js'),
  musicVideoProjects: () => import('./musicVideo/projects.js'),
  musicVideoClipCastReferences: () => import('./musicVideo/clipCastReferences.js'),
  musicVideoRevisionService: () => import('./musicVideo/revisionService.js'),
  musicVideoProductionReview: () => import('./musicVideo/productionReviewService.js'),
  fableLoomRequestInputs: () => import('./fableLoom/requestInputs.js'),
};

// Keep import and initialization separate: warmup evaluates modules, while
// the queue installs listeners only when a matching job needs them.
const mediaTerminalHooks = [
  [collectionOwned, () => import('./mediaCollectionCompletionHook.js'), m => m.initMediaCollectionCompletionHook()],
  [tag('universeRun'), () => import('./universeBuilderCollectionHook.js'), m => m.initUniverseBuilderCollectionHook()],
  [tag('characterSheet'), () => import('./universeCharacterSheet.js'), m => m.initCharacterSheetCompletionHook()],
  [tag('catalogAttach'), () => import('./catalog/catalogImageAttachHook.js'), m => m.initCatalogImageAttachHook()],
  [tag('blenderModelReference'), () => import('./blenderModels/referenceImageHook.js'), m => m.initBlenderModelReferenceHook()],
  [tag('writersRoom'), () => import('./writersRoomSceneImageHook.js'), m => m.initWritersRoomSceneImageHook()],
  [tag('fableLoom'), () => import('./fableLoomSceneImageHook.js'), m => m.initFableLoomSceneImageHook()],
  [tag('fableLoom'), () => import('./fableLoomSceneVideoHook.js'), m => m.initFableLoomSceneVideoHook()],
  [tag('musicVideo'), () => import('./musicVideoSceneImageHook.js'), m => m.initMusicVideoSceneImageHook()],
  [tag('musicVideo'), () => import('./musicVideoSceneVideoHook.js'), m => m.initMusicVideoSceneVideoHook()],
  [tag('musicVideo'), () => import('./musicVideoSequenceVideoHook.js'), m => m.initMusicVideoSequenceVideoHook()],
  [tag('musicVideo'), () => import('./musicVideoSequenceTakeHook.js'), m => m.initMusicVideoSequenceTakeHook()],
  [tag('musicVideo'), () => import('./musicVideoCastSetsImageHook.js'), m => m.initMusicVideoCastSetsImageHook()],
  [tag('musicVideo'), () => import('./musicVideoCoverArtImageHook.js'), m => m.initMusicVideoCoverArtImageHook()],
  [musicProject, () => import('./musicVideoCollectionHook.js'), m => m.initMusicVideoCollectionHook()],
  [musicProject, () => import('./musicVideoRenderSpendHook.js'), m => m.initMusicVideoRenderSpendHook()],
  [tag('collectionName'), () => import('./requestedCollectionHook.js'), m => m.initRequestedCollectionHook()],
  [tag('creativeDirectorMusicBed'), () => import('./creativeDirectorMusicBedHook.js'), m => m.initCreativeDirectorMusicBedHook()],
  [tag('musicStudio'), () => import('./musicStudioHook.js'), m => m.initMusicStudioHook()],
  [tag('spriteRef'), () => import('./spriteReferenceImageHook.js'), m => m.initSpriteReferenceImageHook()],
  [tag('moodBoardRender'), () => import('./moodBoardItemRenderHook.js'), m => m.initMoodBoardItemRenderHook()],
  [tag('storyboardPanelRender'), () => import('./storyboardPanelImageHook.js'), m => m.initStoryboardPanelImageHook()],
  [tag('deckCard'), () => import('./deckRenderHook.js'), m => m.initDeckRenderHook()],
  [tag('creativeDirector'), () => import('./creativeDirectorSceneImageHook.js'), m => m.initCreativeDirectorSceneImageHook()],
  [job => job.params?.creativeDirector || job.params?.creativeDirectorMusicBed, () => import('./creativeDirector/renderFailureHook.js'), m => m.initCreativeDirectorRenderFailureHook()],
  [job => parseComicPagesOwner(job.owner), () => import('./pipeline/comicPagesFilenameHook.js'), m => m.initComicPagesFilenameHook()],
  [job => parseStoryboardsShotOwner(job.owner), () => import('./pipeline/storyboardsFilenameHook.js'), m => m.initStoryboardsFilenameHook()],
  [job => parseSeasonCoverOwner(job.owner), () => import('./pipeline/seasonCoverFilenameHook.js'), m => m.initSeasonCoverFilenameHook()],
];

export const warmMediaBootHooks = () => warmModuleLoads([
  ...Object.entries(mediaRuntimeLoaders).map(([name, load]) => [`Media runtime ${name}`, load]),
  ...mediaTerminalHooks.map(([, load]) => ['Media job terminal hook', load]),
]);

export function registerBootHooks() {
  registerAutoReviewCompletionListeners();
  registerManagedVisitorCredentialRestore(async operation => {
    const { getManagedVisitorBroker } = await import('./managedVisitors.js');
    return getManagedVisitorBroker().withLiveCredentialRestore(operation);
  });
  registerCosOrphanRecoveryHandlers({
    cleanupOrphanedAgents: async (...args) => (await agentManagement()).cleanupOrphanedAgents(...args),
    handleOrphanedTask: async (...args) => (await agentManagement()).handleOrphanedTask(...args),
  });
  registerMergedBranchCleanup(async (...args) => (await import('./branchReconcile.js')).cleanupMerged(...args));
  registerMediaRuntimeModules(mediaRuntimeLoaders);
  registerMediaJobTerminalHooks(mediaTerminalHooks.map(([matches, load, initialize]) => [
    matches, async () => initialize(await load()),
  ]));
  // Render and excerpt recovery are boot-only. The modules stay off the static
  // boot closure so a leaf split in that pipeline does not saturate the cap (#17692).
  registerMusicVideoRecovery({
    recoverRenders: () => import('./musicVideo/render.js').then(m => m.recoverStuckMusicVideoRenders()),
    recoverExcerpts: () => import('./musicVideo/excerptRender.js').then(m => m.recoverStuckMusicVideoExcerpts()),
  });
}
