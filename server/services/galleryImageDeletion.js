/**
 * Gallery image deletion as one durable workflow: the image, its sidecars and
 * derived index row, then every universe canon `imageRefs[]` entry naming it.
 * One backup admission spans both halves, so a snapshot cannot capture canon
 * rows that still reference bytes the delete has already removed.
 */
import { withBackupAssetPublication } from '../lib/backupSnapshotBoundary.js';
import { deleteImage } from './imageGen/local.js';
import { purgeImageRefFromAllUniverses } from './universeCanon.js';

export function deleteGalleryImage(filename) {
  return withBackupAssetPublication(async () => {
    const result = await deleteImage(filename);
    // Best-effort: a purge failure must not fail the gallery delete itself.
    const universePurge = await purgeImageRefFromAllUniverses(filename).catch((err) => {
      console.warn(`⚠️ Universe canon purge failed for ${filename}: ${err?.message || err}`);
      return { removed: 0 };
    });
    if (universePurge.removed > 0) {
      console.log(`🧹 Purged ${universePurge.removed} canon ref(s) for ${filename}`);
    }
    return { ...result, canonRefsRemoved: universePurge.removed };
  });
}
