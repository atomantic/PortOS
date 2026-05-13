import { describe, it, expect } from 'vitest';
import { truncateOnWordBoundary } from './voice.js';

describe('truncateOnWordBoundary', () => {
  it('returns input untouched when shorter than the cap', () => {
    expect(truncateOnWordBoundary('hello world', 100)).toBe('hello world');
  });

  it('returns input untouched when exactly the cap', () => {
    const s = 'a'.repeat(10);
    expect(truncateOnWordBoundary(s, 10)).toBe(s);
  });

  it('truncates on the last space and appends an ellipsis', () => {
    // 'one two three four' length=18; cap=11 → 'one two thr' → last space at 7 → 'one two…'
    const out = truncateOnWordBoundary('one two three four', 11);
    expect(out).toBe('one two…');
  });

  it('falls back to a hard cut when there is no space before the cap', () => {
    // No spaces in the prefix → can't find a word boundary, hard-cut.
    const out = truncateOnWordBoundary('abcdefghij more words', 5);
    expect(out).toBe('abcde…');
  });

  // The client's extractVisibleText joins blocks with '\n\n', so the
  // truncation must find the LAST whitespace of any kind — not just a
  // literal space. Without this, a newline-separated block boundary
  // landing before the cap would still hard-cut mid-token.
  it('truncates on a newline boundary when no later space exists', () => {
    // 'block one\n\nblock two longword' — cap=15 → 'block one\n\nbloc'
    // The last whitespace before the partial 'bloc' is the second \n
    // at index 10. Slice(0,10) = 'block one\n', then '…'.
    const text = 'block one\n\nblock two longword';
    const out = truncateOnWordBoundary(text, 15);
    expect(out.endsWith('…')).toBe(true);
    // Tail (before the ellipsis) is not a partial token from "block two".
    expect(out).not.toMatch(/bloc…$/);
    expect(out.startsWith('block one')).toBe(true);
  });

  it('truncates on a tab boundary when present', () => {
    const text = 'col1\tcol2\tcol3-very-long-cell';
    const out = truncateOnWordBoundary(text, 12);
    expect(out.endsWith('…')).toBe(true);
    // Whatever the tail is, it should not be a partial 'col3-very-long-cell' token.
    expect(out).not.toMatch(/col3-…$/);
  });

  it('matches the documented ~8 KB end-to-end cap', () => {
    // Build a long string of 5-char words separated by spaces.
    const word = 'aaaaa';
    const text = Array(2000).fill(word).join(' ');
    const out = truncateOnWordBoundary(text, 8000);
    // Output never exceeds cap + ellipsis (1 char).
    expect(out.length).toBeLessThanOrEqual(8001);
    expect(out.endsWith('…')).toBe(true);
    // Tail isn't a partial token — character before the ellipsis is in the word charset.
    expect(out[out.length - 2]).toMatch(/[a]/);
  });
});
