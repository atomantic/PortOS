import { describe, it, expect } from 'vitest';
import { CLICHE_PHRASES, findCliches, findModifierStacking } from './cliches.js';

describe('CLICHE_PHRASES', () => {
  it('is a non-empty frozen list of lowercase, trimmed phrases', () => {
    expect(Array.isArray(CLICHE_PHRASES)).toBe(true);
    expect(CLICHE_PHRASES.length).toBeGreaterThan(20);
    expect(Object.isFrozen(CLICHE_PHRASES)).toBe(true);
    for (const p of CLICHE_PHRASES) {
      expect(p).toBe(p.toLowerCase());
      expect(p).toBe(p.trim());
      expect(p.length).toBeGreaterThan(0);
    }
  });
});

describe('findCliches', () => {
  it('returns [] for empty / non-string input', () => {
    expect(findCliches('')).toEqual([]);
    expect(findCliches(null)).toEqual([]);
    expect(findCliches(undefined)).toEqual([]);
    expect(findCliches(42)).toEqual([]);
  });

  it('finds a seed cliché case-insensitively and anchors the verbatim text', () => {
    const text = 'And then TIME STOOD STILL as the door opened.';
    const hits = findCliches(text);
    expect(hits).toHaveLength(1);
    expect(hits[0].phrase).toBe('time stood still');
    expect(hits[0].anchor).toBe('TIME STOOD STILL'); // verbatim casing from the text
    expect(text.slice(hits[0].index, hits[0].index + hits[0].anchor.length)).toBe('TIME STOOD STILL');
  });

  it('matches across flexible internal whitespace and newlines', () => {
    const hits = findCliches('the silence was a\n  deafening   silence indeed');
    expect(hits.map((h) => h.phrase)).toContain('deafening silence');
  });

  it('requires whole-word boundaries (no mid-word matches)', () => {
    // "cold sweat" should NOT match inside "scolded sweater"
    expect(findCliches('he scolded sweater makers')).toEqual([]);
    expect(findCliches('a cold sweat broke out').map((h) => h.phrase)).toContain('cold sweat');
  });

  it('returns one finding per distinct phrase, sorted by position', () => {
    const text = 'little did they know. Later, all hell broke loose, and little did they know again.';
    const hits = findCliches(text);
    // "little did they know" deduped to its first occurrence; both phrases present.
    expect(hits.map((h) => h.phrase)).toEqual(['little did they know', 'all hell broke loose']);
    expect(hits[0].index).toBeLessThan(hits[1].index);
  });

  it('mutes phrases in the house-style allowlist (case-insensitively)', () => {
    const text = 'Time stood still.';
    expect(findCliches(text)).toHaveLength(1);
    expect(findCliches(text, { allowPhrases: ['TIME stood still'] })).toEqual([]);
  });

  it('flags series-specific extra phrases', () => {
    const text = 'It was a dark and stormy night.';
    expect(findCliches(text)).toEqual([]);
    const hits = findCliches(text, { extraPhrases: ['a dark and stormy night'] });
    expect(hits.map((h) => h.phrase)).toContain('a dark and stormy night');
  });

  it('ignores non-array allow/extra options', () => {
    expect(() => findCliches('time stood still', { allowPhrases: 'x', extraPhrases: 5 })).not.toThrow();
    expect(findCliches('time stood still', { allowPhrases: 'x', extraPhrases: 5 })).toHaveLength(1);
  });
});

describe('findModifierStacking', () => {
  it('returns [] for empty / non-string input', () => {
    expect(findModifierStacking('')).toEqual([]);
    expect(findModifierStacking(null)).toEqual([]);
  });

  it('flags a no-comma run of 3+ stacked modifiers before a noun', () => {
    const runs = findModifierStacking('It was a big red shiny new car.');
    expect(runs).toHaveLength(1);
    expect(runs[0].count).toBe(4);
    expect(runs[0].words).toEqual(['big', 'red', 'shiny', 'new']);
    expect(runs[0].anchor).toBe('big red shiny new');
  });

  it('does not flag a run of 2', () => {
    expect(findModifierStacking('a big red car')).toEqual([]);
  });

  it('does NOT flag comma-coordinate adjective lists (left to the LLM)', () => {
    expect(findModifierStacking('a cold, dark, lonely night')).toEqual([]);
  });

  it('does NOT flag a comma-separated enumeration of nouns', () => {
    expect(findModifierStacking('apples, oranges, bananas and pears')).toEqual([]);
  });

  it('breaks runs at sentence and clause boundaries', () => {
    // "tired" ends one sentence; "broken defeated" only 2 → no flag.
    expect(findModifierStacking('He was tired. Broken, defeated, he left.')).toEqual([]);
  });

  it('flags participial adjective stacks (no commas)', () => {
    const runs = findModifierStacking('a tired wounded battered man');
    expect(runs).toHaveLength(1);
    expect(runs[0].count).toBe(3);
  });

  it('honors a higher minStack threshold', () => {
    expect(findModifierStacking('big red shiny new car', { minStack: 5 })).toEqual([]);
    expect(findModifierStacking('big red shiny new old car', { minStack: 5 })).toHaveLength(1);
  });

  it('clamps minStack to a floor of 3', () => {
    // minStack below 3 is meaningless ("a big car" isn't overwriting) — clamp to 3.
    expect(findModifierStacking('a big red car', { minStack: 2 })).toEqual([]);
  });
});
