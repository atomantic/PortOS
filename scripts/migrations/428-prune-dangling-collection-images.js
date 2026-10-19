/** Drop media-collection image rows whose file no longer exists in the gallery.
 * Gallery deletes used to leave them behind, so every sharing export of the
 * owning universe warned about the missing asset. Input-gated on the
 * collections and the gallery directory; ships no seed. Bumps `updatedAt`, but
 * writes no per-item removal record: item lists union on merge, so a peer that
 * still lists a pruned image re-adds it on the next sync. Only removals made
 * through the service (which records `removedItems`, #12433) stick. Retired
 * (#12398): run-migrations.js records it as applied without running it. */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from './_lib.js';

const readdirOrNull = (dir) => readdir(dir).catch((error) => {
  if (error.code === 'ENOENT') return null;
  throw error;
});

export default {
  async up({ rootDir }) {
    const collectionsDir = join(rootDir, 'data', 'media-collections');
    const ids = await readdirOrNull(collectionsDir);
    // No gallery directory means we cannot tell deleted from never-synced: leave everything.
    const imageFiles = await readdirOrNull(join(rootDir, 'data', 'images'));
    if (!ids || !imageFiles) return { collections: 0, removed: 0 };
    const present = new Set(imageFiles);
    let collections = 0;
    let removed = 0;
    for (const id of ids) {
      const path = join(collectionsDir, id, 'index.json');
      const raw = await readFile(path, 'utf8').catch((error) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
        throw error;
      });
      if (raw === null) continue;
      let collection;
      try { collection = JSON.parse(raw); } catch { continue; }
      if (!collection || collection.deleted === true || !Array.isArray(collection.items)) continue;
      const items = collection.items.filter((item) => !(item?.kind === 'image' && typeof item.ref === 'string' && !present.has(item.ref)));
      const dropped = collection.items.length - items.length;
      if (dropped === 0) continue;
      const coverGone = typeof collection.coverKey === 'string' && !items.some((item) => `${item.kind}:${item.ref}` === collection.coverKey);
      await writeJsonAtomic(path, {
        ...collection,
        items,
        coverKey: coverGone ? null : collection.coverKey,
        updatedAt: new Date().toISOString(),
      });
      collections++;
      removed += dropped;
    }
    return { collections, removed };
  }
};
