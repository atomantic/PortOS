/**
 * Inventory of durable asset owners for backup snapshot consistency (#9923).
 * An owner is one workflow that writes, replaces or deletes bytes under `data/`
 * together with a row (PostgreSQL or a `data/` record) that names them.
 *
 * - `admitted`: holds `withBackupAssetPublication` from its first byte change
 *   through the row that names (or stops naming) those bytes. Every listed
 *   module calls it; `backupAssetOwners.test.js` keeps this list and the code
 *   in step in both directions. Where a long producer (a sidecar or child
 *   process) writes the bytes in place, only the row commit takes the lease:
 *   a cut copies files before it dumps rows, so a row that waits out the cut
 *   either precedes it, with its bytes durable and copied, or follows it, with
 *   neither captured.
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
  { id: 'sprite-animation-completion', status: 'admitted', modules: ['services/sprites/localAnimationJobHook.js'] },
  { id: 'music-library-import-and-deletion', status: 'admitted', modules: ['services/pipeline/musicLibrary.js'] },
  {
    // Benchmark audio plus its row, the cloned-candidate recording plus its row,
    // and the fine-tune job record that names each sealed checkpoint. Promoting
    // a checkpoint writes only a row naming bytes the job record already named.
    id: 'voice-training-artifacts',
    status: 'admitted',
    modules: ['services/voice/fineTuning.js', 'services/voice/profileBenchmarks.js', 'services/voice/profiles.js'],
  },
  {
    // Generated and cue-rendered music and voice-over line audio land on disk
    // before the issue row that names them; the row commit takes the lease.
    id: 'pipeline-audio-stage-rows',
    status: 'admitted',
    modules: ['routes/pipeline/audio.js'],
  },
  {
    // Library uploads are copied by the admitted `musicLibrary.js` import, and
    // the track or issue row that names the copy commits after it. The Music
    // Designer upload route (`routes/tracks.js`) and the pipeline upload route
    // follow the same import-then-row order.
    id: 'music-library-attach-after-import',
    status: 'reference-only',
    modules: ['services/trackYoutubeImport.js'],
  },
  // Classified by a code sweep (#9982) but still outside admission. Each entry
  // names the modules whose file-plus-record workflows are not wrapped yet, so a
  // continuation can take one and move it up. Entries are per domain, not per
  // function: a module listed here may also hold already-admitted workflows.
  {
    // Reference lock, loop trim, atlas compile, asset delete and source import,
    // plus the grok-TUI lane's attach, which runs outside the completion hook.
    id: 'sprite-workflows',
    status: 'outstanding',
    modules: [
      'services/sprites/reference.js', 'services/sprites/walkTrims.js', 'services/sprites/atlas.js',
      'services/sprites/assets.js', 'services/sprites/importer.js', 'services/sprites/walk.js',
      'services/sprites/animationTrackWorkflow.js',
    ],
  },
  {
    // Final and excerpt renders, publish kit, composition document versions,
    // performance repair, MIDI transcription, excerpt deletion and the
    // autonomous Suno song, where the MP4 or file is written in place.
    id: 'music-video-render-and-record-owners',
    status: 'outstanding',
    modules: [
      'services/musicVideo/render.js', 'services/musicVideo/excerptRender.js', 'services/musicVideo/excerptService.js',
      'services/musicVideo/publishKit.js', 'services/musicVideo/compositionDocument.js',
      'services/musicVideo/performanceRepair.js', 'services/audioMidiTranscription.js',
      'services/musicVideo/autonomousSuno.js', 'services/musicVideo/autonomousService.js', 'routes/musicVideo.js',
    ],
  },
  {
    // Local, cloud and federated finalize, derived clips (stitch, upscale,
    // timeline, HTML composition, Blender), poster replacement, upload and download.
    id: 'video-generation-finalize-and-derived-clips',
    status: 'outstanding',
    modules: [
      'services/videoGen/generateVideoHelpers.js', 'services/videoGen/spawnWatch.js', 'services/videoGen/grok.js',
      'services/videoGen/fal.js', 'services/videoGen/reactor.js', 'services/videoGen/remote.js',
      'services/videoGen/stitchVideos.js', 'services/videoGen/upscaleVideo.js', 'services/videoGen/upscaleJob.js',
      'services/videoGen/poster.js', 'services/videoTimeline/local.js', 'services/htmlComposition/index.js',
      'services/codeAnimation/blenderRender.js', 'services/videoUpload.js', 'services/videoDownload.js',
    ],
  },
  {
    // The post-exit tails of the generation lanes (upscale, sidecar, auto-clean),
    // variants and sketch pairs. `imageGen/local.js` takes the lease only for
    // gallery upload, sidecar edits and deletion, not for its generation tail.
    id: 'image-generation-completion-tails',
    status: 'outstanding',
    modules: [
      'services/imageGen/local.js', 'services/imageGen/agy.js', 'services/imageGen/codex.js',
      'services/imageGen/grok.js', 'services/imageGen/fal.js', 'services/imageGen/external.js',
      'services/imageGen/remote.js', 'services/imageGen/variants.js', 'services/mediaSketches.js',
    ],
  },
  {
    id: 'writers-room-drafts',
    status: 'outstanding',
    modules: ['services/writersRoom/local.js', 'services/writersRoom/sync.js', 'services/writersRoom/polish.js'],
  },
  {
    // Trained LoRA registration and checkpoint promotion, preview copies, and
    // the run, LoRA and dataset deletes.
    id: 'lora-training-registration-and-deletion',
    status: 'outstanding',
    modules: ['services/loraTraining/index.js', 'services/loras.js', 'routes/loraTraining.js', 'routes/loras.js'],
  },
  {
    // Generated HTML, package import and repair, run artifacts, and the final
    // stage whose soundtrack mux rewrites the MP4 before the history append.
    id: 'code-animation-projects',
    status: 'outstanding',
    modules: [
      'services/codeAnimation/index.js', 'services/codeAnimation/projects.js', 'services/codeAnimation/stages.js',
      'services/codeAnimation/projectFiles.js', 'services/codeAnimation/sound.js',
    ],
  },
  {
    // Peer asset and draft-body pulls, share bucket import, and the peer library sweep.
    id: 'peer-and-share-imports',
    status: 'outstanding',
    modules: [
      'services/sharing/peerSyncAssets.js', 'services/sharing/importer.js', 'services/sharing/peerMediaLibrarySync.js',
    ],
  },
  {
    // Persistent Mind screenshot attachments, songbook attachments, catalog
    // ingredient media and voice memos, and round reference audio.
    id: 'attachments-and-catalog-media',
    status: 'outstanding',
    modules: [
      'services/persistentMindAttachments.js', 'routes/brainSongbook.js', 'services/catalogMedia.js',
      'services/catalogIngestSources.js', 'services/roundReferenceAudioImport.js',
    ],
  },
  {
    id: 'mood-board-imports',
    status: 'outstanding',
    modules: [
      'services/moodBoard/collage.js', 'services/moodBoard/pinterest.js', 'services/moodBoard/privatePinterest.js',
      'services/moodBoard/xPost.js', 'services/moodBoard/localize.js',
    ],
  },
  {
    id: 'image-to-3d-and-rigging',
    status: 'outstanding',
    modules: ['services/imageTo3d/models.js', 'services/rigging/autoSkin.js', 'services/rigging/retarget.js'],
  },
  {
    // ChatGPT archive import and memory-asset deletion, YouTube ingest, and the
    // digital twin and genome document stores.
    id: 'archive-and-document-imports',
    status: 'outstanding',
    modules: [
      'services/chatgptZipImport.js', 'services/chatgptImport.js', 'services/youtubeIngest.js',
      'services/digital-twin-documents.js', 'services/genome.js',
    ],
  },
  // Anything the sweep did not reach. A new asset owner lands here until it is
  // classified; the claim cannot become `global` while this entry exists.
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
