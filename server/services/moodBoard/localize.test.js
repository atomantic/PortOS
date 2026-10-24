import { describe, it, expect, vi, beforeEach } from 'vitest';

const net = { fetchPublicBinary: vi.fn() };
const writeFileGuarded = vi.fn(async () => {});
vi.mock('../../lib/safeUrlFetch.js', () => net);
vi.mock('./db.js', () => ({ getBoard: vi.fn() }));
vi.mock('../sharing/recordEvents.js', () => ({ emitRecordUpdated: vi.fn() }));
vi.mock('../../lib/backupSnapshotBoundary.js', () => ({ withBackupAssetPublication: (fn) => fn() }));
vi.mock('../../lib/fileUtils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  PATHS: { images: '/mock/images' },
  ensureDir: vi.fn(async () => {}),
  writeFileGuarded: (...args) => writeFileGuarded(...args),
}));

const { localizeImageUrl } = await import('./localize.js');

describe('localizeImageUrl', () => {
  beforeEach(() => {
    net.fetchPublicBinary.mockReset();
    writeFileGuarded.mockClear();
  });

  it('refuses private and loopback hosts, since item URLs also arrive through peer sync', async () => {
    net.fetchPublicBinary.mockResolvedValue(null);
    expect(await localizeImageUrl('http://192.0.2.10/internal.png')).toBe('http://192.0.2.10/internal.png');
    expect(net.fetchPublicBinary).toHaveBeenCalledTimes(1);
    expect(net.fetchPublicBinary.mock.calls[0][1]).toMatchObject({ blockPrivate: true, throwOnUnsafe: false });
  });

  it('decodes a valid data:image/*;base64 URL into a local /data/images/board-<sha1>.<ext> file', async () => {
    // Minimal 12-byte RIFF WEBP container (RIFF size = 4 bytes following byte 7).
    const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
    const dataUrl = `data:image/webp;base64,${webp.toString('base64')}`;
    const result = await localizeImageUrl(dataUrl);
    expect(result).toMatch(/^\/data\/images\/board-[0-9a-f]{16}\.webp$/);
    expect(writeFileGuarded).toHaveBeenCalledTimes(1);
    expect(writeFileGuarded.mock.calls[0][1]).toEqual(webp);
    expect(net.fetchPublicBinary).not.toHaveBeenCalled();
  });

  it('rejects a truncated WebP or malformed data:image URL with a 400 ServerError instead of storing raw data:', async () => {
    // RIFF header declaring 0x2114 bytes (8468 bytes) but truncated after 12 bytes.
    const truncatedWebp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x14, 0x21, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
    await expect(localizeImageUrl(`data:image/webp;base64,${truncatedWebp.toString('base64')}`))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_IMAGE_DATA_URL' });
    await expect(localizeImageUrl(`data:image/png;base64,${Buffer.from('not-an-image').toString('base64')}`))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_IMAGE_DATA_URL' });
    expect(writeFileGuarded).not.toHaveBeenCalled();
  });
});
