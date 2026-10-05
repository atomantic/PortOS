/**
 * Mood Board — re-host external media.
 *
 * A board should never serve a remote URL: link rot, hotlink blocks, and the
 * fact that prompt-from-media can only read local gallery files. Any image (or
 * video poster) item whose `imageUrl` is http(s) is downloaded into
 * `data/images/` and the item is repointed at the local copy, so it federates
 * as a normal board asset and becomes analyzable. A URL that fails to download
 * (or isn't an image) is left as-is and reported in `failed`.
 *
 * Downloads run OUTSIDE the board row lock; the swap lands in one locked write
 * that only touches items still carrying the URL the download was started for.
 */

import { createHash } from 'crypto';
import { join } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS, ensureDir, detectImageFormat, writeFileGuarded } from '../../lib/fileUtils.js';
import { fetchPublicBinary } from '../../lib/safeUrlFetch.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { emitRecordUpdated } from '../sharing/recordEvents.js';
import { externalImageItems, isExternalImageUrl } from './logic.js';
import * as store from './db.js';

const IMAGE_TIMEOUT_MS = 20000;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const DOWNLOAD_CONCURRENCY = 3;
const UA = 'Mozilla/5.0 (compatible; PortOS Mood Board/1.0; +https://github.com/atomantic/PortOS)';
const IMAGE_HEADERS = { 'User-Agent': UA, Accept: 'image/*' };

/**
 * Download one remote image into the gallery. Returns its served path
 * (`/data/images/<file>`) or null on any failure (unreachable, blocked host,
 * non-image body). The filename is keyed on the URL so repeats are idempotent;
 * the format is sniffed from bytes, never trusted from Content-Type.
 */
async function downloadExternalImage(url) {
  const res = await fetchPublicBinary(url.trim(), { timeoutMs: IMAGE_TIMEOUT_MS, headers: IMAGE_HEADERS, maxBytes: MAX_IMAGE_BYTES, throwOnUnsafe: false }).catch(() => null);
  if (!res?.buffer?.length) return null;
  const fmt = detectImageFormat(res.buffer);
  if (!fmt) return null;
  const filename = `board-${createHash('sha1').update(url.trim()).digest('hex').slice(0, 16)}${fmt.ext}`;
  await ensureDir(PATHS.images);
  // URL-keyed, so a repeat rewrites bytes a board may already name: hold the
  // backup lease (#9982) so the in-place write never overlaps a snapshot.
  await withBackupAssetPublication(() => writeFileGuarded(join(PATHS.images, filename), res.buffer));
  return `/data/images/${filename}`;
}

/** Re-host a single item's image input for an add/update; falls back to the original URL. */
export async function localizeImageUrl(imageUrl) {
  if (!isExternalImageUrl(imageUrl)) return imageUrl;
  return (await downloadExternalImage(imageUrl)) || imageUrl;
}

/**
 * Re-host every external image on a board. Returns `{ board, localized, failed }`.
 * Throws 404 when the board doesn't exist.
 */
export async function localizeBoardMedia(boardId) {
  const board = await store.getBoard(boardId);
  if (!board) throw new ServerError('Mood board not found', { status: 404, code: 'NOT_FOUND' });
  const targets = externalImageItems(board);
  if (!targets.length) return { board, localized: 0, failed: 0 };

  const replacements = [];
  let failed = 0;
  for (let i = 0; i < targets.length; i += DOWNLOAD_CONCURRENCY) {
    const batch = targets.slice(i, i + DOWNLOAD_CONCURRENCY);
    const results = await Promise.all(batch.map(async (item) => ({ item, to: await downloadExternalImage(item.imageUrl) })));
    for (const { item, to } of results) {
      if (to) replacements.push({ id: item.id, from: item.imageUrl, to });
      else failed += 1;
    }
  }

  // The swap first names the downloaded files, so it commits under the lease.
  const { board: next, changed } = await withBackupAssetPublication(() => store.applyLocalizedItemImages(boardId, replacements));
  if (changed) emitRecordUpdated('moodBoard', boardId);
  console.log(`🖼️ Mood board ${boardId}: re-hosted ${changed} external image(s)${failed ? `, ${failed} failed` : ''}`);
  return { board: next, localized: changed, failed };
}
