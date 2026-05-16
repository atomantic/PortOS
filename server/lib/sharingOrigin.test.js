import { describe, it, expect } from 'vitest';
import { sanitizeOrigin } from './sharingOrigin.js';

describe('sharingOrigin.sanitizeOrigin', () => {
  it('returns null for non-objects', () => {
    expect(sanitizeOrigin(null)).toBeNull();
    expect(sanitizeOrigin(undefined)).toBeNull();
    expect(sanitizeOrigin('foo')).toBeNull();
    expect(sanitizeOrigin(42)).toBeNull();
  });

  it('returns null when load-bearing fields are missing', () => {
    expect(sanitizeOrigin({ bucketName: 'X' })).toBeNull(); // no bucketId/source/manifestId
    expect(sanitizeOrigin({ bucketId: 'b1', source: 'me' })).toBeNull(); // no manifestId
    expect(sanitizeOrigin({ bucketId: 'b1', manifestId: 'm1' })).toBeNull(); // no source
  });

  it('round-trips a well-formed origin', () => {
    const out = sanitizeOrigin({
      bucketId: 'b1',
      bucketName: 'Creative Circle',
      source: 'atomantic',
      sourceBio: 'Maker, dreamer',
      manifestId: 'm1',
      importedAt: '2026-05-15T12:00:00Z',
    });
    expect(out).toEqual({
      bucketId: 'b1',
      bucketName: 'Creative Circle',
      source: 'atomantic',
      sourceBio: 'Maker, dreamer',
      manifestId: 'm1',
      importedAt: '2026-05-15T12:00:00Z',
    });
  });

  it('defaults bucketName to bucketId when missing', () => {
    const out = sanitizeOrigin({ bucketId: 'b1', source: 'me', manifestId: 'm1' });
    expect(out.bucketName).toBe('b1');
  });

  it('coerces sourceBio absence to null', () => {
    const out = sanitizeOrigin({ bucketId: 'b1', source: 'me', manifestId: 'm1' });
    expect(out.sourceBio).toBeNull();
  });

  it('stamps importedAt when missing', () => {
    const before = Date.now();
    const out = sanitizeOrigin({ bucketId: 'b1', source: 'me', manifestId: 'm1' });
    const ts = Date.parse(out.importedAt);
    expect(ts).toBeGreaterThanOrEqual(before);
  });

  it('trims strings to their limits', () => {
    const longSource = 'x'.repeat(500);
    const out = sanitizeOrigin({ bucketId: 'b1', source: longSource, manifestId: 'm1' });
    expect(out.source.length).toBeLessThanOrEqual(120);
  });
});
