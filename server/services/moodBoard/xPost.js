/**
 * Mood Board — X.com (Twitter) post importer.
 *
 * Paste a public x.com/twitter.com post URL and pull its attached photos/video
 * into the board as re-hosted local assets — mirrors the Pinterest importer's
 * "fetch → download → dedupe → append in one locked write" shape (pinterest.js),
 * but this is a ONE-SHOT import, not a persisted link+sync: there's no ongoing
 * feed to track, so nothing is stored on the board beyond the resulting items.
 *
 * Uses Twitter's public, unauthenticated tweet-syndication endpoint (the same
 * one oEmbed-style embeds use) to read a post's attached media without an API
 * key, a scraper, or a headless browser (xPostMedia.js owns that parsing, pure
 * and unit-tested). Both a post's photos and its video/GIF resolve to direct
 * CDN URLs, downloaded through the same SSRF-guarded fetch Pinterest uses and
 * re-hosted under data/images / data/videos so the board survives link rot.
 */

import { createHash } from 'crypto';
import { unlink } from 'fs/promises';
import { join, basename } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS, ensureDir, detectImageFormat, detectVideoFormat, writeFileGuarded } from '../../lib/fileUtils.js';
import { parseXPostUrl, buildSyndicationUrl, extractXPostMedia } from '../../lib/xPostMedia.js';
import { fetchPublicText, fetchPublicBinary } from '../../lib/safeUrlFetch.js';
import { emitRecordUpdated } from '../sharing/recordEvents.js';
import { MAX_ITEMS_PER_BOARD } from './logic.js';
import * as store from './db.js';

const FETCH_TIMEOUT_MS = 20000;
const VIDEO_TIMEOUT_MS = 60000;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
// X's CDN (like Pinterest's) 403s obviously-bot user-agents; present a browsery one.
const X_UA = 'Mozilla/5.0 (compatible; PortOS Mood Board/1.0; +https://github.com/atomantic/PortOS)';
const JSON_HEADERS = { 'User-Agent': X_UA, Accept: 'application/json' };
const MEDIA_HEADERS = { 'User-Agent': X_UA, Accept: '*/*' };

function fingerprint(canonicalUrl, tag) {
  return createHash('sha1').update(`${canonicalUrl}#${tag}`).digest('hex').slice(0, 16);
}

// Download an image (photo or video poster) into data/images/, sniffing the
// format from bytes (never trusting Content-Type) — same posture as Pinterest's
// downloadPinImage. Returns the served path, or null on any failure.
async function downloadImage(url, canonicalUrl, tag) {
  const res = await fetchPublicBinary(url, { timeoutMs: FETCH_TIMEOUT_MS, headers: MEDIA_HEADERS, maxBytes: MAX_IMAGE_BYTES });
  if (!res?.buffer?.length) return null;
  const fmt = detectImageFormat(res.buffer);
  if (!fmt) return null;
  const filename = `x-${fingerprint(canonicalUrl, tag)}${fmt.ext}`;
  await writeFileGuarded(join(PATHS.images, filename), res.buffer);
  return `/data/images/${filename}`;
}

// Download the post's video/GIF (X serves a looping GIF as an mp4) into
// data/videos/, sniffing the container from bytes (X's video CDN doesn't
// reliably set Content-Type). Returns the on-disk FILENAME (not a served path
// — video items' mediaKey carries the filename, matching
// handlePickGalleryVideo's shape), or null on any failure.
async function downloadVideo(url, canonicalUrl) {
  const res = await fetchPublicBinary(url, { timeoutMs: VIDEO_TIMEOUT_MS, headers: MEDIA_HEADERS, maxBytes: MAX_VIDEO_BYTES });
  if (!res?.buffer?.length || !detectVideoFormat(res.buffer)) return null;
  const filename = `x-${fingerprint(canonicalUrl, 'video')}.mp4`;
  await writeFileGuarded(join(PATHS.videos, filename), res.buffer);
  return filename;
}

/**
 * Import a public x.com/twitter.com post's photos/video into a board. Fetches
 * the post's attached media via Twitter's public syndication endpoint (no API
 * key), downloads each into the local gallery, and appends the new items in
 * one locked write — deduping by a per-item `source` (`<canonical post
 * url>#0`, `#video`, …) so re-importing the same post is a no-op. Downloads run
 * OUTSIDE the board row lock, same as the Pinterest sync.
 *
 * Throws 404 (no board), 400 (not an x.com/twitter.com post URL, or the post
 * has no photos/video attached), or 502 (the post or its media couldn't be
 * fetched).
 *
 * @returns {Promise<{ board: object, added: number }>}
 */
export async function importXPost(boardId, { url }) {
  const { statusId, canonicalUrl } = parseXPostUrl(url);

  // Independent lookups (board row vs. the post's media) — run concurrently.
  const [board, raw] = await Promise.all([
    store.getBoard(boardId),
    fetchPublicText(buildSyndicationUrl(statusId), { timeoutMs: FETCH_TIMEOUT_MS, headers: JSON_HEADERS }),
  ]);
  if (!board) throw new ServerError('Mood board not found', { status: 404, code: 'NOT_FOUND' });
  if (!raw) {
    throw new ServerError('Could not fetch that post (it may be private, deleted, or rate-limited)', {
      status: 502, code: 'X_POST_FETCH_FAILED',
    });
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ServerError('Could not read that post’s media', { status: 502, code: 'X_POST_FETCH_FAILED' });
  }

  const { images, video } = extractXPostMedia(json);
  if (!images.length && !video) {
    throw new ServerError('That post has no photos or video attached', { status: 400, code: 'NO_MEDIA_FOUND' });
  }

  const items = Array.isArray(board.items) ? board.items : [];
  const seen = new Set(items.map((it) => it?.source).filter(Boolean));
  const capacity = Math.max(0, MAX_ITEMS_PER_BOARD - items.length);

  await ensureDir(PATHS.images);
  const imported = [];
  for (let i = 0; i < images.length && imported.length < capacity; i++) {
    const source = `${canonicalUrl}#${i}`;
    if (seen.has(source)) continue;
    const imageUrl = await downloadImage(images[i], canonicalUrl, String(i));
    if (imageUrl) imported.push({ type: 'image', imageUrl, source, caption: null });
  }
  if (video && imported.length < capacity) {
    const source = `${canonicalUrl}#video`;
    if (!seen.has(source)) {
      await ensureDir(PATHS.videos);
      // The video body and its poster are independent CDN downloads — run
      // them concurrently rather than one after the other.
      const [filename, poster] = await Promise.all([
        downloadVideo(video.url, canonicalUrl),
        video.poster ? downloadImage(video.poster, canonicalUrl, 'poster') : Promise.resolve(null),
      ]);
      if (filename) {
        imported.push({ type: 'video', mediaKey: `video:${filename}`, imageUrl: poster, source, caption: null });
      } else if (poster) {
        // The video failed but its poster downloaded first (they ran in
        // parallel) — nothing will ever reference it, so remove it rather
        // than leaving an orphaned file in data/images.
        await unlink(join(PATHS.images, basename(poster))).catch(() => {});
      }
    }
  }

  if (!imported.length) {
    throw new ServerError('Could not download that post’s media (the CDN links may have expired or be geo-restricted)', {
      status: 502, code: 'X_POST_DOWNLOAD_FAILED',
    });
  }

  const { board: nextBoard, added } = await store.appendImportedItems(boardId, imported);
  emitRecordUpdated('moodBoard', boardId);
  console.log(`🐦 X post import: board ${boardId} +${added} item(s) from ${canonicalUrl}`);
  return { board: nextBoard, added };
}
