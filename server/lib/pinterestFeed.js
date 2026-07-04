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
import { decodeXmlEntities } from './xmlEntities.js';

// Explicit allow-list of Pinterest's REGISTRABLE domains. A registrable-label
// check ("second-to-last label is pinterest") is NOT enough: an attacker can
// register `pinterest.zip`, `pinterest.app`, etc. (real TLDs), and the importer
// would then fetch/download from an arbitrary host the SSRF guard otherwise
// permits (it allows public hosts by design). Pinterest's RSS feeds all live on
// `pinterest.com`; the country domains redirect to it (and safeUrlFetch follows
// one validated redirect), but accept them so a pasted ccTLD board URL still
// works. A host matches when it equals one of these or is a subdomain of one.
const PINTEREST_DOMAINS = Object.freeze([
  'pinterest.com',
  'pinterest.co.uk', 'pinterest.ca', 'pinterest.fr', 'pinterest.de',
  'pinterest.es', 'pinterest.it', 'pinterest.pt', 'pinterest.nl',
  'pinterest.se', 'pinterest.dk', 'pinterest.at', 'pinterest.ch',
  'pinterest.ie', 'pinterest.nz', 'pinterest.co.nz', 'pinterest.ph',
  'pinterest.jp', 'pinterest.co.jp', 'pinterest.co.kr', 'pinterest.cl',
  'pinterest.com.au', 'pinterest.com.mx',
]);

// Accepts pinterest.com, www.pinterest.com, br.pinterest.com, pinterest.co.uk;
// rejects pinterest.zip, pinterest.evil.com, pinterest.com.evil.com,
// evilpinterest.com.
function isPinterestHost(host) {
  const h = host.toLowerCase();
  return PINTEREST_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

const badUrl = (msg) => new ServerError(msg, { status: 400, code: 'INVALID_PINTEREST_URL' });

/**
 * Normalize a user-supplied Pinterest board URL (or an already-`.rss` feed URL)
 * into `{ feedUrl, boardUrl, isSection }`. Accepts the human board URL and
 * appends `.rss`; passes a `.rss` URL through. Throws a 400 ServerError for a
 * non-URL, a non-http(s) scheme, a non-Pinterest host, or a board-less root path.
 *
 * Pinterest exposes an RSS feed ONLY for a top-level board (`/user/board.rss`),
 * NOT for a board *section* (`/user/board/section/`). Appending `.rss` to a
 * section path returns Pinterest's HTML page with a 200 (content-type text/html,
 * zero `<item>`s), which silently parses to 0 pins. So when the URL points at a
 * section (3+ path segments), we collapse the FEED to the parent board's RSS
 * while preserving the section URL the user pasted as `boardUrl` (for display /
 * "view on Pinterest"). The feed then returns the whole board's recent pins —
 * the best available, since Pinterest has no per-section feed — and `isSection`
 * lets callers surface that the sync isn't section-scoped.
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
  // Logical (no `.rss`) path → segments. A section is anything deeper than
  // /<user>/<board>; the RSS feed always lives at the first two segments.
  const logicalPath = isRss ? path.slice(0, -'.rss'.length) : path;
  const segments = logicalPath.split('/').filter(Boolean);
  const isSection = segments.length > 2;
  const feedPath = isSection ? `/${segments.slice(0, 2).join('/')}.rss` : `${logicalPath}.rss`;
  // Keep the section path the user pasted as the displayed board URL.
  return {
    feedUrl: `https://${host}${feedPath}`,
    boardUrl: `https://${host}${logicalPath}/`,
    isSection,
  };
}

// Minimal HTML-entity decode for URLs/titles pulled out of the feed (the
// feed escapes `&` as `&amp;` inside attribute values, which would corrupt an
// image URL's query string if left encoded). Trims, like the rest of the feed
// extractors. Numeric refs (`&#39;`, `&#039;`) are handled by the shared decoder.
const decodeEntities = (s) => (typeof s === 'string'
  ? decodeXmlEntities(s).trim()
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

const stripHtml = (html) => decodeXmlEntities(html.replace(/<[^>]+>/g, ' '))
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
    // Pinterest entity-escapes the description's HTML (`&lt;img src=&quot;…&quot;&gt;`)
    // rather than wrapping it in CDATA, so decode it before probing for the <img>;
    // a no-op when the feed already ships a literal <img> (CDATA) tag.
    const decodedDescription = decodeEntities(rawDescription);
    const found = decodeEntities(extractImageUrl(block, decodedDescription));
    if (!pinUrl || !found) continue;
    pins.push({
      pinUrl,
      imageUrl: upgradePinImageSize(found),
      imageUrlOriginal: found,
      title: stripHtml(extractTag(block, 'title')).slice(0, 500),
      description: stripHtml(decodedDescription).slice(0, 500),
      pubDate: extractTag(block, 'pubDate'),
    });
  }
  return pins;
}
