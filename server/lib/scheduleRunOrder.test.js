import { describe, it, expect } from 'vitest';
import { normalizeSuggestedAfter, SUGGESTED_AFTER_MAX } from './scheduleRunOrder.js';

describe('normalizeSuggestedAfter', () => {
  it('drops blanks, duplicates and self-references while keeping the chosen order', () => {
    expect(normalizeSuggestedAfter(['  simplify ', '', 'me', 'simplify', 'module-hygiene'], 'me'))
      .toEqual(['simplify', 'module-hygiene']);
  });

  it('treats a non-array (absent, null, a string) as no suggestion', () => {
    expect(normalizeSuggestedAfter(undefined)).toEqual([]);
    expect(normalizeSuggestedAfter(null)).toEqual([]);
    expect(normalizeSuggestedAfter('simplify')).toEqual([]);
  });

  it('caps a hand-edited list so a schedule file cannot grow one without bound', () => {
    const huge = Array.from({ length: SUGGESTED_AFTER_MAX + 5 }, (_, i) => `task-${i}`);
    expect(normalizeSuggestedAfter(huge)).toHaveLength(SUGGESTED_AFTER_MAX);
  });
});
