/**
 * Exceptions to backup asset publication admission for managed runtime workflows (#9923).
 *
 * A workflow that holds the publication lease where needed registers at its
 * `withBackupAssetPublication` call site. Use this inventory to explain paths
 * that can run outside the lease or identify paths that still need admission.
 *
 * - `reference-only`: names bytes already durable before the workflow receives
 *   them, removes a PostgreSQL reference before unlinking the bytes, or handles
 *   no coupled bytes and records. The snapshot copies files before dumping
 *   PostgreSQL, so a dumped reference still has its bytes. File-primary indexes
 *   require admission because their copy order relative to assets can vary.
 * - `outstanding`: changes bytes and their records outside admission without a
 *   safe ordering.
 *
 * A snapshot claims global file-and-row consistency only when nothing is
 * outstanding (`backupAssetConsistency`). Module paths are relative to `server/`.
 */

export const BACKUP_ASSET_OWNERS = Object.freeze([
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
  {
    // Final/rough-cut rows name the existing timeline history entry; these
    // callers' audio replacements are admitted by the shared mux helpers.
    id: 'creative-director-cut-settlement',
    status: 'reference-only',
    modules: ['services/creativeDirector/stitchRunner.js', 'services/creativeDirector/videoAssembly.js'],
  },
  {
    // Reads existing assets, transforms in buffers, returns a ZIP response.
    // No durable file or row is written by either making-of module.
    id: 'music-video-making-of-export',
    status: 'reference-only',
    modules: ['services/musicVideo/makingOf.js', 'services/musicVideo/makingOfVisuals.js'],
  },
  { id: 'music-video-production-settlement', status: 'reference-only', modules: ['services/musicVideo/productionService.js'] },
  {
    // Library uploads are copied by the admitted `musicLibrary.js` import, and
    // the track or issue row that names the copy commits after it. The Music
    // Designer upload route (`routes/tracks.js`) and the pipeline upload route
    // follow the same import-then-row order.
    id: 'music-library-attach-after-import',
    status: 'reference-only',
    modules: ['services/trackYoutubeImport.js', 'services/trackSunoImport.js'],
  },
  {
    // Excerpt deletion commits the project row without the excerpt, then
    // unlinks its video and contact sheet once no project names them.
    id: 'music-video-excerpt-deletion',
    status: 'reference-only',
    modules: ['services/musicVideo/excerptService.js'],
  },
  {
    // Polish cycle snapshots are JSON files no row names; the revert and keep
    // gates write the draft itself through the admitted `saveDraftBody`.
    id: 'writers-room-polish-snapshots',
    status: 'reference-only',
    modules: ['services/writersRoom/polish.js'],
  },
  {
    // Deleting a model soft-deletes the row, then removes its render directory
    // once the render has settled; the directory is never removed first.
    id: 'image-to-3d-record-deletion',
    status: 'reference-only',
    modules: ['services/imageTo3d/models.js'],
  },
  {
    // Publishing names a finished build whose bytes are already durable.
    // Pruning and deletion drop builds from the row before removing their
    // folders; a source write or scaffold changes src/, which no row names.
    id: 'blender-model-publish-prune-and-source',
    status: 'reference-only',
    modules: ['services/blenderModels/models.js', 'services/blenderModels/build.js'],
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
    // Derived rows are excluded from snapshot dumps. Restore reconstructs
    // them from authoritative sidecars/history before releasing the DB fence;
    // failed reads or SQL retain the fence and cannot report success. File
    // restores refresh the same mirror. No asset bytes are owned here.
    id: 'media-asset-index-refresh',
    status: 'reference-only',
    modules: ['services/mediaAssetIndex/index.js', 'services/mediaAssetIndex/db.js'],
  },
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
