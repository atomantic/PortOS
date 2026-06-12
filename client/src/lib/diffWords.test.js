import { describe, it, expect } from 'vitest';
import { diffWords, DIFF_CELL_CAP } from './diffWords.js';

describe('diffWords', () => {
  it('marks only the changed word on each side, leaving shared words unchanged', () => {
    const { tooLarge, oldRuns, newRuns } = diffWords('The cat sat', 'The dog sat');
    expect(tooLarge).toBe(false);
    const oldChanged = oldRuns.filter((r) => r.changed).map((r) => r.text.trim());
    const newChanged = newRuns.filter((r) => r.changed).map((r) => r.text.trim());
    expect(oldChanged).toEqual(['cat']);
    expect(newChanged).toEqual(['dog']);
    // Reassembling the runs reproduces each side verbatim.
    expect(oldRuns.map((r) => r.text).join('')).toBe('The cat sat');
    expect(newRuns.map((r) => r.text).join('')).toBe('The dog sat');
  });

  it('treats null/undefined as empty strings', () => {
    const { oldRuns, newRuns } = diffWords(null, undefined);
    expect(oldRuns.map((r) => r.text).join('')).toBe('');
    expect(newRuns.map((r) => r.text).join('')).toBe('');
  });

  it('merges consecutive changed words into a single run', () => {
    const { newRuns } = diffWords('a d', 'a b c d');
    // "b c " inserted between the shared "a " and "d" → one changed run.
    const changed = newRuns.filter((r) => r.changed);
    expect(changed).toHaveLength(1);
    expect(changed[0].text.trim()).toBe('b c');
  });

  it('reports every word as changed when there is no overlap', () => {
    const { oldRuns, newRuns } = diffWords('alpha', 'omega');
    expect(oldRuns.every((r) => r.changed)).toBe(true);
    expect(newRuns.every((r) => r.changed)).toBe(true);
  });

  it('bails to tooLarge when the DP cell product exceeds the cap', () => {
    const build = (p) => Array.from({ length: 2500 }, (_, i) => `${p}${i}`).join(' ');
    const { tooLarge, oldRuns, newRuns } = diffWords(build('a'), build('b'));
    expect(tooLarge).toBe(true);
    // Fallback collapses each side to one changed run (no per-word LCS work).
    expect(oldRuns).toHaveLength(1);
    expect(newRuns).toHaveLength(1);
  });

  it('keeps a localized edit granular in a text far past the cap size', () => {
    const words = Array.from({ length: 6000 }, (_, i) => `w${i}`);
    const oldStr = words.join(' ');
    const changed = words.slice();
    changed[3000] = 'REPLACED';
    const newStr = changed.join(' ');
    const { tooLarge, oldRuns, newRuns } = diffWords(oldStr, newStr);
    // 6000×6000 words would blow the cap; prefix/suffix trim reduces it to the
    // one differing token, so the diff stays word-granular.
    expect(tooLarge).toBe(false);
    expect(oldRuns.filter((r) => r.changed).map((r) => r.text)).toEqual(['w3000']);
    expect(newRuns.filter((r) => r.changed).map((r) => r.text)).toEqual(['REPLACED']);
    expect(oldRuns.map((r) => r.text).join('')).toBe(oldStr);
    expect(newRuns.map((r) => r.text).join('')).toBe(newStr);
  });

  it('stays under the cap when one side is short even if the other is long', () => {
    const long = Array.from({ length: 5000 }, (_, i) => `w${i}`).join(' ');
    expect(diffWords(long, 'x').tooLarge).toBe(false);
  });

  it('exports the documented cap', () => {
    expect(DIFF_CELL_CAP).toBe(4_000_000);
  });
});
