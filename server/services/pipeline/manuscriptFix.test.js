import { describe, it, expect } from 'vitest';
import { locateFindSpan } from './manuscriptFix.js';

describe('locateFindSpan', () => {
  it('locates an exact substring', () => {
    const text = 'PAGE 56\nPANEL 1\nGiant stands.';
    expect(locateFindSpan(text, 'PANEL 1\nGiant')).toEqual({ start: 8, end: 8 + 'PANEL 1\nGiant'.length });
  });

  it('tolerates whitespace-only differences in the quote (LLM reformatting)', () => {
    // The manuscript has a single newline; the quoted `find` added a blank line.
    const text = 'PAGE 56\nPANEL 1\nLow angle. Giant stands.\nPANEL 2\nHe falls.';
    const find = 'PAGE 56\n\nPANEL 1\nLow angle. Giant stands.';
    const span = locateFindSpan(text, find);
    expect(span).not.toBeNull();
    // The matched span covers the ORIGINAL (single-newline) text, not find.length.
    expect(text.slice(span.start, span.end)).toBe('PAGE 56\nPANEL 1\nLow angle. Giant stands.');
    expect(span.end - span.start).toBe(find.length - 1);
  });

  it('returns null when the text is genuinely absent', () => {
    expect(locateFindSpan('hello world', 'not here at all')).toBeNull();
  });

  it('returns null for an empty find', () => {
    expect(locateFindSpan('anything', '')).toBeNull();
  });

  it('prefers an exact match over a fuzzy one when both exist', () => {
    // "run away." matches exactly at index 0; the second occurrence only matches
    // via whitespace tolerance (tab). Exact wins regardless of the anchor.
    const text = 'run away.\n\n[marker] run\taway.';
    expect(locateFindSpan(text, 'run away.', '[marker]').start).toBe(0);
  });

  it('disambiguates between two fuzzy-only matches by the nearest anchorQuote', () => {
    // No exact match (find uses a space; both occurrences use a tab), so both
    // resolve only via the whitespace-tolerant regex. The anchor sits beside the
    // SECOND occurrence, so that span is chosen.
    const text = 'run\taway. ... ... ... [marker] run\taway.';
    const span = locateFindSpan(text, 'run away.', '[marker]');
    const second = text.indexOf('run\taway.', 1);
    expect(span.start).toBe(second);
    expect(text.slice(span.start, span.end)).toBe('run\taway.');
  });

  it('escapes regex metacharacters in the quote', () => {
    const text = 'Cost is $5 (approx).';
    expect(locateFindSpan(text, '$5 (approx)')).toEqual({ start: 8, end: 8 + '$5 (approx)'.length });
  });
});
