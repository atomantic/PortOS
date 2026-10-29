/**
 * Gallery image deletion as one durable workflow: the image, its sidecars and
 * derived index row, then every universe canon `imageRefs[]` entry naming it
 * every media-collection row naming it, and every music video's unused takes,
 * marks and collection rows.
 * One backup admission spans both halves, so a snapshot cannot capture canon
 * rows that still reference bytes the delete has already removed.
 */
import { withBackupAssetPublication } from '../lib/backupSnapshotBoundary.js';
import { deleteImage } from './imageGen/local.js';
import { purgeImageRefFromAllUniverses } from './universeCanon.js';
import { removeItemFromAllCollections } from './mediaCollections.js';

// `fromRemoteTombstone` is passed through to deleteImage (see there).
export function deleteGalleryImage(filename, { forgetInMusicVideos = true, fromRemoteTombstone = false } = {}) {
  return withBackupAssetPublication(async () => {
    const result = await deleteImage(filename, { fromRemoteTombstone });
    // Best-effort: a purge failure must not fail the gallery delete itself.
    const universePurge = await purgeImageRefFromAllUniverses(filename).catch((err) => {
      console.warn(`⚠️ Universe canon purge failed for ${filename}: ${err?.message || err}`);
      return { removed: 0 };
    });
    if (universePurge.removed > 0) {
      console.log(`🧹 Purged ${universePurge.removed} canon ref(s) for ${filename}`);
    }
    // Collection rows feed the sharing exporter's media-job lookups, so a row
    // left behind warns on every re-export of its universe.
    const collectionsPurged = await removeItemFromAllCollections('image', filename).catch((err) => {
      console.warn(`⚠️ Media collection purge failed for ${filename}: ${err?.message || err}`);
      return 0;
    });
    // Music videos forget it too (their unused takes, marks and collection rows);
    // a batch delete from a video's asset manager forgets its whole batch at once.
    if (forgetInMusicVideos) await import('./musicVideo/mediaPool.js').then((m) => m.forgetDeletedMusicVideoAssets([`image:${filename}`]));
    return { ...result, canonRefsRemoved: universePurge.removed, collectionsPurged };
  });
}
