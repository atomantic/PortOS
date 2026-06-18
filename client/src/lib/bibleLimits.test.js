import { describe, it, expect } from 'vitest';
import { BIBLE_LIMITS, capImageRefs } from './bibleLimits.js';

describe('capImageRefs', () => {
  it('returns the list unchanged when at or under the cap', () => {
    const refs = ['a.png', 'b.png'];
    expect(capImageRefs(refs)).toBe(refs); // same reference — no copy
  });

  it('keeps only the most recent N when over the cap', () => {
    const max = BIBLE_LIMITS.IMAGE_REFS_PER_ENTRY_MAX;
    const refs = Array.from({ length: max + 3 }, (_, i) => `r${i}.png`);
    const capped = capImageRefs(refs);
    expect(capped).toHaveLength(max);
    expect(capped[0]).toBe('r3.png'); // dropped the 3 oldest
    expect(capped[capped.length - 1]).toBe(`r${max + 2}.png`);
  });
});
