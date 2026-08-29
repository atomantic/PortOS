import { PATHS } from '../lib/fileUtils.js';
import { createCollectionStore } from '../lib/collectionStore.js';
import { ServerError } from '../lib/errorHandler.js';
import { htmlToText } from '../lib/htmlToText.js';
import { fetchPublicText } from '../lib/safeUrlFetch.js';
import { v4 as uuidv4 } from '../lib/uuid.js';

export const RAPID_READER_LIBRARY_SCHEMA_VERSION = 1;
export const MAX_RAPID_READER_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_TITLE_LENGTH = 200;
const now = () => new Date().toISOString();
const wordCount = (text) => (text.match(/\S+/g) || []).length;
const textBytes = (text) => Buffer.byteLength(text, 'utf8');
const normalizeText = (text) => typeof text === 'string' ? text.trim() : '';
const normalizeTitle = (title) => typeof title === 'string' ? title.trim().slice(0, MAX_TITLE_LENGTH) : '';

export const rapidReaderLibraryStore = createCollectionStore({
  dir: PATHS.rapidReaderLibrary,
  type: 'rapid-reader-library',
  schemaVersion: RAPID_READER_LIBRARY_SCHEMA_VERSION,
  sanitizeRecord: (record) => {
    const text = normalizeText(record?.text);
    const title = normalizeTitle(record?.title);
    if (!record?.id || !text || !title || !['paste', 'fetch', 'accelerando'].includes(record.sourceType)) return null;
    return { ...record, title, text, author: typeof record.author === 'string' ? record.author : null, sourceUrl: typeof record.sourceUrl === 'string' ? record.sourceUrl : null, wordCount: wordCount(text) };
  },
});

function assertText(text) {
  if (!text) throw new ServerError('Text is required', { status: 400, code: 'VALIDATION_ERROR' });
  if (textBytes(text) > MAX_RAPID_READER_TEXT_BYTES) throw new ServerError('Text exceeds the 2 MiB limit', { status: 400, code: 'VALIDATION_ERROR' });
}
function metadata(record) { const { text, ...entry } = record; return entry; }
function titleFromHtml(source) {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(source);
  return match ? htmlToText(match[1]).trim() : '';
}
function hostnameFor(url) { return new URL(url).hostname; }
export async function listRapidReaderLibrary() { return (await rapidReaderLibraryStore.loadAll()).map(metadata).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
export async function getRapidReaderLibraryEntry(id) {
  const entry = await rapidReaderLibraryStore.loadOne(id);
  if (!entry) throw new ServerError('Shelf entry not found', { status: 404, code: 'NOT_FOUND' });
  return entry;
}
// saveOne only writes {dir}/{id}/index.json — it never touches the type-level
// index, so a store whose records were all written by saveOne would report
// "no index.json (fresh install)" to the boot verifier forever. Stamp it once
// per process on the first write (same guard as creativeCommissions).
let typeIndexStamped = false;
async function ensureTypeIndex() {
  if (typeIndexStamped) return;
  typeIndexStamped = true;
  await rapidReaderLibraryStore.saveTypeIndex({}).catch(() => { typeIndexStamped = false; });
}
async function saveEntry(entry) { await rapidReaderLibraryStore.saveOne(entry.id, entry); await ensureTypeIndex(); return entry; }
export async function createPastedRapidReaderEntry({ title, author, text }) {
  const cleanText = normalizeText(text); const cleanTitle = normalizeTitle(title); assertText(cleanText);
  if (!cleanTitle) throw new ServerError('Title is required', { status: 400, code: 'VALIDATION_ERROR' });
  const timestamp = now();
  return saveEntry({ id: uuidv4(), title: cleanTitle, author: normalizeTitle(author) || null, sourceUrl: null, sourceType: 'paste', text: cleanText, wordCount: wordCount(cleanText), addedAt: timestamp, updatedAt: timestamp });
}
export async function fetchRapidReaderEntry({ url, title }) {
  const source = await fetchPublicText(url, { blockPrivate: true, maxBytes: MAX_RAPID_READER_TEXT_BYTES, timeoutMs: 20_000 });
  if (!source) throw new ServerError('Could not fetch the requested URL', { status: 502, code: 'FETCH_FAILED' });
  const text = normalizeText(htmlToText(source)); assertText(text);
  const timestamp = now(); const derivedTitle = normalizeTitle(title) || normalizeTitle(titleFromHtml(source)) || hostnameFor(url);
  return saveEntry({ id: uuidv4(), title: derivedTitle, author: null, sourceUrl: url, sourceType: 'fetch', text, wordCount: wordCount(text), addedAt: timestamp, updatedAt: timestamp });
}
export async function deleteRapidReaderLibraryEntry(id) { await getRapidReaderLibraryEntry(id); await rapidReaderLibraryStore.deleteOne(id); }
export async function upsertAccelerandoShelfEntry(book) {
  const current = await rapidReaderLibraryStore.loadOne('accelerando'); const timestamp = now(); const text = normalizeText(book.text); assertText(text);
  return saveEntry({ id: 'accelerando', title: book.title, author: book.author, sourceUrl: book.sourceUrl, sourceType: 'accelerando', text, wordCount: wordCount(text), addedAt: current?.addedAt || timestamp, updatedAt: timestamp });
}
