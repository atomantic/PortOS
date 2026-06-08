import { describe, it, expect } from 'vitest';
import {
  CHANGE_TOKEN_DOMAINS,
  bumpChangeToken,
  getChangeToken,
} from './changeToken.js';

describe('changeToken registry', () => {
  it('exposes the known domains', () => {
    expect(CHANGE_TOKEN_DOMAINS).toEqual(['universe', 'pipeline', 'storyBuilder']);
  });

  it('starts at 0 for an un-bumped domain', () => {
    // storyBuilder is not bumped by any other case in this file
    expect(getChangeToken('storyBuilder')).toBe(0);
  });

  it('bump increments the domain counter monotonically', () => {
    const before = getChangeToken('universe');
    bumpChangeToken('universe');
    expect(getChangeToken('universe')).toBe(before + 1);
    bumpChangeToken('universe');
    expect(getChangeToken('universe')).toBe(before + 2);
  });

  it('reads do not bump', () => {
    const a = getChangeToken('pipeline');
    const b = getChangeToken('pipeline');
    expect(a).toBe(b);
  });

  it('keeps per-domain counters independent', () => {
    const pipeBefore = getChangeToken('pipeline');
    const uniBefore = getChangeToken('universe');
    bumpChangeToken('pipeline');
    expect(getChangeToken('pipeline')).toBe(pipeBefore + 1);
    expect(getChangeToken('universe')).toBe(uniBefore); // untouched
  });

  it('fails fast on an unknown domain at bump', () => {
    expect(() => bumpChangeToken('bogus')).toThrow(/unknown domain "bogus"/);
  });

  it('fails fast on an unknown domain at get', () => {
    expect(() => getChangeToken('bogus')).toThrow(/unknown domain "bogus"/);
  });
});
