/**
 * Mood Board — Pinterest importer (link + manual sync).
 *
 * A mood board can be linked to a public Pinterest board's RSS feed. "Sync now"
 * fetches the feed, downloads each NEW pin's image into the local gallery
 * (`data/images/`, so it federates as a normal board-item asset and survives
 * Pinterest link rot), and appends it as an image item — deduping by the pin
 * permalink stored as the item's `source`. The very first sync on a freshly
 * linked board pulls everything the feed exposes; later syncs add only what's
 * new. NOTE: Pinterest's RSS returns the most-recent pins only (~25), NOT the
 * full board — the UI states this; we never claim a complete backfill.
 *
 * Network I/O (feed fetch + image downloads) runs OUTSIDE the board row lock;
 * the resulting items land in a single locked `appendPinterestItems` write.
 * Re-exported through index.js (the public moodBoard entry) so the route imports
 * one module; the federation emit is fired here after each store mutation.
 */

import { createHash } from 'crypto';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS, ensureDir, detectImageFormat } from '../../lib/fileUtils.js';
import { normalizePinterestFeedUrl, parsePinterestRss } from '../../lib/pinterestFeed.js';
import { fetchPublicText, fetchPublicBinary } from '../../lib/safeUrlFetch.js';
import { emitRecordUpdated } from '../sharing/recordEvents.js';
import { MAX_ITEMS_PER_BOARD } from './logic.js';
import * as store from './db.js';

const FEED_TIMEOUT_MS = 20000;
const IMAGE_TIMEOUT_MS = 20000;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
// Pinterest 403s obviously-bot user-agents on its CDN; present a browsery one.
const PINTEREST_UA = 'Mozilla/5.0 (compatible; PortOS Mood Board/1.0; +https://github.com/atomantic/PortOS)';
const FEED_HEADERS = { 'User-Agent': PINTEREST_UA, Accept: 'application/rss+xml, application/xml, text/xml' };
const IMAGE_HEADERS = { 'User-Agent': PINTEREST_UA, Accept: 'image/*' };
// One origin (i.pinimg.com) serves every pin and 403s bot-ish traffic, so keep
// the download fan-out small — fast enough for a 25-pin first sync, polite enough
// to avoid rate-limiting. The caller ensures data/images/ exists once up front.
const DOWNLOAD_CONCURRENCY = 3;

/**
 * Download a pin's image into data/images/ and return its served path
 * (`/data/images/<file>`), or null on failure. Tries the upsized (736x) URL
 * first, falling back to the original feed URL if it 404s. The filename is keyed
 * on the pin permalink so re-downloading the same pin is idempotent. Format +
 * extension are sniffed from the actual bytes (via detectImageFormat), which
 * also rejects a non-image body (an error/HTML page served with 200) — more
 * trustworthy than Pinterest's Content-Type header.
 */
async function downloadPinImage({ pinUrl, imageUrl, imageUrlOriginal }) {
  let res = await fetchPublicBinary(imageUrl, { timeoutMs: IMAGE_TIMEOUT_MS, headers: IMAGE_HEADERS, maxBytes: MAX_IMAGE_BYTES });
  if (!res?.buffer?.length && imageUrlOriginal && imageUrlOriginal !== imageUrl) {
    res = await fetchPublicBinary(imageUrlOriginal, { timeoutMs: IMAGE_TIMEOUT_MS, headers: IMAGE_HEADERS, maxBytes: MAX_IMAGE_BYTES });
  }
  if (!res?.buffer?.length) return null;
  const fmt = detectImageFormat(res.buffer);
  if (!fmt) return null;
  const filename = `pinterest-${createHash('sha1').update(pinUrl).digest('hex').slice(0, 16)}${fmt.ext}`;
  await writeFile(join(PATHS.images, filename), res.buffer);
  return `/data/images/${filename}`;
}

/**
 * Link a board to a Pinterest board URL (or `.rss` feed URL). Validates +
 * normalizes the URL (throws 400 on a non-Pinterest host) and stores the link.
 */
export async function linkPinterestBoard(boardId, { url }) {
  const { feedUrl, boardUrl, isSection } = normalizePinterestFeedUrl(url);
  const board = await store.setPinterestLink(boardId, { feedUrl, boardUrl });
  emitRecordUpdated('moodBoard', boardId);
  console.log(`📌 Pinterest link set: board ${boardId} → ${feedUrl}${isSection ? ' (section URL — feed covers the whole board; Pinterest has no per-section RSS)' : ''}`);
  return board;
}

export async function unlinkPinterestBoard(boardId) {
  const board = await store.clearPinterestLink(boardId);
  emitRecordUpdated('moodBoard', boardId);
  return board;
}

/**
 * Sync the linked Pinterest board: fetch the feed, download every NEW pin's
 * image, append them in one locked write. Returns `{ board, added, skipped,
 * feedCount }`. Throws 404 (no board), 400 (not linked), or 502 (feed
 * unreachable).
 */
export async function syncPinterestBoard(boardId) {
  let board = await store.getBoard(boardId);
  if (!board) throw new ServerError('Mood board not found', { status: 404, code: 'NOT_FOUND' });
  if (!board.pinterest?.feedUrl) throw new ServerError('This board is not linked to a Pinterest board', { status: 400, code: 'NOT_LINKED' });

  // Self-heal links saved before section detection: a section URL was stored with
  // a `/user/board/section.rss` feed that Pinterest serves as HTML (0 pins). Re-
  // normalize the stored link (preferring the displayed boardUrl, which retains
  // the section path) and persist the corrected board-level feed in place. The
  // heal is guarded under lock (healPinterestFeed) so it can't resurrect/clobber
  // a link the user unlinked or repointed concurrently — same re-entrancy guard
  // the locked append below uses via expectedFeedUrl.
  const staleFeedUrl = board.pinterest.feedUrl;
  const { feedUrl: healedFeedUrl, boardUrl: healedBoardUrl } =
    normalizePinterestFeedUrl(board.pinterest.boardUrl || staleFeedUrl);
  if (healedFeedUrl !== staleFeedUrl) {
    const { board: healed, changed } = await store.healPinterestFeed(boardId, {
      fromFeedUrl: staleFeedUrl, feedUrl: healedFeedUrl, boardUrl: healedBoardUrl,
    });
    board = healed;
    if (changed) {
      // The heal persisted a feed-URL correction — emit now so federation/UI
      // pick it up even if the fetch below fails (otherwise peers keep the stale
      // section feed until a later successful sync).
      emitRecordUpdated('moodBoard', boardId);
      console.log(`📌 Pinterest sync: board ${boardId} feed corrected to ${healedFeedUrl} (section URL has no RSS)`);
    }
  }
  // This sync is committed to `healedFeedUrl` (== staleFeedUrl when no heal was
  // needed). If a concurrent unlink/repoint during the heal left the persisted
  // board on a different feed, abort rather than sync a feed this run wasn't
  // started for — same guard the locked append applies via expectedFeedUrl.
  const feedUrl = healedFeedUrl;
  if (board.pinterest?.feedUrl !== feedUrl) {
    console.log(`📌 Pinterest sync: board ${boardId} aborted — link changed mid-sync`);
    return { board, added: 0, feedCount: 0, aborted: true };
  }

  const xml = await fetchPublicText(feedUrl, { timeoutMs: FEED_TIMEOUT_MS, headers: FEED_HEADERS });
  if (!xml) throw new ServerError('Could not fetch the Pinterest feed (it may be private or rate-limited)', { status: 502, code: 'FEED_FETCH_FAILED' });

  const pins = parsePinterestRss(xml);
  const items = Array.isArray(board.items) ? board.items : [];
  const seen = new Set(items.map((it) => it?.source).filter(Boolean));
  const capacity = Math.max(0, MAX_ITEMS_PER_BOARD - items.length);
  // Pre-dedupe by pin permalink BEFORE downloading so we don't fetch images we'd
  // discard, and cap to remaining board capacity to avoid orphan downloads.
  const candidates = pins.filter((p) => p.pinUrl && !seen.has(p.pinUrl)).slice(0, capacity);

  // Download in small concurrent batches (preserving feed order) instead of one
  // at a time — the candidates are independent, sha1-named by permalink.
  await ensureDir(PATHS.images);
  const imported = [];
  for (let i = 0; i < candidates.length; i += DOWNLOAD_CONCURRENCY) {
    const batch = candidates.slice(i, i + DOWNLOAD_CONCURRENCY);
    const results = await Promise.all(batch.map(async (pin) => {
      const localUrl = await downloadPinImage(pin);
      return localUrl ? { imageUrl: localUrl, caption: pin.title || pin.description || null, source: pin.pinUrl } : null;
    }));
    for (const r of results) if (r) imported.push(r);
  }

  // Pass the feed we actually fetched so the locked append aborts if the user
  // unlinked / repointed the board while downloads ran (fetch is outside the lock).
  const syncedAt = new Date().toISOString();
  const { board: nextBoard, added, aborted } = await store.appendPinterestItems(boardId, imported, { syncedAt, expectedFeedUrl: feedUrl });
  if (aborted) {
    console.log(`📌 Pinterest sync: board ${boardId} aborted — link changed mid-sync`);
    return { board: nextBoard, added: 0, feedCount: pins.length, aborted: true };
  }
  emitRecordUpdated('moodBoard', boardId);
  console.log(`📌 Pinterest sync: board ${boardId} +${added} new (${pins.length} pins in feed)`);
  return { board: nextBoard, added, feedCount: pins.length };
}
