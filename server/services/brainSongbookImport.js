/**
 * SongBook URL Import Service
 *
 * Fetches a user-supplied URL (SSRF-guarded via safeUrlFetch) and extracts a
 * song DRAFT — { title, artist, content: { format, text }, sourceUrl } — for
 * the client's review/edit screen. Nothing is stored here; the user saves the
 * draft explicitly via POST /api/brain/songbook.
 *
 * Extractors, first match wins:
 *   1. Ultimate Guitar js-store JSON (defensive — any shape drift falls through)
 *   2. Largest <pre> block in the page (tab sites overwhelmingly use <pre>)
 *   3. Strip-tags plain-text fallback (always yields something on a real page)
 *
 * All extraction functions are pure and exported for testing.
 */

import { fetchPublicText } from '../lib/safeUrlFetch.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { ServerError } from '../lib/errorHandler.js';

// Matches songInputSchema's content.text max — clamp instead of failing the
// draft so an oversized page still yields something editable.
const MAX_CONTENT_CHARS = 200000;

const NAMED_ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// Guarded String.fromCodePoint — out-of-range numeric entities decode to ''
// instead of throwing (the parser must never throw on hostile/garbled HTML).
const safeCodePoint = (n) =>
  (Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');

/**
 * Decode the HTML entities that matter for tab pages (named basics + numeric).
 * `&amp;` decodes LAST so double-encoded sequences ("&amp;lt;") don't
 * double-decode into markup.
 */
export function decodeHtmlEntities(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(Number(dec)))
    .replace(/&(lt|gt|quot|apos|nbsp);/gi, (_, name) => NAMED_ENTITIES[name.toLowerCase()])
    .replace(/&amp;/gi, '&');
}

/**
 * Strip Ultimate-Guitar chord/tab markers ([ch]C[/ch], [tab]...[/tab]) from
 * wiki_tab content, leaving the plain monospace sheet.
 */
export function stripUgMarkers(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\[\/?(?:ch|tab)\]/gi, '');
}

// Normalize line endings and trim outer blank space; collapse 3+ blank lines.
const normalizeSheetText = (text) =>
  text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/**
 * Ultimate Guitar extractor. UG pages embed their whole page state as
 * HTML-entity-encoded JSON in <div class="js-store" data-content="...">.
 * The tab text lives at page.data.tab_view.wiki_tab.content and the song/artist
 * names at page.data.tab.{song_name,artist_name}. Everything is optional-chained
 * so ANY shape drift returns null and the caller falls through to the next
 * extractor. Returns { text, title, artist } or null.
 */
export function extractUltimateGuitarStore(html) {
  if (typeof html !== 'string') return null;
  const match = /<div[^>]*class="[^"]*js-store[^"]*"[^>]*data-content="([^"]*)"/i.exec(html);
  if (!match) return null;
  const parsed = safeJSONParse(decodeHtmlEntities(match[1]), null);
  // Observed shape nests under a top-level `store` key; tolerate both.
  const data = parsed?.store?.page?.data ?? parsed?.page?.data;
  const content = data?.tab_view?.wiki_tab?.content;
  if (typeof content !== 'string' || !content.trim()) return null;
  return {
    text: normalizeSheetText(stripUgMarkers(content)),
    title: typeof data?.tab?.song_name === 'string' ? data.tab.song_name.trim() : '',
    artist: typeof data?.tab?.artist_name === 'string' ? data.tab.artist_name.trim() : '',
  };
}

// A <pre> shorter than this is navigation/code chrome, not a song sheet —
// fall through to the plain-text extractor instead of returning a stub.
const MIN_PRE_CHARS = 20;

/**
 * Generic tab-site extractor: the largest <pre> block in the page (regex, no
 * DOM library), inner tags stripped, entities decoded. Returns string or null.
 */
export function extractLargestPre(html) {
  if (typeof html !== 'string') return null;
  let largest = '';
  const re = /<pre\b[^>]*>([\s\S]*?)<\/pre>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[1].length > largest.length) largest = m[1];
  }
  const text = normalizeSheetText(decodeHtmlEntities(largest.replace(/<[^>]+>/g, '')));
  return text.length >= MIN_PRE_CHARS ? text : null;
}

/**
 * Last-resort extractor: strip scripts/styles/tags to plain text. Always
 * returns a string (possibly empty).
 */
export function stripHtmlToText(html) {
  if (typeof html !== 'string') return '';
  const text = html
    .replace(/<(script|style|head|noscript)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return normalizeSheetText(decodeHtmlEntities(text));
}

// Strip "(ver 2)" suffixes and trailing sheet-type keywords from a <title>-derived song name.
const cleanTitlePart = (s) => {
  const cleaned = s
    .replace(/\s*\((?:ver\.?|version)\s*\d*\)\s*$/i, '')
    .replace(/\s+(?:chords|tabs?|guitar tabs?|bass tabs?|ukulele)$/i, '')
    .trim();
  return cleaned || s.trim();
};

/**
 * Title/artist fallback from the page <title>: strips site suffixes after
 * '|' / '@', then tries "X by Y" and "X - Y" patterns. Returns
 * { title, artist } with '' for anything unresolvable.
 */
export function parseTitleArtist(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(typeof html === 'string' ? html : '');
  const raw = decodeHtmlEntities(match?.[1] ?? '').split(/[|@]/)[0].replace(/\s+/g, ' ').trim();
  if (!raw) return { title: '', artist: '' };
  const by = /^(.+?)\s+by\s+(.+)$/i.exec(raw);
  if (by) return { title: cleanTitlePart(by[1]), artist: by[2].trim() };
  const dash = /^(.+?)\s+[-–—]\s+(.+)$/.exec(raw);
  if (dash) return { title: cleanTitlePart(dash[1]), artist: dash[2].trim() };
  return { title: cleanTitlePart(raw), artist: '' };
}

/**
 * Pure orchestration: run the extractor cascade over fetched HTML and build
 * the draft. Exported for testing without network mocks.
 */
export function buildDraftFromHtml(html, url) {
  const fallback = parseTitleArtist(html);

  const ug = extractUltimateGuitarStore(html);
  if (ug) {
    return {
      title: ug.title || fallback.title,
      artist: ug.artist || fallback.artist,
      content: { format: 'tab', text: ug.text.slice(0, MAX_CONTENT_CHARS) },
      sourceUrl: url,
    };
  }

  const pre = extractLargestPre(html);
  if (pre) {
    return {
      title: fallback.title,
      artist: fallback.artist,
      content: { format: 'tab', text: pre.slice(0, MAX_CONTENT_CHARS) },
      sourceUrl: url,
    };
  }

  return {
    title: fallback.title,
    artist: fallback.artist,
    content: { format: 'plain', text: stripHtmlToText(html).slice(0, MAX_CONTENT_CHARS) },
    sourceUrl: url,
  };
}

/**
 * Fetch a URL and extract a song draft. Throws ServerError on unsafe URLs
 * (400, via safeUrlFetch), fetch failures (502), or content-free pages (422).
 */
export async function importSongFromUrl(url) {
  const html = await fetchPublicText(url, {
    timeoutMs: 20000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PortOS-SongBook/1.0)' },
  });
  if (html === null) {
    throw new ServerError('Could not fetch that URL (network error, non-2xx response, or blocked redirect)', {
      status: 502,
      code: 'SONG_IMPORT_FETCH_FAILED',
    });
  }
  const draft = buildDraftFromHtml(html, url);
  if (!draft.content.text) {
    throw new ServerError('No song content found at that URL', {
      status: 422,
      code: 'SONG_IMPORT_EMPTY',
    });
  }
  console.log(`🎸 SongBook import: ${draft.content.format} draft (${draft.content.text.length} chars) from ${new URL(url).hostname}`);
  return draft;
}
