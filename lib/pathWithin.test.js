/**
 * The test memo treats a path built by `pathWithin()` as inside its directory
 * (scripts/lib/testMemo/pathValues.js, `guardedJoin`), so a path that leaves must throw
 * here: a wrong answer would let the memo skip a test whose input changed.
 */
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pathWithin } from './pathWithin.js';
import { pathWithin as scriptsPathWithin } from '../scripts/lib/pathWithin.js';

const DIR = resolve('fixtures', 'prompts');

describe('pathWithin', () => {
  it('joins like path.join when the result stays inside the directory', () => {
    expect(pathWithin(DIR, 'stages', 'a.md')).toBe(join(DIR, 'stages', 'a.md'));
    // A leading separator is a plain segment to join(), and a climb that comes back is still inside.
    expect(pathWithin(DIR, '/fonts/inter.woff2')).toBe(join(DIR, 'fonts', 'inter.woff2'));
    expect(pathWithin(DIR, 'stages', '..', 'a.md')).toBe(join(DIR, 'a.md'));
    expect(pathWithin(DIR)).toBe(DIR);
    expect(pathWithin(DIR, '..name.md')).toBe(join(DIR, '..name.md'));
    expect(pathWithin('relative/dir', 'a.md')).toBe(join('relative/dir', 'a.md'));
  });

  it.each([
    ['a parent', ['..']],
    ['a climb through a child', ['stages', '..', '..', 'other.md']],
    ['a climb in one segment', ['../../client/src/limits.js']],
    ['a sibling that shares the directory name as a prefix', ['..', 'prompts-old', 'a.md']],
    ['a climb after a leading separator', ['/../x']],
  ])('throws for %s', (_label, segments) => {
    expect(() => pathWithin(DIR, ...segments)).toThrow(RangeError);
  });

  it('is the same function under the scripts/ name the memo also trusts', () => {
    expect(scriptsPathWithin).toBe(pathWithin);
  });

  it('checks a relative directory against the working directory it resolves from', () => {
    expect(() => pathWithin('relative/dir', `..${sep}..${sep}..${sep}x`)).toThrow(/outside relative\/dir/);
  });
});
