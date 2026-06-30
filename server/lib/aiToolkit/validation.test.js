import { describe, it, expect } from 'vitest';
import { sanitizeScreenshotRefs } from './validation.js';

describe('sanitizeScreenshotRefs — POST /api/runs screenshot hardening (#1870)', () => {
  it('keeps an in-dir image basename unchanged', () => {
    expect(sanitizeScreenshotRefs(['shot.png'])).toEqual({ safe: ['shot.png'], rejected: [] });
  });

  it('neutralizes the legit absolute path the RunnerPage uploads under data/screenshots to its basename', () => {
    // /api/screenshots returns an absolute `path`; the RunnerPage forwards it
    // verbatim — basename rebases it to a screenshots-dir-relative ref.
    expect(sanitizeScreenshotRefs(['/home/user/portos/data/screenshots/grab.png']))
      .toEqual({ safe: ['grab.png'], rejected: [] });
  });

  it('rejects `../` traversal that escapes to a non-image file', () => {
    const { safe, rejected } = sanitizeScreenshotRefs(['../../../../etc/passwd']);
    expect(safe).toEqual([]);
    expect(rejected).toEqual(['../../../../etc/passwd']);
  });

  it('rejects an absolute path to a non-image file outside the screenshots dir', () => {
    const { safe, rejected } = sanitizeScreenshotRefs(['/etc/passwd']);
    expect(safe).toEqual([]);
    expect(rejected).toEqual(['/etc/passwd']);
  });

  it('collapses a traversal path that happens to end in an image extension to a harmless in-dir basename', () => {
    // basename neutralizes the escape; the result is a screenshots-dir ref that
    // simply won't exist (the loader then skips it) — never an arbitrary read.
    expect(sanitizeScreenshotRefs(['../../secret/evil.png'])).toEqual({ safe: ['evil.png'], rejected: [] });
  });

  it('rejects disallowed extensions and dotfiles with no extension', () => {
    expect(sanitizeScreenshotRefs(['notes.txt', '.env']))
      .toEqual({ safe: [], rejected: ['notes.txt', '.env'] });
  });

  it('is case-insensitive on the extension allow-list', () => {
    expect(sanitizeScreenshotRefs(['Shot.PNG', 'pic.JPEG']))
      .toEqual({ safe: ['Shot.PNG', 'pic.JPEG'], rejected: [] });
  });

  it('partitions a mixed list into safe + rejected', () => {
    const { safe, rejected } = sanitizeScreenshotRefs([
      'a.png',
      '../../../../etc/passwd',
      'b.webp',
      'readme.md',
    ]);
    expect(safe).toEqual(['a.png', 'b.webp']);
    expect(rejected).toEqual(['../../../../etc/passwd', 'readme.md']);
  });

  it('treats non-string and empty entries as rejected', () => {
    const { safe, rejected } = sanitizeScreenshotRefs(['ok.png', '', 42, null]);
    expect(safe).toEqual(['ok.png']);
    expect(rejected).toEqual(['', '42', 'null']);
  });

  it('returns empty partitions for a non-array input', () => {
    expect(sanitizeScreenshotRefs(undefined)).toEqual({ safe: [], rejected: [] });
    expect(sanitizeScreenshotRefs('x.png')).toEqual({ safe: [], rejected: [] });
  });
});
