import { describe, it, expect, vi, beforeEach } from 'vitest';

const net = { fetchPublicBinary: vi.fn() };
vi.mock('../../lib/safeUrlFetch.js', () => net);
vi.mock('./db.js', () => ({ getBoard: vi.fn() }));
vi.mock('../sharing/recordEvents.js', () => ({ emitRecordUpdated: vi.fn() }));
vi.mock('../../lib/backupSnapshotBoundary.js', () => ({ withBackupAssetPublication: (fn) => fn() }));

const { localizeImageUrl } = await import('./localize.js');

describe('localizeImageUrl', () => {
  beforeEach(() => net.fetchPublicBinary.mockReset());

  it('refuses private and loopback hosts, since item URLs also arrive through peer sync', async () => {
    net.fetchPublicBinary.mockResolvedValue(null);
    expect(await localizeImageUrl('http://192.0.2.10/internal.png')).toBe('http://192.0.2.10/internal.png');
    expect(net.fetchPublicBinary).toHaveBeenCalledTimes(1);
    expect(net.fetchPublicBinary.mock.calls[0][1]).toMatchObject({ blockPrivate: true, throwOnUnsafe: false });
  });
});
