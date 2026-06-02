import { describe, it, expect } from 'vitest';
import { isUrl, normalizeUrl } from './urlNormalize';

describe('isUrl', () => {
  it('detects explicit http/https schemes', () => {
    expect(isUrl('http://example.com')).toBe(true);
    expect(isUrl('https://example.com')).toBe(true);
    expect(isUrl('HTTPS://EXAMPLE.COM')).toBe(true);
  });

  it('detects git@ ssh remotes', () => {
    expect(isUrl('git@github.com:owner/repo.git')).toBe(true);
  });

  it('detects bare domain-like tokens', () => {
    expect(isUrl('example.com')).toBe(true);
    expect(isUrl('sub.example.co.uk/path')).toBe(true);
  });

  it('rejects free text and whitespace-only input', () => {
    expect(isUrl('just a thought')).toBe(false);
    expect(isUrl('hello')).toBe(false);
    expect(isUrl('   ')).toBe(false);
    expect(isUrl('')).toBe(false);
  });

  it('rejects domain-like tokens that contain whitespace', () => {
    // DOMAIN_PATTERN requires a single non-space token
    expect(isUrl('foo. bar')).toBe(false);
  });

  it('trims before detecting', () => {
    expect(isUrl('  example.com  ')).toBe(true);
  });

  it('tolerates null/undefined', () => {
    expect(isUrl(null)).toBe(false);
    expect(isUrl(undefined)).toBe(false);
  });
});

describe('normalizeUrl', () => {
  it('returns null for empty / whitespace-only input', () => {
    expect(normalizeUrl('')).toBe(null);
    expect(normalizeUrl('   ')).toBe(null);
    expect(normalizeUrl(null)).toBe(null);
    expect(normalizeUrl(undefined)).toBe(null);
  });

  it('leaves existing http/https schemes untouched', () => {
    expect(normalizeUrl('http://example.com')).toBe('http://example.com');
    expect(normalizeUrl('https://example.com')).toBe('https://example.com');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeUrl('  https://example.com  ')).toBe('https://example.com');
  });

  // --- allowGit option (LinksTab + QuickBrainCapture behavior) ---
  describe('allowGit: true (default)', () => {
    it('treats git@ as already-normalized', () => {
      expect(normalizeUrl('git@github.com:owner/repo.git', { allowGit: true }))
        .toBe('git@github.com:owner/repo.git');
    });

    it('prepends https to a bare domain', () => {
      expect(normalizeUrl('example.com', { allowGit: true })).toBe('https://example.com');
    });

    it('defaults allowGit to true', () => {
      expect(normalizeUrl('git@github.com:owner/repo.git'))
        .toBe('git@github.com:owner/repo.git');
    });
  });

  // --- FeedsTab behavior: no git@ handling ---
  describe('allowGit: false (FeedsTab)', () => {
    it('prepends https to a git@ string (does NOT treat it as a scheme)', () => {
      expect(normalizeUrl('git@github.com:owner/repo.git', { allowGit: false }))
        .toBe('https://git@github.com:owner/repo.git');
    });

    it('still leaves http/https untouched', () => {
      expect(normalizeUrl('http://feed.example.com/rss', { allowGit: false }))
        .toBe('http://feed.example.com/rss');
    });

    it('prepends https to a bare feed host with no dot requirement', () => {
      expect(normalizeUrl('feedhost', { allowGit: false })).toBe('https://feedhost');
    });
  });

  // --- requireDot option (LinksTab quick-add guard) ---
  describe('requireDot: true (LinksTab)', () => {
    it('prepends https when the value contains a dot', () => {
      expect(normalizeUrl('example.com', { allowGit: true, requireDot: true }))
        .toBe('https://example.com');
    });

    it('prepends https when the value contains github.com (even without a dot token match)', () => {
      expect(normalizeUrl('github.com', { allowGit: true, requireDot: true }))
        .toBe('https://github.com');
    });

    it('returns null for a bare word with no dot', () => {
      expect(normalizeUrl('notaurl', { allowGit: true, requireDot: true })).toBe(null);
    });

    it('still treats git@ as already-normalized under requireDot', () => {
      expect(normalizeUrl('git@github.com:owner/repo.git', { allowGit: true, requireDot: true }))
        .toBe('git@github.com:owner/repo.git');
    });
  });

  describe('parity with original LinksTab normalizeUrl', () => {
    const linksTabNormalize = (raw) => normalizeUrl(raw, { allowGit: true, requireDot: true });
    it('matches: empty -> null', () => expect(linksTabNormalize('  ')).toBe(null));
    it('matches: bare word -> null', () => expect(linksTabNormalize('hello')).toBe(null));
    it('matches: domain -> https', () => expect(linksTabNormalize('foo.bar')).toBe('https://foo.bar'));
    it('matches: git@ -> unchanged', () =>
      expect(linksTabNormalize('git@host:repo')).toBe('git@host:repo'));
  });
});
