/** Register the terminal listeners a queued or restored media job needs before its outcome becomes durable. */
import { parseComicPagesOwner, parseSeasonCoverOwner, parseStoryboardsShotOwner } from '../pipeline/owners.js';

const tag = key => job => job.params?.[key];
const musicProject = job => job.params?.musicVideo || job.params?.musicVideoProjectId;
const collectionOwned = job => ['deckCard', 'moodBoardPoster', 'storyboardPanelRender', 'fableLoom', 'creativeDirector', 'spriteRef']
  .some(key => job.params?.[key]);
const hooks = [
  [collectionOwned, () => import('../mediaCollectionCompletionHook.js').then(m => m.initMediaCollectionCompletionHook())],
  [tag('universeRun'), () => import('../universeBuilderCollectionHook.js').then(m => m.initUniverseBuilderCollectionHook())],
  [tag('catalogAttach'), () => import('../catalog/catalogImageAttachHook.js').then(m => m.initCatalogImageAttachHook())],
  [tag('writersRoom'), () => import('../writersRoomSceneImageHook.js').then(m => m.initWritersRoomSceneImageHook())],
  [tag('fableLoom'), () => import('../fableLoomSceneImageHook.js').then(m => m.initFableLoomSceneImageHook())],
  [tag('fableLoom'), () => import('../fableLoomSceneVideoHook.js').then(m => m.initFableLoomSceneVideoHook())],
  [tag('musicVideo'), () => import('../musicVideoSceneImageHook.js').then(m => m.initMusicVideoSceneImageHook())],
  [tag('musicVideo'), () => import('../musicVideoSceneVideoHook.js').then(m => m.initMusicVideoSceneVideoHook())],
  [tag('musicVideo'), () => import('../musicVideoSequenceVideoHook.js').then(m => m.initMusicVideoSequenceVideoHook())],
  [tag('musicVideo'), () => import('../musicVideoSequenceTakeHook.js').then(m => m.initMusicVideoSequenceTakeHook())],
  [tag('musicVideo'), () => import('../musicVideoCastSetsImageHook.js').then(m => m.initMusicVideoCastSetsImageHook())],
  [tag('musicVideo'), () => import('../musicVideoCoverArtImageHook.js').then(m => m.initMusicVideoCoverArtImageHook())],
  [musicProject, () => import('../musicVideoCollectionHook.js').then(m => m.initMusicVideoCollectionHook())],
  [musicProject, () => import('../musicVideoRenderSpendHook.js').then(m => m.initMusicVideoRenderSpendHook())],
  [tag('collectionName'), () => import('../requestedCollectionHook.js').then(m => m.initRequestedCollectionHook())],
  [tag('creativeDirectorMusicBed'), () => import('../creativeDirectorMusicBedHook.js').then(m => m.initCreativeDirectorMusicBedHook())],
  [tag('musicStudio'), () => import('../musicStudioHook.js').then(m => m.initMusicStudioHook())],
  [tag('spriteRef'), () => import('../spriteReferenceImageHook.js').then(m => m.initSpriteReferenceImageHook())],
  [tag('moodBoardRender'), () => import('../moodBoardItemRenderHook.js').then(m => m.initMoodBoardItemRenderHook())],
  [tag('storyboardPanelRender'), () => import('../storyboardPanelImageHook.js').then(m => m.initStoryboardPanelImageHook())],
  [tag('deckCard'), () => import('../deckRenderHook.js').then(m => m.initDeckRenderHook())],
  [tag('creativeDirector'), () => import('../creativeDirectorSceneImageHook.js').then(m => m.initCreativeDirectorSceneImageHook())],
  [job => job.params?.creativeDirector || job.params?.creativeDirectorMusicBed, () => import('../creativeDirector/renderFailureHook.js').then(m => m.initCreativeDirectorRenderFailureHook())],
  [job => parseComicPagesOwner(job.owner), () => import('../pipeline/comicPagesFilenameHook.js').then(m => m.initComicPagesFilenameHook())],
  [job => parseStoryboardsShotOwner(job.owner), () => import('../pipeline/storyboardsFilenameHook.js').then(m => m.initStoryboardsFilenameHook())],
  [job => parseSeasonCoverOwner(job.owner), () => import('../pipeline/seasonCoverFilenameHook.js').then(m => m.initSeasonCoverFilenameHook())],
];

// The same first-load promise covers overlapping jobs. A rejected registration
// must leave its transition staged, so repairing the module and flushing the
// queue can publish the original event without re-running a paid generator.
export function createMediaJobHookLoader(registrations = hooks) {
  const pending = new Map();
  return job => Promise.all(registrations.filter(([matches]) => matches(job)).map(([, load]) => {
    if (!pending.has(load)) {
      pending.set(load, Promise.resolve().then(load).catch(error => {
        pending.delete(load);
        throw Object.assign(new Error(`Media job terminal hook could not load: ${error.message}`, { cause: error }), {
          code: 'MEDIA_JOB_HOOK_LOAD_FAILED',
        });
      }));
    }
    return pending.get(load);
  }));
}
