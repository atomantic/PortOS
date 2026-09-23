/**
 * X.com (Twitter) post URL + media — pure helpers (no I/O).
 *
 * `parseXPostUrl` validates a pasted post URL and reduces it to a status id
 * plus a username-independent canonical URL (the mood-board importer's
 * per-item dedupe key). `buildSyndicationUrl`/`syndicationToken` build the
 * request for Twitter's public, unauthenticated tweet-syndication endpoint —
 * the same one oEmbed-style embeds use, so a post's attached photos/video
 * resolve to direct CDN URLs without an API key or a headless browser.
 * `extractXPostMedia` reads that endpoint's JSON into `{ images, video }`.
 *
 * Kept pure (string/JSON in → data out) so the URL and extraction rules are
 * unit-tested without a network. The fetching/download orchestration lives in
 * `services/moodBoard/xPost.js`.
 */

import { ServerError } from './errorHandler.js';

// Explicit allow-list (mirrors pinterestFeed.js's registrable-domain check) so
// a lookalike host (x.com.evil.com, evil-x.com) can't slip past a loose
// "ends with x.com" test.
const X_DOMAINS = Object.freeze(['x.com', 'twitter.com']);

function isXHost(host) {
  const h = host.toLowerCase();
  return X_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

const badUrl = (msg) => new ServerError(msg, { status: 400, code: 'INVALID_X_POST_URL' });

/**
 * Validate + normalize a pasted x.com/twitter.com post URL into
 * `{ statusId, canonicalUrl }`. `canonicalUrl` drops the username segment
 * (`https://x.com/i/status/<id>`, which X itself resolves) so the same post
 * shared under a different handle still dedupes to one board item. Throws a
 * 400 ServerError for a non-URL, non-http(s) scheme, non-X host, or a path
 * that isn't `/<user>/status/<id>`.
 */
export function parseXPostUrl(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw badUrl('An x.com post URL is required');
  }
  let u;
  try { u = new URL(input.trim()); } catch { throw badUrl('Not a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw badUrl('URL must be http(s)');
  }
  if (!isXHost(u.hostname)) {
    throw badUrl('That doesn’t look like an x.com/twitter.com post URL');
  }
  const match = u.pathname.match(/^\/[^/]+\/status\/(\d+)(?:\/|$)/);
  if (!match) {
    throw badUrl('Include the full post URL, e.g. x.com/user/status/1234567890');
  }
  const statusId = match[1];
  return { statusId, canonicalUrl: `https://x.com/i/status/${statusId}` };
}

/**
 * The syndication endpoint's access token is derived from the status id by a
 * fixed public formula (used by oEmbed-style embed widgets) — not a secret,
 * just an anti-abuse checksum. `Number(statusId)` loses precision for the
 * largest snowflake ids (>2^53), matching the same known limitation every
 * public consumer of this formula has; a resulting fetch failure surfaces as
 * the normal "could not fetch that post" error rather than a crash.
 */
export function syndicationToken(statusId) {
  return ((Number(statusId) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

export function buildSyndicationUrl(statusId) {
  return `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(statusId)}&token=${syndicationToken(statusId)}&lang=en`;
}

/**
 * Read the syndication endpoint's JSON into `{ images: string[], video:
 * {url, poster}|null }`. A post carries EITHER photos OR a video/GIF, never
 * both (X's own constraint), but this reads whichever is present without
 * assuming which. `video.variants` may list multiple encodings (mp4 +
 * HLS/`application/x-mpegURL`); only mp4 is downloadable via a plain fetch, so
 * the highest-bitrate mp4 variant is picked. Returns `{ images: [], video:
 * null }` for a malformed/empty payload rather than throwing — the caller
 * decides that's "no media" (400), not a parse crash.
 */
export function extractXPostMedia(json) {
  if (!json || typeof json !== 'object') return { images: [], video: null };
  const images = Array.isArray(json.photos)
    ? json.photos.map((p) => p?.url).filter((u) => typeof u === 'string' && u)
    : [];
  let video = null;
  const variants = json.video?.variants;
  if (Array.isArray(variants)) {
    const mp4Variants = variants.filter((v) => v?.type === 'video/mp4' && typeof v.src === 'string' && v.src);
    if (mp4Variants.length) {
      const best = mp4Variants.reduce((a, b) => ((b.bitrate || 0) > (a.bitrate || 0) ? b : a));
      video = { url: best.src, poster: typeof json.video.poster === 'string' ? json.video.poster : null };
    }
  }
  return { images, video };
}
