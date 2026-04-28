import { describe, it, expect } from 'vitest';
import {
  tokenize,
  trigramsOf,
  rememberTtsSentence,
  isEchoOfRecentTts,
  MIN_SHARED_TRIGRAMS,
} from './echo.js';

describe('tokenize', () => {
  it('lowercases and strips punctuation', () => {
    expect(tokenize('Hello, World!')).toEqual(['hello', 'world']);
  });

  it('returns empty array for empty / nullish input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize(null)).toEqual([]);
    expect(tokenize(undefined)).toEqual([]);
  });

  it('handles unicode letters and digits', () => {
    expect(tokenize('Café 2026 — déjà vu')).toEqual(['café', '2026', 'déjà', 'vu']);
  });
});

describe('trigramsOf', () => {
  it('returns empty when fewer than 3 tokens', () => {
    expect(trigramsOf(['a', 'b'])).toEqual([]);
    expect(trigramsOf([])).toEqual([]);
  });

  it('produces sliding 3-word windows', () => {
    expect(trigramsOf(['a', 'b', 'c', 'd'])).toEqual(['a b c', 'b c d']);
  });
});

describe('rememberTtsSentence', () => {
  it('appends a normalized entry with trigrams', () => {
    const recent = [];
    rememberTtsSentence(recent, 'Hello there friend!', { now: 1000 });
    expect(recent).toHaveLength(1);
    expect(recent[0].text).toBe('hello there friend');
    expect(recent[0].trigrams.has('hello there friend')).toBe(true);
    expect(recent[0].t).toBe(1000);
  });

  it('skips empty / whitespace-only sentences', () => {
    const recent = [];
    rememberTtsSentence(recent, '   ', { now: 1 });
    rememberTtsSentence(recent, '', { now: 1 });
    expect(recent).toEqual([]);
  });

  it('drops entries older than windowMs before appending', () => {
    const recent = [];
    rememberTtsSentence(recent, 'old sentence here', { now: 0, windowMs: 1000 });
    rememberTtsSentence(recent, 'newer sentence appears', { now: 2000, windowMs: 1000 });
    expect(recent).toHaveLength(1);
    expect(recent[0].text).toBe('newer sentence appears');
  });
});

describe('isEchoOfRecentTts', () => {
  const NOW = 1_700_000_000_000;
  const seed = (sentences, now = NOW) => {
    const recent = [];
    for (const s of sentences) rememberTtsSentence(recent, s, { now });
    return recent;
  };

  it('returns false for empty / no-tts state', () => {
    expect(isEchoOfRecentTts('anything goes here', [], { now: NOW })).toBe(false);
    expect(isEchoOfRecentTts('', seed(['hello world friend']), { now: NOW })).toBe(false);
  });

  it('lets short barge-ins through even when words appear in TTS', () => {
    // Bot said: "you should wait for the database, that's wrong syntax"
    // User barges in with "wait" → must not be flagged as echo.
    const recent = seed(['you should wait for the database thats wrong syntax']);
    expect(isEchoOfRecentTts('wait', recent, { now: NOW })).toBe(false);
    expect(isEchoOfRecentTts('stop', recent, { now: NOW })).toBe(false);
    expect(isEchoOfRecentTts('hold on', recent, { now: NOW })).toBe(false);
    expect(isEchoOfRecentTts('actually no', recent, { now: NOW })).toBe(false);
  });

  it('lets a 4-word barge-in through when only 1 trigram matches', () => {
    // User: "wait thats wrong syntax" (4 tokens → 2 trigrams)
    // Bot:  "wait for the database thats wrong syntax" (7 tokens → 5 trigrams)
    // Shared: only "thats wrong syntax" → 1 trigram → below threshold of 2.
    // (No substring match either — the bot inserts "for the database" between.)
    const recent = seed(['wait for the database thats wrong syntax']);
    expect(isEchoOfRecentTts('wait thats wrong syntax', recent, { now: NOW })).toBe(false);
  });

  it('flags long transcripts that share 2+ trigrams as echo', () => {
    const recent = seed(['the meeting starts at three pm in the conference room']);
    expect(isEchoOfRecentTts('the meeting starts at three pm', recent, { now: NOW })).toBe(true);
  });

  it('flags clean substring echo even with exactly 4 tokens', () => {
    const recent = seed(['you have three tasks due tomorrow']);
    // 4 tokens — passes length gate. Substring of TTS → echo.
    expect(isEchoOfRecentTts('have three tasks due', recent, { now: NOW })).toBe(true);
  });

  it('ignores tts entries older than the window', () => {
    const recent = seed(['the meeting starts at three pm in the conference room'], 0);
    expect(isEchoOfRecentTts('the meeting starts at three pm', recent, { now: 9001 })).toBe(false);
  });

  it('handles minor STT punctuation drift via tokenization', () => {
    const recent = seed(['Note that the report is due Friday afternoon.']);
    expect(isEchoOfRecentTts('note, that the report is due Friday afternoon', recent, { now: NOW })).toBe(true);
  });

  it(`requires at least ${MIN_SHARED_TRIGRAMS} shared trigrams for the trigram path`, () => {
    // Heard: 5 tokens → 3 trigrams. Bot: completely different except 1 trigram.
    const recent = seed(['quick brown fox jumps over fence', 'unrelated content here today now']);
    expect(isEchoOfRecentTts('the quick brown fox runs', recent, { now: NOW })).toBe(false);
  });
});
