/**
 * A peer pull against a backup cut (#9982). The download runs outside admission;
 * the write that lands the bytes (and, for images, the index row that names
 * them) holds the lease, so a cut that is already copying files never has a
 * file appear or be replaced underneath it.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { makePathsProxy } from '../../lib/mockPathsDataRoot.js';

let tempRoot = mkdtempSync(join(tmpdir(), 'portos-peer-backup-boot-'));
const bootRoot = tempRoot;

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return makePathsProxy(actual, { dataRoot: () => tempRoot });
});
vi.mock('../../lib/databaseMaintenanceJournal.js', async (importOriginal) => ({
  ...(await importOriginal()),
  assertDatabaseAdmission: () => {},
}));
vi.mock('../instances.js', () => ({
  getPeers: vi.fn(async () => [{ instanceId: 'peer-a', name: 'peer-a', address: '192.0.2.10', port: 5555 }]),
}));
vi.mock('../../lib/peerHttpClient.js', () => ({ peerFetch: vi.fn() }));
vi.mock('../tracks/index.js', () => ({ getTrack: vi.fn(), trackAudioFilename: vi.fn() }));

const { peerFetch } = await import('../../lib/peerHttpClient.js');
const { assetWriteQueue, inflightPulls, pullMissingAssetsFromPeer } = await import('./peerSyncAssets.js');
const { acquireBackupSnapshotCut } = await import('../../lib/backupSnapshotBoundary.js');

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
const bytes = Buffer.from('example-peer-audio');
const response = {
  ok: true,
  headers: { has: (name) => name === 'content-length', get: () => String(bytes.length) },
  arrayBuffer: async () => bytes,
};

describe('peer asset pull against a backup cut', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'portos-peer-backup-'));
    assetWriteQueue.clear();
    inflightPulls.clear();
    vi.mocked(peerFetch).mockReset().mockResolvedValue(response);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });
  afterAll(() => rmSync(bootRoot, { recursive: true, force: true }));

  it('lands the downloaded file only after the cut releases', async () => {
    const target = join(tempRoot, 'music', 'pulled.mp3');
    const release = await acquireBackupSnapshotCut();
    let pending;
    try {
      pending = pullMissingAssetsFromPeer('peer-a', [
        { filename: 'pulled.mp3', kind: 'music', sha256: createHash('sha256').update(bytes).digest('hex') },
      ]);
      await settle();
      expect(peerFetch).toHaveBeenCalled();
      expect(existsSync(target)).toBe(false);
    } finally {
      release();
    }
    await pending;
    expect(existsSync(target)).toBe(true);
  });
});
