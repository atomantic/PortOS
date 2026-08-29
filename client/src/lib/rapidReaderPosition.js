import {
  safeReadJsonStorage,
  safeWriteJsonStorage,
} from './safeStorage.js';

export const RAPID_READER_PROGRESS_KEY = 'portos-rapid-reader-progress-v1';

const MAX_SAVED_DOCUMENTS = 20;

const PUNCTUATION_ONLY = /^[\p{P}\p{S}]+$/u;
const OPENING_PUNCTUATION_ONLY = /^[\p{Ps}\p{Pi}'"¿¡]+$/u;

// RSVP should not spend a frame on a quote, bracket, comma, or ellipsis that
// was separated from its word by line wrapping or HTML conversion. Keep
// opening punctuation with the next word and closing punctuation with the
// previous word while retaining source offsets for cursor resume.
export const rapidReaderWords = (text = '') => {
  const words = [];
  let pendingPrefix = '';
  let pendingStart = null;

  for (const match of text.matchAll(/\S+/g)) {
    const value = match[0];
    const start = match.index;
    const end = start + value.length;

    if (PUNCTUATION_ONLY.test(value)) {
      if (OPENING_PUNCTUATION_ONLY.test(value) || !words.length) {
        pendingPrefix += value;
        if (pendingStart == null) pendingStart = start;
      } else {
        const previous = words[words.length - 1];
        previous.text += value;
        previous.end = end;
      }
      continue;
    }

    words.push({
      text: `${pendingPrefix}${value}`,
      start: pendingStart ?? start,
      end,
    });
    pendingPrefix = '';
    pendingStart = null;
  }

  // A dangling opening quote at EOF still belongs to the final displayed
  // word; dropping it would make the reader silently change the source text.
  if (pendingPrefix && words.length) {
    const previous = words[words.length - 1];
    previous.text += pendingPrefix;
  }

  return words;
};

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
