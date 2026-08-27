import { join } from 'node:path';
import { PATHS, atomicWrite, tryReadFileStrict } from '../lib/fileUtils.js';
import { ServerError } from '../lib/errorHandler.js';
import { htmlToText } from '../lib/htmlToText.js';
import { fetchPublicText } from '../lib/safeUrlFetch.js';

export const ACCELERANDO_BOOK = Object.freeze({
  id: 'accelerando',
  title: 'Accelerando',
  author: 'Charles Stross',
  sourceUrl: 'http://www.antipope.org/charlie/blog-static/fiction/accelerando/accelerando.html',
  sourcePageUrl: 'http://www.antipope.org/charlie/blog-static/fiction/accelerando/accelerando-intro.html',
  licenseName: 'CC BY-NC-ND 2.5',
  licenseUrl: 'https://creativecommons.org/licenses/by-nc-nd/2.5/',
});

const CACHE_FILE = join(PATHS.data, 'cache', 'accelerando.html');
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const SOURCE_TIMEOUT_MS = 20_000;
const SOURCE_ENTITIES = {
  ccedil: 'ç',
  copy: '©',
  ecirc: 'ê',
  eacute: 'é',
  egrave: 'è',
  igrave: 'ì',
  mdash: '—',
  Mu: 'Μ',
  ndash: '–',
  ograve: 'ò',
  ouml: 'ö',
  uuml: 'ü',
};
const REQUIRED_MARKERS = [
  'A novel by Charles Stross',
  'Creative Commons Attribution-NonCommercial-NoDerivs 2.5',
  'Chapter 1:',
];

function extractBookHtml(html) {
  const opening = /<div\b[^>]*\bid\s*=\s*(["'])book\1[^>]*>/i.exec(html);
  if (!opening) return '';

  const bodyStart = opening.index + opening[0].length;
  const tags = /<!--[\s\S]*?-->|<(script|style|noscript)\b[\s\S]*?<\/\1\s*>|<div\b[^>]*>|<\/div\s*>/gi;
  tags.lastIndex = bodyStart;
  let depth = 1;
  let tag;
  while ((tag = tags.exec(html))) {
    if (/^<div\b/i.test(tag[0]) && !/\/\s*>$/.test(tag[0])) {
      depth += 1;
    } else if (/^<\/div\b/i.test(tag[0])) {
      depth -= 1;
      if (depth === 0) return html.slice(bodyStart, tag.index);
    }
  }
  return '';
}

/**
 * Extract the book body from the official single-page HTML edition and turn it
 * into the plain text the RSVP reader expects. The marker checks keep an error
 * page or a future unrelated replacement from being cached as a book.
 */
export function extractAccelerandoText(html) {
  if (typeof html !== 'string') return '';
  const bookHtml = extractBookHtml(html);
  if (!bookHtml) return '';
  const text = htmlToText(bookHtml.replace(/<!--[\s\S]*?-->/g, ''), {
    extraEntities: SOURCE_ENTITIES,
    paragraphBreak: '\n\n',
    collapseSpaces: true,
  });
  return REQUIRED_MARKERS.every((marker) => text.includes(marker)) ? text : '';
}

function sourceError(message, code) {
  return new ServerError(message, { status: 502, code });
}

async function readCachedSource() {
  const result = await tryReadFileStrict(CACHE_FILE);
  if (!result.ok) {
    throw new ServerError('Accelerando cache is unreadable — purge the cache and retry', {
      status: 500,
      code: 'ACCELERANDO_CACHE_UNREADABLE',
    });
  }
  if (!result.value) return '';
  return extractAccelerandoText(result.value);
}

function buildBook(text, cached, cacheStored = true) {
  return {
    ...ACCELERANDO_BOOK,
    text,
    wordCount: text.split(/\s+/).length,
    cached,
    cacheStored,
  };
}

async function loadAccelerando() {
  const cachedText = await readCachedSource();
  if (cachedText) return buildBook(cachedText, true);

  const source = await fetchPublicText(ACCELERANDO_BOOK.sourceUrl, {
    blockPrivate: true,
    headers: { 'User-Agent': 'PortOS-RapidReader/1.0' },
    maxBytes: MAX_SOURCE_BYTES,
    throwOnUnsafe: false,
    timeoutMs: SOURCE_TIMEOUT_MS,
  });
  if (!source) {
    throw sourceError('Could not download Accelerando from the author’s site', 'ACCELERANDO_FETCH_FAILED');
  }

  const text = extractAccelerandoText(source);
  if (!text) {
    throw sourceError('The downloaded Accelerando source was not a recognized book edition', 'ACCELERANDO_SOURCE_INVALID');
  }

  const cacheStored = await atomicWrite(CACHE_FILE, source).then(
    () => true,
    (error) => {
      console.error(`❌ Failed to cache Accelerando source: ${error.code || 'unknown error'}`);
      return false;
    },
  );
  return buildBook(text, false, cacheStored);
}

let loadPromise = null;

/** Load the official edition, using the local cache after the first request. */
export function getAccelerandoBook() {
  if (!loadPromise) loadPromise = loadAccelerando().finally(() => { loadPromise = null; });
  return loadPromise;
}
