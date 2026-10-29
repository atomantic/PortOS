/**
 * The gallery image sidecar store: read one `<stem>.metadata.json` (or the
 * `<file>.metadata.json` spelling), and edit it under the per-file queue every
 * sidecar writer shares. Kept light so the sync paths can serialize their own
 * sidecar edits (e.g. the supplier a pull records) with prompt and visibility
 * edits, without loading the render graph in local.js.
 */
import { join } from 'path';
import { stat } from 'fs/promises';
import { atomicWrite, PATHS, safeJSONParse, tryReadFile } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { createKeyCachedQueue } from '../../lib/createKeyCachedQueue.js';

// Returns `{ path, metadata }`. `path` is the resolved sidecar location, or
// the preferred Portos location on miss — callers writing back land at the
// canonical path automatically.
export async function readImageSidecar(filename) {
  const portosSidecar = join(PATHS.images, filename.replace('.png', '.metadata.json'));
  const altSidecar = join(PATHS.images, `${filename}.metadata.json`);
  for (const path of [portosSidecar, altSidecar]) {
    const raw = await tryReadFile(path);
    if (raw != null) return { path, metadata: safeJSONParse(raw, {}) };
  }
  return { path: portosSidecar, metadata: {} };
}

export async function refreshImageIndex(filename) {
  await import('../mediaAssetIndex/index.js')
    .then(m => m.indexImage({ filename }))
    .catch(err => console.error(`❌ Media index image refresh failed: ${err.message}`));
}

// Sidecar edits are whole-file read→modify→replace cycles; atomicWrite stops a
// torn file but not two edits (prompt + visibility) reading the same copy and
// the later write dropping the earlier field. One tail per gallery filename
// covers both sidecar spellings, and the index refresh stays inside the turn.
export const sidecarEditQueue = createKeyCachedQueue();

// `mutate` edits the metadata in place; returning null leaves the file as it was.
// `reindex: false` skips the index refresh for non-searchable fields (the hash cache).
// Gallery (`.png`) filenames only: the `.png` → `.metadata.json` spelling above.
export function editImageSidecar(filename, mutate, { reindex = true } = {}) {
  // Admit before joining the queue so a cut drains every already-requested
  // edit, including one waiting for an earlier edit's index refresh.
  return withBackupAssetPublication(() => sidecarEditQueue(filename, async () => {
    const { path: sidecarPath, metadata } = await readImageSidecar(filename);
    const result = mutate(metadata);
    if (result === null) return null;
    // A stale edit queued after deletion must not recreate its sidecar/index.
    // Sidecar-only records remain editable while peer media bytes are pending.
    const present = await Promise.all([
      join(PATHS.images, filename),
      join(PATHS.images, filename.replace(/\.png$/i, '.metadata.json')),
      join(PATHS.images, `${filename}.metadata.json`),
    ].map(path => stat(path).then(() => true, error => {
      if (error.code === 'ENOENT') return false;
      throw error;
    })));
    if (!present.some(Boolean)) throw new ServerError('Image not found', { status: 404, code: 'NOT_FOUND' });
    await atomicWrite(sidecarPath, metadata);
    if (reindex) await refreshImageIndex(filename);
    return result;
  }));
}
