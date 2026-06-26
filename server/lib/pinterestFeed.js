/**
 * Pinterest board RSS — pure URL normalization + feed parsing (no I/O).
 *
 * A public Pinterest board exposes an RSS feed at `<board-url>.rss` (e.g.
 * `https://www.pinterest.com/user/board.rss`). The feed returns the board's
 * most-recent pins only (Pinterest caps it at ~the latest 25), NOT the full
 * board — the mood-board importer surfaces that limit in the UI. Each `<item>`
 * carries the pin's permalink (`<link>`) plus an image, which Pinterest places
 * in one of a few spots (`<media:content>`, `<enclosure>`, or an `<img>` inside
 * the HTML `<description>`); we probe all three.
 *
 * Kept pure (string in → data out) so the parsing + URL rules are unit-tested
 * without a network. The fetching/SSRF-guarding lives in `safeUrlFetch.js` and
 * the download/persist orchestration in `services/moodBoard/pinterest.js`.
 */

import { ServerError } from './errorHandler.js';

// Two-part public suffixes Pinterest's country domains use, so the registrable
// label sits one level deeper (pinterest.co.uk → "pinterest" is third-from-last).
const TWO_PART_TLDS = new Set([
  'co.uk', 'com.au', 'co.nz', 'com.br', 'com.mx', 'co.jp', 'co.kr', 'com.tr',
]);

// `pinterest` must be the REGISTRABLE domain, not merely a subdomain LABEL of an
// attacker host. A plain `pinterest.<tld>` and `pinterest.<sub>.<tld>` are
// structurally identical (`pinterest.co.uk` vs `pinterest.evil.com`), so a regex
// can't tell them apart without knowing the public suffix — hence the explicit
// two-part-TLD set. Accepts pinterest.com, www.pinterest.com, br.pinterest.com,
// pinterest.co.uk; rejects pinterest.evil.com, pinterest.com.evil.com,
// evilpinterest.com.
function isPinterestHost(host) {
  const labels = host.toLowerCase().split('.');
  if (labels.length < 2) return false;
  const lastTwo = labels.slice(-2).join('.');
  if (TWO_PART_TLDS.has(lastTwo)) {
    return labels.length >= 3 && labels[labels.length - 3] === 'pinterest';
  }
  return labels[labels.length - 2] === 'pinterest';
}

const badUrl = (msg) => new ServerError(msg, { status: 400, code: 'INVALID_PINTEREST_URL' });

/**
 * Normalize a user-supplied Pinterest board URL (or an already-`.rss` feed URL)
 * into `{ feedUrl, boardUrl }`. Accepts the human board URL and appends `.rss`;
 * passes a `.rss` URL through. Throws a 400 ServerError for a non-URL, a
 * non-http(s) scheme, a non-Pinterest host, or a board-less root path.
 */
export function normalizePinterestFeedUrl(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw badUrl('A Pinterest board URL is required');
  }
  let u;
  try { u = new URL(input.trim()); } catch { throw badUrl('Not a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw badUrl('Pinterest URL must be http(s)');
  }
  const host = u.hostname.toLowerCase();
  if (!isPinterestHost(host)) {
    throw badUrl('That doesn’t look like a Pinterest board URL');
  }
  // A board lives at /<user>/<board>/ and its feed at /<user>/<board>.rss.
  const path = u.pathname.replace(/\/+$/, '');
  if (!path) {
    throw badUrl('Include the board path, e.g. pinterest.com/user/board');
  }
  const isRss = path.toLowerCase().endsWith('.rss');
  const feedPath = isRss ? path : `${path}.rss`;
  const boardPath = isRss ? path.slice(0, -'.rss'.length) : path;
  return {
    feedUrl: `https://${host}${feedPath}`,
    boardUrl: `https://${host}${boardPath}/`,
  };
}

// Minimal HTML-entity decode for URLs/titles pulled out of the feed (the
// feed escapes `&` as `&amp;` inside attribute values, which would corrupt an
// image URL's query string if left encoded).
const decodeEntities = (s) => (typeof s === 'string'
  ? s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").trim()
  : s);

// Non-greedy single-tag text extractor (CDATA-aware). Mirrors feeds.js's
// extractTag; kept local because the Pinterest parser also needs the RAW
// (un-stripped) <description> HTML to dig the <img> out of, which feeds.js's
// HTML-stripping reader discards.
const extractTag = (xml, tag) => {
  const re = new RegExp(`<${tag}[^>]*>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : '';
};

const stripHtml = (html) => html
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
  .replace(/\s+/g, ' ')
  .trim();

// Pull the pin's image URL from whichever of the three slots the feed used.
function extractImageUrl(block, rawDescription) {
  const media = block.match(/<media:content[^>]*\burl=["']([^"']+)["']/i);
  if (media) return media[1];
  const enclosure = block.match(/<enclosure\b[^>]*\burl=["']([^"']+)["'][^>]*>/i);
  if (enclosure) return enclosure[1];
  const img = rawDescription.match(/<img[^>]*\bsrc=["']([^"']+)["']/i);
  if (img) return img[1];
  return '';
}

// Pinterest serves a pin's image at several widths under a size segment in the
// path (`/236x/`, `/474x/`, `/736x/`, `/originals/`). The RSS feed links the
// small 236x thumbnail; bump it to 736x for a board-worthy resolution. Leaves
// `/originals/` and already-large paths untouched. Caller keeps the original as
// a download fallback in case the upsized variant 404s.
function upgradePinImageSize(url) {
  return url.replace(/\/\d{2,4}x\//, '/736x/');
}

/**
 * Parse a Pinterest board RSS document into pins. Skips any item missing a
 * permalink or an image. Returns `[{ pinUrl, imageUrl, imageUrlOriginal, title,
 * description, pubDate }]` — `pinUrl` is the dedupe key the importer stores as
 * each board item's `source`.
 */
export function parsePinterestRss(xml) {
  if (typeof xml !== 'string' || !xml) return [];
  const channelMatch = xml.match(/<channel>([\s\S]*)<\/channel>/i);
  const channel = channelMatch ? channelMatch[1] : xml;
  const blocks = channel.match(/<item>([\s\S]*?)<\/item>/gi) || [];
  const pins = [];
  for (const block of blocks) {
    const pinUrl = decodeEntities(extractTag(block, 'link') || extractTag(block, 'guid'));
    const rawDescription = extractTag(block, 'description');
    const found = decodeEntities(extractImageUrl(block, rawDescription));
    if (!pinUrl || !found) continue;
    pins.push({
      pinUrl,
      imageUrl: upgradePinImageSize(found),
      imageUrlOriginal: found,
      title: stripHtml(extractTag(block, 'title')).slice(0, 500),
      description: stripHtml(rawDescription).slice(0, 500),
      pubDate: extractTag(block, 'pubDate'),
    });
  }
  return pins;
}
