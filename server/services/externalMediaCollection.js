/**
 * Files media downloaded from outside sources into the shared "External"
 * collection, and backfills files already on disk once per install.
 *
 * Live filing: the Video Downloader (YouTube / X) and the Mood Board importers
 * (Pinterest, X posts, pasted image URLs) call `fileExternalMedia` after a
 * download lands. Best-effort bookkeeping: a failure is logged, never thrown,
 * so a collection problem never fails the download itself.
 *
 * Backfill: on boot, if this install has not yet backfilled, the downloads
 * already on disk are filed once and a local marker is written. Running only
 * once means an item the user later removes from the collection stays removed.
 */

import { join } from 'path';
import { readdir, writeFile, access } from 'fs/promises';
import { PATHS } from '../lib/fileUtils.js';

// Filename shapes the downloaders write (see videoDownload.js, moodBoard/
// pinterest.js, moodBoard/xPost.js, moodBoard/localize.js).
const EXTERNAL_IMAGE_RE = /^(pinterest|x|board)-[0-9a-f]{16}\.(png|jpe?g|gif|webp)$/i;
const EXTERNAL_VIDEO_RE = /^x-[0-9a-f]{16}\.mp4$/i;
const BACKFILL_MARKER = 'external-collection-backfill.json';

/** Add items (`{ kind: 'image'|'video', ref }`) to the External collection. Never throws. */
export async function fileExternalMedia(items) {
  const add = (items || []).filter((it) => it && typeof it.ref === 'string' && it.ref);
  if (!add.length) return null;
  try {
    const { findOrCreateExternalCollection, bulkUpdateCollectionItems } = await import('./mediaCollections.js');
    const collection = await findOrCreateExternalCollection();
    const { added } = await bulkUpdateCollectionItems(collection.id, { add });
    if (added) console.log(`🗂️ External collection: filed ${added} downloaded item(s)`);
    return added;
  } catch (err) {
    console.error(`❌ External collection filing failed: ${err?.message || err}`);
    return null;
  }
}

const listDir = (dir) => readdir(dir).catch((err) => { if (err.code === 'ENOENT') return []; throw err; });

/** Every download already on this machine, as collection items. */
export async function collectExistingExternalMedia() {
  const { loadHistory } = await import('./videoGen/history.js');
  const [images, videos, history] = await Promise.all([listDir(PATHS.images), listDir(PATHS.videos), loadHistory()]);
  const downloads = (Array.isArray(history) ? history : []).filter((h) => h?.source === 'download' && typeof h.id === 'string');
  return [
    ...images.filter((f) => EXTERNAL_IMAGE_RE.test(f)).map((ref) => ({ kind: 'image', ref })),
    ...videos.filter((f) => EXTERNAL_VIDEO_RE.test(f)).map((ref) => ({ kind: 'video', ref })),
    ...downloads.map((h) => ({ kind: 'video', ref: h.id })),
  ];
}

/** One-time per-install backfill of downloads already on disk. */
export async function backfillExternalMediaCollection({ markerDir = PATHS.data } = {}) {
  const marker = join(markerDir, BACKFILL_MARKER);
  if (await access(marker).then(() => true, () => false)) return { skipped: true };
  const { ITEMS_MAX } = await import('./mediaCollections.js');
  // Over the cap the batch would be refused outright; keep the newest-listed slice.
  const items = (await collectExistingExternalMedia()).slice(0, ITEMS_MAX);
  const added = items.length ? await fileExternalMedia(items) : 0;
  // A failed filing (null) leaves no marker so the next boot retries.
  if (added === null) return { skipped: false, added: 0, failed: true };
  await writeFile(marker, `${JSON.stringify({ backfilledAt: new Date().toISOString(), items: items.length })}\n`);
  console.log(`🗂️ External collection backfill: ${items.length} existing download(s) found, ${added} filed`);
  return { skipped: false, added };
}
