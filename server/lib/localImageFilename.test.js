import { describe, it, expect } from 'vitest';
import { localImageFilename, assetBasename } from './localImageFilename.js';

describe('localImageFilename', () => {
  it('returns null for non-string / empty input', () => {
    expect(localImageFilename(undefined)).toBe(null);
    expect(localImageFilename(null)).toBe(null);
    expect(localImageFilename(42)).toBe(null);
    expect(localImageFilename('')).toBe(null);
    expect(localImageFilename('   ')).toBe(null);
  });

  it('rejects external URLs (the receiver fetches those itself)', () => {
    expect(localImageFilename('https://example.com/a.png')).toBe(null);
    expect(localImageFilename('http://example.com/a.png')).toBe(null);
    expect(localImageFilename('HTTPS://EXAMPLE.com/a.png')).toBe(null);
    expect(localImageFilename('data:image/png;base64,AAAA')).toBe(null);
    expect(localImageFilename('blob:http://x/abc')).toBe(null);
  });

  it('strips the /data/images/ mount prefix to the basename', () => {
    expect(localImageFilename('/data/images/photo.png')).toBe('photo.png');
    expect(localImageFilename('/data/images/nested/photo.png')).toBe('photo.png');
  });

  it('accepts a bare filename', () => {
    expect(localImageFilename('photo.png')).toBe('photo.png');
  });

  it('rejects any other absolute path (videos, image-refs, etc.)', () => {
    expect(localImageFilename('/data/videos/clip.mp4')).toBe(null);
    expect(localImageFilename('/data/image-refs/ref.png')).toBe(null);
    expect(localImageFilename('/etc/passwd')).toBe(null);
  });

  it('strips querystring / hash before taking the basename', () => {
    expect(localImageFilename('/data/images/photo.png?v=2')).toBe('photo.png');
    expect(localImageFilename('photo.png#frag')).toBe('photo.png');
    expect(localImageFilename('/data/images/photo.png?a=1#b')).toBe('photo.png');
  });

  it('trims surrounding whitespace', () => {
    expect(localImageFilename('  /data/images/photo.png  ')).toBe('photo.png');
  });

  it('returns null when the basename collapses to empty', () => {
    expect(localImageFilename('/data/images/')).toBe(null);
  });
});

describe('assetBasename', () => {
  it('returns null for non-string input', () => {
    expect(assetBasename(undefined)).toBe(null);
    expect(assetBasename(null)).toBe(null);
    expect(assetBasename(42)).toBe(null);
  });

  it('takes the basename of a path segment', () => {
    expect(assetBasename('photo.png')).toBe('photo.png');
    expect(assetBasename('nested/photo.png')).toBe('photo.png');
    expect(assetBasename('a/b/c/photo.png')).toBe('photo.png');
  });

  it('strips querystring / hash before taking the basename', () => {
    expect(assetBasename('photo.png?v=2')).toBe('photo.png');
    expect(assetBasename('photo.png#frag')).toBe('photo.png');
    expect(assetBasename('nested/photo.png?a=1#b')).toBe('photo.png');
  });

  it('returns null when the basename collapses to empty', () => {
    expect(assetBasename('')).toBe(null);
    expect(assetBasename('nested/')).toBe(null);
    expect(assetBasename('?v=2')).toBe(null);
  });
});
