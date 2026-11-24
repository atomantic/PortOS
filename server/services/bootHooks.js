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
 * doubles in the leaf directly. Loaders stay lazy so their targets stay off the static boot closure.
 */
import {
  registerCosOrphanRecoveryHandlers, registerMediaJobTerminalHooks, registerMediaRuntimeModules,
  registerMergedBranchCleanup, registerMusicVideoRecovery,
} from './bootHookRegistry.js';
import { parseComicPagesOwner, parseSeasonCoverOwner, parseStoryboardsShotOwner } from './pipeline/owners.js';

const agentManagement = () => import('./agent/agentManagement.js');
const tag = key => job => job.params?.[key];
const musicProject = job => job.params?.musicVideo || job.params?.musicVideoProjectId;
const collectionOwned = job => ['deckCard', 'moodBoardPoster', 'storyboardPanelRender', 'fableLoom', 'creativeDirector', 'spriteRef']
  .some(key => job.params?.[key]);

export function registerBootHooks() {
  registerCosOrphanRecoveryHandlers({
    cleanupOrphanedAgents: async (...args) => (await agentManagement()).cleanupOrphanedAgents(...args),
    handleOrphanedTask: async (...args) => (await agentManagement()).handleOrphanedTask(...args),
  });
  registerMergedBranchCleanup(async (...args) => (await import('./branchReconcile.js')).cleanupMerged(...args));
  registerMediaRuntimeModules({
    topazUpscale: () => import('./videoGen/topazJob.js'),
    ltxUpscale: () => import('./videoGen/upscaleJob.js'),
    stitch: () => import('./videoGen/stitchJob.js'),
    vertical: () => import('./videoGen/verticalJob.js'),
    training: () => import('./loraTraining/index.js'),
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
  });
  registerMediaJobTerminalHooks([
    [collectionOwned, () => import('./mediaCollectionCompletionHook.js').then(m => m.initMediaCollectionCompletionHook())],
    [tag('universeRun'), () => import('./universeBuilderCollectionHook.js').then(m => m.initUniverseBuilderCollectionHook())],
    [tag('catalogAttach'), () => import('./catalog/catalogImageAttachHook.js').then(m => m.initCatalogImageAttachHook())],
    [tag('blenderModelReference'), () => import('./blenderModels/referenceImageHook.js').then(m => m.initBlenderModelReferenceHook())],
    [tag('writersRoom'), () => import('./writersRoomSceneImageHook.js').then(m => m.initWritersRoomSceneImageHook())],
    [tag('fableLoom'), () => import('./fableLoomSceneImageHook.js').then(m => m.initFableLoomSceneImageHook())],
    [tag('fableLoom'), () => import('./fableLoomSceneVideoHook.js').then(m => m.initFableLoomSceneVideoHook())],
    [tag('musicVideo'), () => import('./musicVideoSceneImageHook.js').then(m => m.initMusicVideoSceneImageHook())],
    [tag('musicVideo'), () => import('./musicVideoSceneVideoHook.js').then(m => m.initMusicVideoSceneVideoHook())],
    [tag('musicVideo'), () => import('./musicVideoSequenceVideoHook.js').then(m => m.initMusicVideoSequenceVideoHook())],
    [tag('musicVideo'), () => import('./musicVideoSequenceTakeHook.js').then(m => m.initMusicVideoSequenceTakeHook())],
    [tag('musicVideo'), () => import('./musicVideoCastSetsImageHook.js').then(m => m.initMusicVideoCastSetsImageHook())],
    [tag('musicVideo'), () => import('./musicVideoCoverArtImageHook.js').then(m => m.initMusicVideoCoverArtImageHook())],
    [musicProject, () => import('./musicVideoCollectionHook.js').then(m => m.initMusicVideoCollectionHook())],
    [musicProject, () => import('./musicVideoRenderSpendHook.js').then(m => m.initMusicVideoRenderSpendHook())],
    [tag('collectionName'), () => import('./requestedCollectionHook.js').then(m => m.initRequestedCollectionHook())],
    [tag('creativeDirectorMusicBed'), () => import('./creativeDirectorMusicBedHook.js').then(m => m.initCreativeDirectorMusicBedHook())],
    [tag('musicStudio'), () => import('./musicStudioHook.js').then(m => m.initMusicStudioHook())],
    [tag('spriteRef'), () => import('./spriteReferenceImageHook.js').then(m => m.initSpriteReferenceImageHook())],
    [tag('moodBoardRender'), () => import('./moodBoardItemRenderHook.js').then(m => m.initMoodBoardItemRenderHook())],
    [tag('storyboardPanelRender'), () => import('./storyboardPanelImageHook.js').then(m => m.initStoryboardPanelImageHook())],
    [tag('deckCard'), () => import('./deckRenderHook.js').then(m => m.initDeckRenderHook())],
    [tag('creativeDirector'), () => import('./creativeDirectorSceneImageHook.js').then(m => m.initCreativeDirectorSceneImageHook())],
    [job => job.params?.creativeDirector || job.params?.creativeDirectorMusicBed, () => import('./creativeDirector/renderFailureHook.js').then(m => m.initCreativeDirectorRenderFailureHook())],
    [job => parseComicPagesOwner(job.owner), () => import('./pipeline/comicPagesFilenameHook.js').then(m => m.initComicPagesFilenameHook())],
    [job => parseStoryboardsShotOwner(job.owner), () => import('./pipeline/storyboardsFilenameHook.js').then(m => m.initStoryboardsFilenameHook())],
    [job => parseSeasonCoverOwner(job.owner), () => import('./pipeline/seasonCoverFilenameHook.js').then(m => m.initSeasonCoverFilenameHook())],
  ]);
  // Render and excerpt recovery are boot-only. The modules stay off the static
  // boot closure so a leaf split in that pipeline does not saturate the cap (#17692).
  registerMusicVideoRecovery({
    recoverRenders: () => import('./musicVideo/render.js').then(m => m.recoverStuckMusicVideoRenders()),
    recoverExcerpts: () => import('./musicVideo/excerptRender.js').then(m => m.recoverStuckMusicVideoExcerpts()),
  });
}
