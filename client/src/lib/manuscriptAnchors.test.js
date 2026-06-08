import { describe, it, expect } from 'vitest';
import { locateFind, locateFindSpan, locateAnchors, buildHighlightSegments } from './manuscriptAnchors.js';

describe('locateFind', () => {
  it('returns the only occurrence when unique', () => {
    expect(locateFind('the quick brown fox', 'brown')).toBe(10);
  });

  it('returns -1 when absent', () => {
    expect(locateFind('hello world', 'xyz')).toBe(-1);
  });

  it('disambiguates a recurring find by nearest anchorQuote', () => {
    const text = 'door alpha beta gamma delta [marker] door omega';
    const second = text.indexOf('door', 1);
    // The "[marker]" anchor sits right before the second "door", so that's the
    // occurrence chosen — not the first.
    expect(locateFind(text, 'door', '[marker]')).toBe(second);
    expect(second).toBeGreaterThan(0);
  });

  it('falls back to the first match when no anchor is given', () => {
    const text = 'door ... door';
    expect(locateFind(text, 'door')).toBe(0);
  });
});

describe('locateFindSpan', () => {
  it('returns the exact span when present', () => {
    const text = 'PAGE 56\nPANEL 1\nGiant.';
    expect(locateFindSpan(text, 'PANEL 1')).toEqual({ start: 8, end: 15 });
  });

  it('tolerates whitespace-only differences and returns the original span', () => {
    const text = 'PAGE 56\nPANEL 1\nGiant stands.';
    const find = 'PAGE 56\n\nPANEL 1\nGiant stands.';
    const span = locateFindSpan(text, find);
    expect(text.slice(span.start, span.end)).toBe('PAGE 56\nPANEL 1\nGiant stands.');
    expect(span.end - span.start).toBe(find.length - 1);
  });

  it('returns null when truly absent or empty', () => {
    expect(locateFindSpan('hello', 'nope')).toBeNull();
    expect(locateFindSpan('hello', '')).toBeNull();
  });
});

describe('locateAnchors', () => {
  const content = 'She crept down the hall. The door slammed shut.';
  it('resolves present anchors to spans and drops absent ones', () => {
    const spans = locateAnchors(content, [
      { id: 'a', severity: 'high', anchorQuote: 'door slammed' },
      { id: 'b', severity: 'low', anchorQuote: 'not in the text' },
      { id: 'c', severity: 'medium', anchorQuote: '' },
    ]);
    expect(spans).toEqual([
      { commentId: 'a', severity: 'high', start: content.indexOf('door slammed'), end: content.indexOf('door slammed') + 'door slammed'.length },
    ]);
  });
});

describe('buildHighlightSegments', () => {
  it('returns one plain segment when there are no spans', () => {
    expect(buildHighlightSegments('hello', [])).toEqual([{ text: 'hello', commentIds: [], topSeverity: null }]);
  });

  it('tiles content into plain + highlighted segments', () => {
    const text = 'abcdef';
    const segs = buildHighlightSegments(text, [{ commentId: 'x', severity: 'medium', start: 2, end: 4 }]);
    expect(segs.map((s) => s.text).join('')).toBe(text);
    expect(segs).toEqual([
      { text: 'ab', commentIds: [], topSeverity: null },
      { text: 'cd', commentIds: ['x'], topSeverity: 'medium' },
      { text: 'ef', commentIds: [], topSeverity: null },
    ]);
  });

  it('merges overlapping spans into a segment carrying both, toned by top severity', () => {
    const text = 'abcdefgh';
    const segs = buildHighlightSegments(text, [
      { commentId: 'x', severity: 'low', start: 1, end: 5 },
      { commentId: 'y', severity: 'high', start: 3, end: 7 },
    ]);
    expect(segs.map((s) => s.text).join('')).toBe(text);
    const overlap = segs.find((s) => s.commentIds.length === 2);
    expect(overlap.text).toBe('de');
    expect(overlap.topSeverity).toBe('high');
  });

  it('clamps out-of-range spans and drops empty ones', () => {
    const segs = buildHighlightSegments('abc', [
      { commentId: 'x', severity: 'low', start: -5, end: 2 },
      { commentId: 'y', severity: 'low', start: 2, end: 2 },
    ]);
    expect(segs.map((s) => s.text).join('')).toBe('abc');
    expect(segs[0]).toEqual({ text: 'ab', commentIds: ['x'], topSeverity: 'low' });
  });
});
