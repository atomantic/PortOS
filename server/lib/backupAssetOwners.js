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
 *   for a cut to land in. A deletion that commits the row that stops naming
 *   its bytes before it removes them belongs here too: the dump that follows a
 *   cut's file copy either sees no row, or sees one whose bytes were removed
 *   only after the copy finished. So does a record whose bytes no row names:
 *   the copy takes it whole or not at all, and no dumped row can dangle.
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
    // Trained LoRA registration (adapter, sidecar, run row, dataset flag),
    // checkpoint promotion over the deployed adapter, the promoted-checkpoint
    // preview copy, the progress row that first names trainer-written samples
    // and checkpoints, run deletion, and LoRA deletion from either manager
    // route. Civitai and Hugging Face installs land the weights under their
    // final name first; the sidecar naming them is the admitted commit.
    // Staged trainer inputs are rebuilt from the dataset on every run and
    // resume, and sidecar metadata patches change no asset bytes. Dataset
    // deletion is part of `lora-dataset-workflows`.
    id: 'lora-training-registration-and-deletion',
    status: 'admitted',
    modules: ['services/loraTraining/index.js', 'services/loras.js'],
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
  {
    // Final and excerpt renders, publishing-kit builds and composition document
    // versions: the encoder or import writes the MP4, kit files or version
    // folder in place, then the history entry and project row that first name
    // them commit under one lease (the final render's poster too).
    id: 'music-video-render-and-document-commits',
    status: 'admitted',
    modules: [
      'services/musicVideo/render.js', 'services/musicVideo/excerptRender.js',
      'services/musicVideo/publishKit.js', 'services/musicVideo/compositionDocument.js',
    ],
  },
  {
    // Excerpt deletion commits the project row without the excerpt, then
    // unlinks its video and contact sheet once no project names them.
    id: 'music-video-excerpt-deletion',
    status: 'reference-only',
    modules: ['services/musicVideo/excerptService.js'],
  },
  {
    // The repair's boundary frame is written in place, then the revision row
    // that names it commits under the lease.
    id: 'music-video-performance-repair',
    status: 'admitted',
    modules: ['services/musicVideo/performanceRepair.js'],
  },
  {
    // The .mid copy, the project row that names it and the discard unlink are
    // one workflow; the sidecar runs outside admission.
    id: 'music-video-midi-transcription',
    status: 'admitted',
    modules: ['services/audioMidiTranscription.js'],
  },
  {
    // The Suno M4A reaches the music library through its admitted import; the
    // track row that first names it commits under the lease.
    id: 'music-video-autonomous-song',
    status: 'admitted',
    modules: ['services/musicVideo/autonomousService.js'],
  },
  {
    // A draft body replaces its .md in place and the manifest row records its new
    // hash and segment index; a new work or version writes its .md before the
    // row that names it. Each is one workflow, holding the lease across both.
    id: 'writers-room-draft-bodies',
    status: 'admitted',
    modules: ['services/writersRoom/local.js'],
  },
  {
    // Tombstone GC drops the work rows first and removes their directories after.
    id: 'writers-room-tombstone-prune',
    status: 'reference-only',
    modules: ['services/writersRoom/sync.js'],
  },
  {
    // Polish cycle snapshots are JSON files no row names; the revert and keep
    // gates write the draft itself through the admitted `saveDraftBody`.
    id: 'writers-room-polish-snapshots',
    status: 'reference-only',
    modules: ['services/writersRoom/polish.js'],
  },
  {
    // The runner writes model.glb in place while the row still says `generating`,
    // so only the commit that marks the mesh ready takes the lease. An AR export
    // replaces model.usdz in place, so its file write and the row stamping it are
    // one workflow.
    id: 'image-to-3d-render-and-ar-export',
    status: 'admitted',
    modules: ['services/imageTo3d/models.js'],
  },
  {
    // Deleting a model soft-deletes the row, then removes its render directory
    // once the render has settled; the directory is never removed first.
    id: 'image-to-3d-record-deletion',
    status: 'reference-only',
    modules: ['services/imageTo3d/models.js'],
  },
  {
    // A rig or retarget pair is published into its own `rig/<id>` or
    // `retarget/<id>` directory, never replaced, and verified; the row that first
    // names it commits under the lease. A half-moved pair is named by no row.
    id: 'rigging-published-pairs',
    status: 'admitted',
    modules: ['services/rigging/autoSkin.js', 'services/rigging/retarget.js'],
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
