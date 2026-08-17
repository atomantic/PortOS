// The URL builder is the single place that decides whether a sprite asset's
// URL carries a content token (#3020). Every strip surface depends on it, so
// its no-token fallback has to stay byte-identical to the pre-token URL — a
// drift there would silently version (or fail to version) every asset at once.
import { describe, it, expect } from 'vitest';
import { spriteAssetUrl, assetVersionToken } from './spriteAssets.js';

const REC = 'example-walker';
const STRIP = 'runs/walk-east-abc/generated/example-walk-east-strip.png';
const BARE = `/data/sprites/${REC}/${STRIP}`;

describe('spriteAssetUrl', () => {
  it('builds the un-versioned URL when no version is passed', () => {
    expect(spriteAssetUrl(REC, STRIP)).toBe(BARE);
  });

  it('encodes each path segment separately, leaving the separators intact', () => {
    // A record id or filename with a space/# must encode, but the `/` between
    // segments must NOT — encoding the whole path would 404 the static mount.
    expect(spriteAssetUrl('my walker', 'runs/a b/strip #1.png'))
      .toBe('/data/sprites/my%20walker/runs/a%20b/strip%20%231.png');
  });

  it('appends the ?v= token when a version string is passed', () => {
    expect(spriteAssetUrl(REC, STRIP, 'c432029004b5')).toBe(`${BARE}?v=c432029004b5`);
  });

  // Regression: this builder used to clamp the token to 12 chars. An
  // `mtimeMs-size` stamp is 22 chars, so the clamp cut mid-mtime and dropped the
  // size component entirely — the half that catches a rewrite too fast for mtime
  // resolution. The token is now used verbatim; shortening is the caller's job,
  // because only the caller knows a hash from a composite.
  it('uses a composite mtime-size token verbatim rather than truncating it', () => {
    const composite = `${Date.now()}-10485760`;
    expect(composite.length).toBeGreaterThan(12); // the case the old clamp broke
    expect(spriteAssetUrl(REC, STRIP, composite)).toBe(`${BARE}?v=${composite}`);
  });

  it('keeps two composite tokens distinct when they differ only past char 12', () => {
    const mtime = Date.now();
    const a = spriteAssetUrl(REC, STRIP, `${mtime}-100`);
    const b = spriteAssetUrl(REC, STRIP, `${mtime}-200`);
    expect(a).not.toBe(b);
  });

  it('encodes a token that would otherwise break the query string', () => {
    expect(spriteAssetUrl(REC, STRIP, 'a&b=c')).toBe(`${BARE}?v=a%26b%3Dc`);
  });

  // A run that predates the version fields must render exactly as it does today
  // — never `?v=undefined`, which would be a cache-buster that never changes.
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['a non-string', 12345],
  ])('falls back to the un-versioned URL for %s', (_label, version) => {
    expect(spriteAssetUrl(REC, STRIP, version)).toBe(BARE);
  });
});

describe('assetVersionToken', () => {
  it('builds an mtime-size token from an asset row', () => {
    expect(assetVersionToken({ path: 'a.png', mtime: 1784945418439.7, size: 4096 })).toBe('1784945418440-4096');
  });

  it('changes when only the size changes — a rewrite too fast for mtime resolution', () => {
    const mtime = 1784945418439;
    expect(assetVersionToken({ mtime, size: 100 })).not.toBe(assetVersionToken({ mtime, size: 200 }));
  });

  it('tokenizes a legitimately zero-byte asset rather than treating it as missing', () => {
    expect(assetVersionToken({ mtime: 1784945418439, size: 0 })).toBe('1784945418439-0');
  });

  it.each([
    ['an asset with no stat fields', { path: 'x.png' }],
    ['a zero mtime', { mtime: 0, size: 10 }],
    ['undefined', undefined],
    ['null', null],
  ])('returns undefined for %s so the URL stays un-versioned', (_label, asset) => {
    expect(assetVersionToken(asset)).toBeUndefined();
  });
});
// @vitest-environment node
