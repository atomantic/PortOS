import { describe, it, expect, vi, afterEach } from 'vitest';
import { uuidv4 } from './uuid.js';

const V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('uuidv4', () => {
  it('returns a spec-valid v4 uuid', () => {
    expect(uuidv4()).toMatch(V4_RE);
  });

  it('returns distinct ids across calls', () => {
    const ids = new Set(Array.from({ length: 200 }, () => uuidv4()));
    expect(ids.size).toBe(200);
  });

  it('uses the native crypto.randomUUID when the context is secure', () => {
    const spy = vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue('11111111-2222-4333-8444-555555555555');
    expect(uuidv4()).toBe('11111111-2222-4333-8444-555555555555');
    expect(spy).toHaveBeenCalled();
  });

  // The regression this helper exists for: `crypto.randomUUID` only exists in
  // a secure context, so on PortOS over plain HTTP via Tailscale a bare
  // `crypto.randomUUID()` threw out of every toast. Each degraded environment
  // below must still yield a spec-valid v4 rather than throw.
  describe('insecure origin (PortOS over plain HTTP via Tailscale)', () => {
    it('falls back when randomUUID is absent but getRandomValues works', () => {
      vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
      expect(globalThis.crypto.randomUUID).toBeUndefined();
      expect(uuidv4()).toMatch(V4_RE);
    });

    it('falls back when randomUUID exists but returns nothing (stubbed/polyfilled)', () => {
      vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(undefined);
      expect(uuidv4()).toMatch(V4_RE);
    });

    it('falls back to Math.random when crypto has neither method', () => {
      vi.stubGlobal('crypto', {});
      expect(uuidv4()).toMatch(V4_RE);
    });

    it('does not throw when there is no crypto global at all', () => {
      vi.stubGlobal('crypto', undefined);
      expect(() => uuidv4()).not.toThrow();
      expect(uuidv4()).toMatch(V4_RE);
    });
  });
});
