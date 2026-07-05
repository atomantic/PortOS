/**
 * Tests for the mechanical cut applier (#2168).
 */

import { describe, it, expect } from 'vitest';
import {
  locateCutSpan,
  collapseBlankLines,
  planCutsForSection,
  applyCutsToText,
  filterCutComments,
  filterSafeCutComments,
  MIN_ANCHOR_CHARS,
  CUT_TYPES,
  SAFE_CUT_TYPES,
} from './applyCuts.js';

describe('locateCutSpan', () => {
  it('finds exact match', () => {
    const text = 'The quick brown fox jumps over the lazy dog and runs away quickly.';
    const quote = 'brown fox jumps over the lazy dog'; // 33 chars
    const result = locateCutSpan(text, quote);
    expect(result.error).toBeUndefined();
    expect(result.method).toBe('exact');
    expect(text.slice(result.start, result.end)).toBe(quote);
  });

  it('finds whitespace-normalized match', () => {
    const text = 'The quick brown  fox\njumps over the lazy dog and runs away.';
    const quote = 'brown fox jumps over the lazy dog'; // 33 chars
    const result = locateCutSpan(text, quote);
    expect(result.error).toBeUndefined();
    expect(result.method).toBe('normalized');
    expect(result.start).toBeGreaterThan(0);
  });

  it('refuses ambiguous quote (multiple occurrences)', () => {
    const text = 'The fox jumps high. Another fox jumps high. A third fox jumps high.';
    const quote = 'fox jumps high. Another fox jumps'; // appears once exactly, so need different test
    const result = locateCutSpan(text, quote);
    // This particular quote is unique, so let's test a truly ambiguous case
    const text2 = 'She said hello and he replied hello and then she said hello again.';
    const quote2 = 'said hello and he replied hello';
    const result2 = locateCutSpan(text2, quote2);
    // Actually this is also unique. Let's use a simpler case.
    const text3 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const quote3 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const result3 = locateCutSpan(text3, quote3);
    expect(result3.error).toBe('Ambiguous: quote appears multiple times');
  });

  it('refuses short quote', () => {
    const text = 'Hello world, this is a test.';
    const quote = 'Hello world'; // 11 chars, below 25
    const result = locateCutSpan(text, quote);
    expect(result.error).toContain('too short');
  });

  it('returns error for missing quote', () => {
    const text = 'The quick brown fox.';
    const quote = 'This text is not in the source and is long enough to pass the length check.';
    const result = locateCutSpan(text, quote);
    expect(result.error).toBe('Quote not found in text');
  });

  it('returns error for missing or invalid quote input', () => {
    expect(locateCutSpan('some text', '')).toEqual({ error: 'Missing or invalid quote' });
    expect(locateCutSpan('some text', null)).toEqual({ error: 'Missing or invalid quote' });
  });
});

describe('collapseBlankLines', () => {
  it('collapses multiple blank lines to one', () => {
    const input = 'First paragraph.\n\n\n\n\nSecond paragraph.';
    const result = collapseBlankLines(input);
    expect(result).toBe('First paragraph.\n\nSecond paragraph.');
  });

  it('leaves single blank lines alone', () => {
    const input = 'First paragraph.\n\nSecond paragraph.';
    const result = collapseBlankLines(input);
    expect(result).toBe(input);
  });

  it('handles no blank lines', () => {
    const input = 'First paragraph.\nSecond paragraph.';
    const result = collapseBlankLines(input);
    expect(result).toBe(input);
  });
});

describe('planCutsForSection', () => {
  const sampleText = `
This is the introduction paragraph with some verbose content.

Here is a sentence that over-explains things unnecessarily by saying the same thing twice in different words.

A redundant paragraph that repeats information from earlier.

The conclusion wraps everything up nicely.
`.trim();

  it('plans applicable cuts with exact matches', () => {
    const cuts = [
      { anchorQuote: 'over-explains things unnecessarily by', subtype: 'OVER-EXPLAIN' },
    ];
    const { applicable, refused } = planCutsForSection(sampleText, cuts, { safeTypesOnly: true });
    expect(applicable).toHaveLength(1);
    expect(refused).toHaveLength(0);
    expect(applicable[0].cutType).toBe('OVER-EXPLAIN');
  });

  it('refuses non-safe cut types when safeTypesOnly=true', () => {
    const cuts = [
      { anchorQuote: 'introduction paragraph with some verbose', subtype: 'FAT' },
    ];
    const { applicable, refused } = planCutsForSection(sampleText, cuts, { safeTypesOnly: true });
    expect(applicable).toHaveLength(0);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toContain('not in the safe list');
  });

  it('allows non-safe cut types when safeTypesOnly=false', () => {
    const cuts = [
      { anchorQuote: 'introduction paragraph with some verbose', subtype: 'FAT' },
    ];
    const { applicable, refused } = planCutsForSection(sampleText, cuts, {
      safeTypesOnly: false,
      allowTypes: CUT_TYPES,
    });
    expect(applicable).toHaveLength(1);
    expect(refused).toHaveLength(0);
  });

  it('refuses overlapping cuts', () => {
    const cuts = [
      { anchorQuote: 'over-explains things unnecessarily by', subtype: 'OVER-EXPLAIN' },
      { anchorQuote: 'things unnecessarily by saying the same', subtype: 'REDUNDANT' },
    ];
    const { applicable, refused } = planCutsForSection(sampleText, cuts, { safeTypesOnly: true });
    expect(applicable).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toBe('Overlaps with another cut');
  });

  it('refuses quotes not found in text', () => {
    const cuts = [
      { anchorQuote: 'this text does not exist anywhere in the sample', subtype: 'OVER-EXPLAIN' },
    ];
    const { applicable, refused } = planCutsForSection(sampleText, cuts, { safeTypesOnly: true });
    expect(applicable).toHaveLength(0);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toBe('Quote not found in text');
  });
});

describe('applyCutsToText', () => {
  it('removes single cut and collapses blank lines', () => {
    const text = 'First sentence.\n\nMiddle sentence to cut.\n\nLast sentence.';
    // "Middle sentence to cut." starts at index 17 (after "First sentence.\n\n")
    // and ends at index 40 (17 + 23 chars)
    const applicable = [{ quote: 'Middle sentence to cut.', span: { start: 17, end: 40, method: 'exact' } }];
    const result = applyCutsToText(text, applicable);
    // After removing, we have "First sentence.\n\n\n\nLast sentence." which collapses to:
    expect(result).toBe('First sentence.\n\nLast sentence.');
  });

  it('removes multiple cuts in correct order', () => {
    const text = 'One. Two. Three. Four. Five.';
    // "Two. " starts at 5, ends at 10
    // "Four. " starts at 17, ends at 23
    const applicable = [
      { quote: 'Two. ', span: { start: 5, end: 10, method: 'exact' } },
      { quote: 'Four. ', span: { start: 17, end: 23, method: 'exact' } },
    ];
    const result = applyCutsToText(text, applicable);
    expect(result).toBe('One. Three. Five.');
  });
});

describe('filterCutComments', () => {
  it('filters to open cut-type comments only', () => {
    const comments = [
      { id: '1', status: 'open', subtype: 'OVER-EXPLAIN' },
      { id: '2', status: 'open', subtype: 'FAT' },
      { id: '3', status: 'dismissed', subtype: 'OVER-EXPLAIN' },
      { id: '4', status: 'open', subtype: null },
      { id: '5', status: 'accepted', subtype: 'REDUNDANT' },
      { id: '6', status: 'open', subtype: 'REDUNDANT' },
    ];
    const result = filterCutComments(comments);
    expect(result).toHaveLength(3);
    expect(result.map((c) => c.id)).toEqual(['1', '2', '6']);
  });
});

describe('filterSafeCutComments', () => {
  it('filters to open safe-type cuts only', () => {
    const comments = [
      { id: '1', status: 'open', subtype: 'OVER-EXPLAIN' },
      { id: '2', status: 'open', subtype: 'FAT' },
      { id: '3', status: 'open', subtype: 'REDUNDANT' },
      { id: '4', status: 'open', subtype: 'TELL' },
    ];
    const result = filterSafeCutComments(comments);
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.id)).toEqual(['1', '3']);
  });
});

describe('constants', () => {
  it('has expected CUT_TYPES', () => {
    expect(CUT_TYPES).toEqual(['OVER-EXPLAIN', 'REDUNDANT', 'FAT', 'GENERIC', 'TELL', 'STRUCTURAL']);
  });

  it('has expected SAFE_CUT_TYPES', () => {
    expect(SAFE_CUT_TYPES).toEqual(['OVER-EXPLAIN', 'REDUNDANT']);
  });

  it('has reasonable MIN_ANCHOR_CHARS', () => {
    expect(MIN_ANCHOR_CHARS).toBe(25);
  });
});
