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
      'services/musicVideo/sharingCopy.js', 'services/musicVideo/coverArt.js',
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
  {
    // Catalog ingredient media and voice-memo scraps, and an imported round
    // reference audio: the file lands first and the row that first names it
    // commits under the lease. Persistent Mind screenshots and songbook
    // attachments keep their records in data/ files that one rsync pass copies
    // apart from the bytes, so each holds the lease from its first byte change
    // (or, for an upload, the record write) through the record. Committing a
    // voice-memo scrap to an ingredient names bytes the admitted scrap already
    // named, and detaching catalog media removes no bytes.
    id: 'attachments-and-catalog-media',
    status: 'admitted',
    modules: [
      'services/persistentMindAttachments.js', 'routes/brainSongbook.js', 'services/catalogMedia.js',
      'services/catalogIngestSources.js', 'services/roundReferenceAudioImport.js',
    ],
  },
  {
    // Re-hosted images, Pinterest and X imports, extracted frames and collages:
    // downloads and renders run outside admission, and the board row that first
    // names them commits under the lease. URL- and pin-keyed downloads rewrite
    // their file in place, so that write takes the lease too. Removing an item
    // or a board removes no bytes.
    id: 'mood-board-imports',
    status: 'admitted',
    modules: [
      'services/moodBoard/collage.js', 'services/moodBoard/pinterest.js', 'services/moodBoard/privatePinterest.js',
      'services/moodBoard/xPost.js', 'services/moodBoard/localize.js', 'services/moodBoard/index.js',
    ],
  },
  {
    // Generated HTML and the completed job row naming it are one lease. A
    // package import or repair stages a write-once revision tree, and the
    // revision row that first names it commits under the lease. Stage-run
    // artifacts (frames, soundtrack WAV, Blender bake) are write-once files the
    // run row first names, so every run-row write takes the lease. A Blender
    // film is copied under a fresh name and its history entry commits under the
    // lease; the soundtrack mux installs over an already-named browser render,
    // so that in-place install takes it too.
    id: 'code-animation-projects',
    status: 'admitted',
    modules: [
      'services/codeAnimation/index.js', 'services/codeAnimation/projects.js', 'services/codeAnimation/stages.js',
      'services/codeAnimation/sound.js', 'services/codeAnimation/blenderRender.js',
    ],
  },
  {
    // Export staging directories and contained-worker workspaces are scratch no
    // row names. Accepting an output stamps a row naming a render whose bytes
    // and run row were already durable.
    id: 'code-animation-staging-and-acceptance',
    status: 'reference-only',
    modules: ['services/codeAnimation/export.js', 'services/codeAnimation/acceptance.js'],
  },
  {
    // Reference lock and the three unlocks (manifest plus the row's status and
    // frozen chroma key), walk set finalization (the walk set, then the row that
    // says walk-complete) and the unlock, reopen and anchor/turnaround revision
    // paths that remove it and downgrade the row, and each source-pipeline import
    // subject (the copied tree, then the row that marks it imported). The grok-TUI
    // lanes' attach (walk and named tracks) runs outside the completion hook, so
    // it takes its own lease. Every one takes the lease before the per-record
    // write tail, like the completion hook.
    id: 'sprite-reference-walk-and-import-commits',
    status: 'admitted',
    modules: [
      'services/sprites/reference.js', 'services/sprites/walk.js', 'services/sprites/importer.js',
      'services/sprites/animationTrackWorkflow.js',
    ],
  },
  {
    // The sprite row holds metadata and workflow state only, never a path under
    // data/ (`spriteBackupAdmission.test.js` pins its shape), so a dumped row
    // cannot dangle at bytes these workflows write, replace or delete: generation
    // starts and reference uploads, candidate and run records, selections, loop
    // trims, atlas compile and its runtime pointer, publication history, asset
    // deletion, and the publish-binding and chroma-key pin row writes. Their
    // versioned artifacts are write-once and the record naming them is written
    // last, so a copy that lists the record lists the files.
    id: 'sprite-file-only-records',
    status: 'reference-only',
    modules: [
      'services/sprites/reference.js', 'services/sprites/walk.js', 'services/sprites/walkTrims.js',
      'services/sprites/atlas.js', 'services/sprites/assets.js', 'services/sprites/publish.js',
      'services/sprites/animationTrackWorkflow.js',
    ],
  },
  // Classified by a code sweep (#9982) but still outside admission. Each entry
  // names the modules whose file-plus-record workflows are not wrapped yet, so a
  // continuation can take one and move it up. Entries are per domain, not per
  // function: a module listed here may also hold already-admitted workflows.
  {
    // Gallery uploads hold one lease from byte installation through their
    // history entry and rollback. Downloads run yt-dlp outside admission, then
    // lease the poster and history commit with rollback. Poster edits acquire
    // before the history tail and keep creation, commit and cleanup together.
    id: 'video-library-import-and-poster-publication',
    status: 'admitted',
    modules: ['services/videoUpload.js', 'services/videoDownload.js', 'services/videoGen/poster.js'],
  },
  {
    // The shared local, batch and cloud (Grok/fal/Reactor) finalize owns
    // faststart, poster, serialized history and rollback. Caller latches keep
    // committed outputs out of later failure/cancellation cleanup. Long fresh
    // producers remain outside admission; only unreferenced outputs are discarded.
    id: 'generated-video-shared-finalizer',
    status: 'admitted',
    modules: ['services/videoGen/generateVideoHelpers.js'],
  },
  {
    // Federated replacement/replay keeps installation and rollback with history.
    // Derived clips lease poster/history publication after fresh renders finish.
    id: 'video-generation-finalize-and-derived-clips',
    status: 'admitted',
    modules: [
      'services/videoGen/remote.js',
      'services/videoGen/stitchVideos.js', 'services/videoGen/upscaleVideo.js', 'services/videoGen/upscaleJob.js',
      'services/videoTimeline/local.js', 'services/htmlComposition/index.js',
    ],
  },
  {
    // Derived rows are excluded from snapshot dumps. Restore reconstructs
    // them from authoritative sidecars/history before releasing the DB fence;
    // failed reads or SQL retain the fence and cannot report success. File
    // restores refresh the same mirror. No asset bytes are owned here.
    id: 'media-asset-index-refresh',
    status: 'reference-only',
    modules: ['services/mediaAssetIndex/index.js', 'services/mediaAssetIndex/db.js'],
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
    // Downloads run outside admission. The write that lands a pulled asset (with
    // its sidecar, poster and media_assets row), a draft body or a bible file, the
    // share bucket's asset copy, and the library sweep's index rebuild each hold
    // the lease.
    id: 'peer-and-share-imports',
    status: 'admitted',
    modules: [
      'services/sharing/peerSyncAssets.js', 'services/sharing/importer.js', 'services/sharing/peerMediaLibrarySync.js',
    ],
  },
  {
    // The ChatGPT zip import extracts assets before any row names them; each
    // conversation's archived transcript and the memory row that names it (and
    // its assets) commit under one lease. Deleting an import memory drops the
    // record, then its transcript and unreferenced assets, under one lease.
    id: 'chatgpt-import-and-memory-asset-deletion',
    status: 'admitted',
    modules: ['services/chatgptImport.js', 'services/brain.js'],
  },
  {
    // The ingest index record that first names a landed transcript or audio
    // file commits under the lease; forgetting an ingest drops the record and
    // unlinks its files under one lease. The long yt-dlp downloads stay outside.
    id: 'youtube-ingest',
    status: 'admitted',
    modules: ['services/youtubeIngest.js'],
  },
  {
    // Digital twin document files plus the meta row naming them, and the genome
    // raw file plus its metadata: each create, edit, upload and delete is one
    // workflow.
    id: 'digital-twin-documents-and-genome',
    status: 'admitted',
    modules: ['services/digital-twin-documents.js', 'services/genome.js'],
  },
  {
    // Explicit file cleanup can leave external references by design, but one
    // lease keeps its single/bulk deletion out of a copy-then-dump snapshot.
    id: 'operator-file-purge', status: 'admitted',
    modules: ['services/dataManager.js', 'routes/uploads.js', 'routes/attachments.js'],
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
