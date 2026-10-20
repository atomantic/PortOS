/**
 * A pulled media asset whose bytes are a playlist or manifest is discarded:
 * ffmpeg 4.4/5.1 open such a file by content whatever its extension and read
 * the local media it names into a later probe, thumbnail or render.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { makePathsProxy } from '../../lib/mockPathsDataRoot.js';

let tempRoot = mkdtempSync(join(tmpdir(), 'portos-peer-manifest-boot-'));
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

const served = (bytes) => ({
  ok: true,
  headers: { has: (name) => name === 'content-length', get: () => String(bytes.length) },
  arrayBuffer: async () => bytes,
});
const pull = (filename, bytes) => pullMissingAssetsFromPeer('peer-a', [
  { filename, kind: 'music', sha256: createHash('sha256').update(bytes).digest('hex') },
]);

describe('peer asset pull content check', () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'portos-peer-manifest-'));
    assetWriteQueue.clear();
    inflightPulls.clear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });
  afterAll(() => rmSync(bootRoot, { recursive: true, force: true }));

  it('discards a music asset whose bytes are an HLS playlist', async () => {
    const playlist = Buffer.from('#EXTM3U\n#EXTINF:2.0,\n../private/song.m4a\n#EXT-X-ENDLIST\n');
    vi.mocked(peerFetch).mockReset().mockResolvedValue(served(playlist));

    await pull('pulled.mp3', playlist);

    expect(peerFetch).toHaveBeenCalled();
    expect(existsSync(join(tempRoot, 'music', 'pulled.mp3'))).toBe(false);
  });

  it('still lands ordinary audio bytes', async () => {
    const audio = Buffer.from('example-peer-audio');
    vi.mocked(peerFetch).mockReset().mockResolvedValue(served(audio));

    await pull('pulled.mp3', audio);

    expect(existsSync(join(tempRoot, 'music', 'pulled.mp3'))).toBe(true);
  });
});
