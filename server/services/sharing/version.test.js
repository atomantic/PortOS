import { describe, it, expect, vi, } from 'vitest';

const readFileMock = vi.fn();
vi.mock('fs/promises', () => ({
  readFile: readFileMock,
}));

const version = await import('./version.js');

describe('sharing/version', () => {
  it('SHARING_SCHEMA_VERSION is a positive integer', () => {
    expect(Number.isInteger(version.SHARING_SCHEMA_VERSION)).toBe(true);
    expect(version.SHARING_SCHEMA_VERSION).toBeGreaterThan(0);
  });

  it('isManifestCompatible accepts same and older versions', () => {
    expect(version.isManifestCompatible(version.SHARING_SCHEMA_VERSION)).toBe(true);
    expect(version.isManifestCompatible(version.SHARING_SCHEMA_VERSION - 1)).toBe(true);
    expect(version.isManifestCompatible(0)).toBe(true);
  });

  it('isManifestCompatible refuses newer versions', () => {
    expect(version.isManifestCompatible(version.SHARING_SCHEMA_VERSION + 1)).toBe(false);
    expect(version.isManifestCompatible(999)).toBe(false);
  });

  it('isManifestCompatible refuses non-finite input', () => {
    expect(version.isManifestCompatible(null)).toBe(false);
    expect(version.isManifestCompatible(undefined)).toBe(false);
    expect(version.isManifestCompatible('1')).toBe(false);
    expect(version.isManifestCompatible(NaN)).toBe(false);
  });

  it('getProducedByVersion returns the package version when available', async () => {
    readFileMock.mockResolvedValueOnce(JSON.stringify({ version: '1.99.0' }));
    // The 60s internal cache means later tests in this file may see this
    // value too — we only assert the shape, not exact equality.
    const v = await version.getProducedByVersion();
    expect(v).toBe('1.99.0');
  });

  it("getProducedByVersion falls back to 'unknown' on read failure", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 65_000);
      readFileMock.mockRejectedValueOnce(new Error('boom'));
      const v = await version.getProducedByVersion();
      expect(v).toBe('unknown');
    } finally {
      vi.useRealTimers();
    }
  });
});
