import { describe, it, expect } from 'vitest';
import { resolveAppByPhrase } from './appResolver.js';

const APPS = [
  { id: 'bookloom-abc', name: 'BookLoom' },
  { id: 'portos-default', name: 'PortOS' },
  { id: 'finance-tracker-xyz', name: 'Finance Tracker' },
  { id: 'ai', name: 'AI' },
];

describe('resolveAppByPhrase', () => {
  it('returns null for empty / too-short / non-string input', () => {
    expect(resolveAppByPhrase('', APPS)).toBeNull();
    expect(resolveAppByPhrase(null, APPS)).toBeNull();
    expect(resolveAppByPhrase('a', APPS)).toBeNull();
    expect(resolveAppByPhrase(123, APPS)).toBeNull();
  });

  it('returns null when the apps list is empty or invalid', () => {
    expect(resolveAppByPhrase('BookLoom', [])).toBeNull();
    expect(resolveAppByPhrase('BookLoom', null)).toBeNull();
  });

  it('exact-matches the normalized app name', () => {
    expect(resolveAppByPhrase('BookLoom', APPS)?.id).toBe('bookloom-abc');
    expect(resolveAppByPhrase('bookloom', APPS)?.id).toBe('bookloom-abc');
    expect(resolveAppByPhrase('book loom', APPS)?.id).toBe('bookloom-abc');
    expect(resolveAppByPhrase('Book-Loom', APPS)?.id).toBe('bookloom-abc');
  });

  it('exact-matches the app id', () => {
    expect(resolveAppByPhrase('portos-default', APPS)?.id).toBe('portos-default');
  });

  it('matches multi-word names by prefix / contains', () => {
    expect(resolveAppByPhrase('finance', APPS)?.id).toBe('finance-tracker-xyz');
    expect(resolveAppByPhrase('finance tracker', APPS)?.id).toBe('finance-tracker-xyz');
    expect(resolveAppByPhrase('tracker', APPS)?.id).toBe('finance-tracker-xyz');
  });

  it('returns null when nothing matches', () => {
    expect(resolveAppByPhrase('totally unknown app', APPS)).toBeNull();
  });

  it('does not over-match short candidates by prefix', () => {
    // The "AI" app (2-letter name) must not gobble every utterance starting
    // with "ai" — guard kicks in because its normalized name length < 3.
    expect(resolveAppByPhrase('aim higher', APPS)).toBeNull();
  });

  it('reverse-prefix matches when the target is longer than a candidate id/name', () => {
    // Spoken phrases occasionally pick up a stray suffix — "bookloom abc"
    // should still resolve to BookLoom, not 404.
    expect(resolveAppByPhrase('bookloom-abc-extra', APPS)?.id).toBe('bookloom-abc');
    expect(resolveAppByPhrase('finance-tracker-xyz-extra', APPS)?.id).toBe('finance-tracker-xyz');
  });

  it('picks the longest candidate on substring overlap', () => {
    const apps = [
      { id: 'book', name: 'Book' },
      { id: 'bookloom', name: 'BookLoom' },
    ];
    // "BookLoom" contains "Book" (so both qualify on substring), but we should
    // prefer the longer, more specific name.
    expect(resolveAppByPhrase('bookloom', apps)?.id).toBe('bookloom');
  });
});
