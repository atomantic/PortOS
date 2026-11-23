/**
 * Cross-project media deletion for music videos: forget deleted stills and clips
 * on every project that held them, and the asset manager's pool "Delete".
 *
 * Split from mediaPool.js so the pool's pure and filing helpers, which the
 * project store (projects.js) imports, never import the store back; these
 * workflows sit above both.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { KIND_OF_SLOT, forgetPoolAssets, getMusicVideoMediaPool, usedKeys } from './mediaPool.js';
import { listProjects, mutateProjectRecord, withProjectMediaMutation } from './projects.js';
import { requireProject } from './requireProject.js';

/**
 * After stills or clips (`<image|video>:<ref>` keys) are deleted from the
 * media library: forget them on every music video that held them (unused
 * takes, marks, collection rows), in one pass per project, so nothing points
 * at a file that is gone. Best-effort, like the other filing.
 */
export async function forgetDeletedMusicVideoAssets(keys, { mutateProjectRecord: admittedMutation } = {}) {
  const gone = new Set(keys);
  try {
    const { getCollection, musicVideoCollectionId, bulkUpdateCollectionItems } = await import('../mediaCollections.js');
    for (const project of await listProjects()) {
      const held = Object.keys(project.assetMarks || {}).some((key) => gone.has(key))
        || (project.scenes || []).some((scene) => (scene.takes || []).some((take) => gone.has(`${KIND_OF_SLOT[take?.kind]}:${take?.assetId}`)));
      // The take removal files dropped takes into the collection, so the rows go after it.
      if (held) await (admittedMutation || mutateProjectRecord)(project.id, (current) => forgetPoolAssets(current, keys));
      const collection = await getCollection(musicVideoCollectionId(project.id)).catch(() => null);
      const rows = (collection?.items || []).map((item) => `${item.kind}:${item.ref}`).filter((key) => gone.has(key));
      if (rows.length) await bulkUpdateCollectionItems(collection.id, { remove: rows });
    }
  } catch (err) {
    console.error(`❌ music-video media pool: forgetting ${keys.length} deleted asset(s) failed: ${err.message}`);
  }
}

// Whether the copy on this machine is gone (or hidden) after a deleteMediaAnywhere result.
const poolCopyGone = (result) => result.status === 'deleted'
  || (result.status === 'deleted-remote' && result.hiddenHere === true)
  || (result.status === 'pending' && result.removedHere === true);

/**
 * Delete unused stills and clips of a video from the media library (the asset
 * manager's "Delete"): only assets in the video's pool, so a shot's still or
 * clip and media this video never made are refused. Each delete goes to the
 * machine that owns the asset (deleteMediaAnywhere), then the batch is forgotten
 * on every music video (forgetDeletedMusicVideoAssets). Resolves `{ deleted, items }`,
 * one result per item with its delete status.
 */
export async function deleteMusicVideoPoolAssets(project, items) {
  const { withBackupAssetPublication } = await import('../../lib/backupSnapshotBoundary.js');
  // Backup admission precedes the project boundary, matching gallery/history
  // deletion; one lease covers physical deletion and project cleanup.
  return withBackupAssetPublication(() => withProjectMediaMutation(async (admitted) => {
    const current = await requireProject(project.id);
    const pool = new Set((await getMusicVideoMediaPool(current)).items.map((item) => `${item.kind}:${item.assetId}`));
    // A shot on any music video using it keeps it, not only this video's shots.
    const usedAnywhere = new Set((await listProjects()).flatMap((other) => [...usedKeys(other)]));
    const keys = items.map((item) => `${item.kind}:${item.assetId}`);
    const refused = keys.filter((key) => !pool.has(key) || usedAnywhere.has(key));
    if (refused.length) {
      throw new ServerError(`${refused.length} of these ${refused.length === 1 ? 'is' : 'are'} on a shot or not made for this video`, { status: 409, code: 'POOL_ASSET_IN_USE' });
    }
    const { deleteMediaAnywhere } = await import('../mediaRemoteDelete.js');
    const results = [];
    const forget = [];
    try {
      for (const item of items) {
        // The owner deletes first; a peer-owned asset is never tombstoned here ahead of it.
        // A delete that finished since the pool was read already removed the asset.
        const result = await deleteMediaAnywhere(item.kind, item.assetId, { forgetInMusicVideos: false })
          .catch((err) => { if (err?.code === 'NOT_FOUND') return { status: 'deleted' }; throw err; });
        results.push({ kind: item.kind, assetId: item.assetId, ...result });
        if (poolCopyGone(result)) forget.push(`${item.kind}:${item.assetId}`);
      }
    } finally {
      // Even when a later deletion fails, forget the completed prefix. Keep the
      // failed item's evidence, and let the original error reach the caller.
      if (forget.length) await forgetDeletedMusicVideoAssets(forget, admitted);
    }
    return { deleted: forget.length, items: results };
  }));
}
