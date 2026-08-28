import {
  safeReadJsonStorage,
  safeWriteJsonStorage,
} from './safeStorage.js';

export const RAPID_READER_PROGRESS_KEY = 'portos-rapid-reader-progress-v1';

const MAX_SAVED_DOCUMENTS = 20;

export const rapidReaderWords = (text = '') => Array.from(text.matchAll(/\S+/g), (match) => ({
  text: match[0],
  start: match.index,
  end: match.index + match[0].length,
}));

export const rapidReaderWordIndexAtCursor = (text, cursor = 0) => {
  const words = rapidReaderWords(text);
  if (!words.length) return 0;
  const boundedCursor = Math.max(0, Math.min(Number.isFinite(cursor) ? cursor : 0, text.length));
  const nextIndex = words.findIndex((word) => word.end > boundedCursor);
  return nextIndex === -1 ? words.length - 1 : nextIndex;
};

// A compact, deterministic identifier lets reading progress follow pasted text
// without persisting that potentially-private text in localStorage.
export const rapidReaderDocumentId = (text = '') => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}-${(hash >>> 0).toString(36)}`;
};

const validProgress = (entry, wordCount) => {
  if (!entry || entry.wordCount !== wordCount) return null;
  if (!Number.isInteger(entry.wordIndex) || entry.wordIndex < 0 || entry.wordIndex >= wordCount) return null;
  return {
    wordIndex: entry.wordIndex,
    wordCount,
    wpm: Number.isFinite(entry.wpm) ? Math.max(100, Math.min(1000, entry.wpm)) : 350,
    chunkSize: entry.chunkSize === 2 ? 2 : 1,
    updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0,
  };
};

export const readRapidReaderProgress = (text, identity = {}) => {
  const wordCount = identity.wordCount ?? rapidReaderWords(text).length;
  if (!wordCount) return null;
  const stored = safeReadJsonStorage(RAPID_READER_PROGRESS_KEY, null);
  if (stored?.version !== 1 || typeof stored.entries !== 'object' || !stored.entries) return null;
  const documentId = identity.documentId ?? rapidReaderDocumentId(text);
  return validProgress(stored.entries[documentId], wordCount);
};

export const writeRapidReaderProgress = (text, progress, identity = {}) => {
  const wordCount = identity.wordCount ?? rapidReaderWords(text).length;
  const entry = validProgress({ ...progress, wordCount, updatedAt: Date.now() }, wordCount);
  if (!entry || entry.wordIndex === 0) return null;

  const stored = safeReadJsonStorage(RAPID_READER_PROGRESS_KEY, null);
  const previousEntries = stored?.version === 1 && stored.entries && typeof stored.entries === 'object'
    ? stored.entries
    : {};
  const documentId = identity.documentId ?? rapidReaderDocumentId(text);
  const entries = Object.fromEntries(
    Object.entries({ ...previousEntries, [documentId]: entry })
      .sort(([, left], [, right]) => (right?.updatedAt || 0) - (left?.updatedAt || 0))
      .slice(0, MAX_SAVED_DOCUMENTS),
  );
  safeWriteJsonStorage(RAPID_READER_PROGRESS_KEY, { version: 1, entries });
  return entry;
};

export const clearRapidReaderProgress = (text, identity = {}) => {
  const stored = safeReadJsonStorage(RAPID_READER_PROGRESS_KEY, null);
  if (stored?.version !== 1 || typeof stored.entries !== 'object' || !stored.entries) return;
  const documentId = identity.documentId ?? rapidReaderDocumentId(text);
  if (!Object.hasOwn(stored.entries, documentId)) return;
  const entries = { ...stored.entries };
  delete entries[documentId];
  safeWriteJsonStorage(RAPID_READER_PROGRESS_KEY, { version: 1, entries });
};
