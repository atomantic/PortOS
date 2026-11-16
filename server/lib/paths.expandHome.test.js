import { describe, it, expect } from 'vitest';
import { homedir } from 'os';

import { expandHome } from './paths.js';

describe('fileUtils', () => {
  describe('expandHome', () => {
    it('expands a bare `~` to the homedir', () => {
      expect(expandHome('~')).toBe(homedir());
    });

    it('expands `~/foo` to homedir + foo', () => {
      const out = expandHome('~/foo');
      expect(out.startsWith(homedir())).toBe(true);
      expect(out.endsWith('foo')).toBe(true);
    });

    it('expands the Windows form `~\\foo` so `lib/fileUtils.js` stays cross-platform', () => {
      const out = expandHome('~\\foo');
      expect(out.startsWith(homedir())).toBe(true);
      expect(out.endsWith('foo')).toBe(true);
    });

    it('preserves absolute, relative, and empty inputs', () => {
      expect(expandHome('/abs/path')).toBe('/abs/path');
      expect(expandHome('relative/path')).toBe('relative/path');
      expect(expandHome('')).toBe('');
    });

    it('preserves non-string inputs (null / undefined / number) without throwing', () => {
      expect(expandHome(null)).toBe(null);
      expect(expandHome(undefined)).toBe(undefined);
      expect(expandHome(42)).toBe(42);
    });

    it('only expands a leading `~` — embedded `~` chars are preserved (iCloud~md~obsidian)', () => {
      expect(expandHome('iCloud~md~obsidian')).toBe('iCloud~md~obsidian');
      expect(expandHome('foo/~bar')).toBe('foo/~bar');
    });
  });
});
