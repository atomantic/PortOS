import { join } from 'node:path';
import { PATHS, atomicWrite, tryReadFileStrict } from '../lib/fileUtils.js';
import { ServerError } from '../lib/errorHandler.js';
import { htmlToText } from '../lib/htmlToText.js';
import { fetchPublicText } from '../lib/safeUrlFetch.js';
import { upsertAccelerandoShelfEntry } from './rapidReaderLibrary.js';

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
const PUNCTUATION_ONLY = /^[\p{P}\p{S}]+$/u;

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

const readerWordCount = (text) => {
  let count = 0;
  for (const match of text.matchAll(/\S+/g)) {
    const value = match[0];
    if (PUNCTUATION_ONLY.test(value)) {
      continue;
    }
    count += 1;
  }
  return count;
};

const sectionId = (title, index) => `${title
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '') || 'section'}-${index + 1}`;

/**
 * Extract the book's navigable Part and Chapter headings from the source
 * edition. Offsets are counted with the same punctuation folding as the
 * client reader, so a jump always lands on the heading it names.
 */
export function extractAccelerandoSections(bookHtml, text) {
  if (typeof bookHtml !== 'string' || typeof text !== 'string') return [];
  const sourceHtml = extractBookHtml(bookHtml) || bookHtml;
  const sections = [];
  const maxWordIndex = Math.max(0, readerWordCount(text) - 1);
  const headings = /<h([23])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
  let match;
  while ((match = headings.exec(sourceHtml))) {
    const title = htmlToText(match[2], { extraEntities: SOURCE_ENTITIES, collapseSpaces: true });
    const chapter = /^chapter\b/i.test(title);
    const part = /^part\b/i.test(title);
    if (!title || (!chapter && !part)) continue;
    const beforeHeading = htmlToText(sourceHtml.slice(0, match.index), {
      extraEntities: SOURCE_ENTITIES,
      paragraphBreak: '\n\n',
      collapseSpaces: true,
    });
    sections.push({
      id: sectionId(title, sections.length),
      title,
      kind: chapter ? 'chapter' : 'part',
      wordIndex: Math.min(readerWordCount(beforeHeading), maxWordIndex),
    });
  }
  return sections;
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
  if (!result.value) return null;
  const text = extractAccelerandoText(result.value);
  return text ? { text, html: result.value } : null;
}

function buildBook(text, cached, cacheStored = true, sourceHtml = '') {
  return {
    ...ACCELERANDO_BOOK,
    text,
    wordCount: readerWordCount(text),
    sections: extractAccelerandoSections(sourceHtml, text),
    cached,
    cacheStored,
  };
}

async function loadAccelerando() {
  const cachedSource = await readCachedSource();
  if (cachedSource) return buildBook(cachedSource.text, true, true, cachedSource.html);

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
  return buildBook(text, false, cacheStored, source);
}

let loadPromise = null;

/** Load the official edition, using the local cache after the first request. */
async function loadAndStoreAccelerando() {
  const book = await loadAccelerando();
  const shelfStored = await upsertAccelerandoShelfEntry(book).then(() => true, (error) => {
    console.error(`❌ Failed to save Accelerando to shelf: ${error.code || 'unknown error'}`);
    return false;
  });
  return { ...book, shelfStored };
}
export function getAccelerandoBook() {
  if (!loadPromise) loadPromise = loadAndStoreAccelerando().finally(() => { loadPromise = null; });
  return loadPromise;
}
