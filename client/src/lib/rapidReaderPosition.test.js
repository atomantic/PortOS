import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RAPID_READER_PROGRESS_KEY,
  clearRapidReaderProgress,
  rapidReaderDocumentId,
  rapidReaderWords,
  rapidReaderWordIndexAtCursor,
  readRapidReaderProgress,
  writeRapidReaderProgress,
} from './rapidReaderPosition.js';

beforeEach(() => {
  localStorage.clear();
  vi.useRealTimers();
});

afterEach(() => vi.restoreAllMocks());

describe('rapidReaderWordIndexAtCursor', () => {
  it('starts at the word containing the cursor or the next word in whitespace', () => {
    const text = 'alpha   bravo charlie';
    expect(rapidReaderWordIndexAtCursor(text, 2)).toBe(0);
    expect(rapidReaderWordIndexAtCursor(text, 5)).toBe(1);
    expect(rapidReaderWordIndexAtCursor(text, 8)).toBe(1);
    expect(rapidReaderWordIndexAtCursor(text, text.length)).toBe(2);
  });
});

describe('rapidReaderWords', () => {
  it('folds dangling punctuation into the nearest readable word', () => {
    expect(rapidReaderWords('She said " hello ," then paused …').map(({ text }) => text)).toEqual([
      'She', 'said', '"hello,"', 'then', 'paused…',
    ]);
  });

  it('does not count punctuation-only frames as words', () => {
    expect(rapidReaderWords('wait — really?').map(({ text }) => text)).toEqual(['wait—', 'really?']);
  });
});

describe('Rapid Reader progress persistence', () => {
  it('stores progress by fingerprint without storing the source text', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234);
    const text = 'alpha bravo charlie delta';

    writeRapidReaderProgress(text, { wordIndex: 2, wpm: 425, chunkSize: 2 });

    expect(readRapidReaderProgress(text)).toEqual({
      wordIndex: 2,
      wordCount: 4,
      wpm: 425,
      chunkSize: 2,
      updatedAt: 1234,
    });
    const raw = localStorage.getItem(RAPID_READER_PROGRESS_KEY);
    expect(raw).toContain(rapidReaderDocumentId(text));
    expect(raw).not.toContain(text);
  });

  it('rejects stale or invalid progress and can clear a bookmark', () => {
    const text = 'alpha bravo charlie';
    writeRapidReaderProgress(text, { wordIndex: 1, wpm: 350, chunkSize: 1 });
    expect(readRapidReaderProgress(`${text} delta`)).toBeNull();

    clearRapidReaderProgress(text);
    expect(readRapidReaderProgress(text)).toBeNull();
  });
});
