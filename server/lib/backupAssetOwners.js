/**
 * Inventory of durable asset owners for backup snapshot consistency (#9923).
 * An owner is one workflow that writes, replaces or deletes bytes under `data/`
 * together with a row (PostgreSQL or a `data/` record) that names them.
 *
 * - `admitted`: holds `withBackupAssetPublication` from its first byte change
 *   through the row that names (or stops naming) those bytes. Every listed
 *   module calls it; `backupAssetOwners.test.js` keeps this list and the code
 *   in step in both directions.
 * - `reference-only`: writes rows naming bytes that were already durable before
 *   its trigger was published, and writes no bytes itself, so there is no gap
 *   for a cut to land in.
 * - `outstanding`: still changes bytes and rows outside admission.
 *
 * A snapshot claims global file-and-row consistency only when nothing is
 * outstanding (`backupAssetConsistency`). Module paths are relative to `server/`.
 */

export const BACKUP_ASSET_OWNERS = Object.freeze([
  { id: 'music-take-publication', status: 'admitted', modules: ['services/musicTakePublication.js'] },
  { id: 'media-job-completion', status: 'admitted', modules: ['services/mediaJobQueue/index.js'] },
  { id: 'media-job-attach-hooks', status: 'admitted', modules: ['services/mediaJobImageHook.js'] },
  {
    id: 'pipeline-filename-hooks',
    status: 'admitted',
    modules: ['services/pipeline/filenameHookFactory.js', 'services/pipeline/seasonCoverFilenameHook.js'],
  },
  {
    id: 'universe-builder-render-listeners',
    status: 'admitted',
    modules: ['services/universeBuilderCollectionHook.js', 'services/universeCharacterSheet.js'],
  },
  { id: 'gallery-image-workflows', status: 'admitted', modules: ['services/imageGen/local.js'] },
  { id: 'gallery-image-deletion-canon-purge', status: 'admitted', modules: ['services/galleryImageDeletion.js'] },
  { id: 'video-history-deletion', status: 'admitted', modules: ['services/videoGen/historyOps.js'] },
  {
    id: 'lora-dataset-workflows',
    status: 'admitted',
    modules: ['services/loraDatasets.js', 'services/loraDatasetGenerate.js'],
  },
  { id: 'voice-studio', status: 'admitted', modules: ['services/voice/studio.js'] },
  {
    id: 'music-video-development-artifacts',
    status: 'admitted',
    modules: ['services/musicVideo/devArtifactService.js', 'services/musicVideo/vocalStem.js'],
  },
  {
    id: 'creative-director-evaluation-frames',
    status: 'admitted',
    modules: ['services/creativeDirector/sceneRunner.js', 'services/creativeDirector/completionHook.js'],
  },
  {
    // Scene status/auto-accept, plan-step settlement and the seed-frame wait
    // record a finished render's job id; its file was written before the
    // queue's admitted completion published that job.
    id: 'creative-director-render-settlement',
    status: 'reference-only',
    modules: [
      'services/creativeDirector/sceneRunner.js',
      'services/creativeDirector/planAdvance.js',
      'services/creativeDirector/completionHook.js',
    ],
  },
  { id: 'music-video-production-settlement', status: 'reference-only', modules: ['services/musicVideo/productionService.js'] },
  { id: 'sprite-animation-completion', status: 'outstanding', modules: ['services/sprites/localAnimationJobHook.js'] },
  { id: 'music-library-deletion', status: 'outstanding', modules: ['services/pipeline/musicLibrary.js'] },
  {
    id: 'voice-training-artifacts',
    status: 'outstanding',
    modules: ['services/voice/fineTuning.js', 'services/voice/profileBenchmarks.js'],
  },
  // Music Video asset workflows beyond development artifacts and vocal stems,
  // and every replacement/deletion owner this inventory has not classified yet.
  { id: 'music-video-asset-workflows', status: 'outstanding', modules: [] },
  { id: 'unclassified-durable-owners', status: 'outstanding', modules: [] },
]);

/**
 * The consistency a snapshot taken now may claim: `global` only when no owner
 * is outstanding, otherwise `admitted-owners` naming what is still outside.
 */
export function backupAssetConsistency(owners = BACKUP_ASSET_OWNERS) {
  const outstanding = owners.filter(owner => owner.status !== 'admitted' && owner.status !== 'reference-only')
    .map(owner => owner.id);
  return { scope: outstanding.length ? 'admitted-owners' : 'global', outstanding };
}
