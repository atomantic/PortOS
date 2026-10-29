/**
 * Image deletes across the standalone media-library sweep: a gallery image
 * deleted here must not come back from a peer that still holds it.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

let tempRoot;
vi.mock('../../lib/fileUtils.js', async importOriginal => makePathsProxy(await importOriginal(), { dataRoot: () => tempRoot }));
vi.mock('../../lib/paths.js', async importOriginal => makePathsProxy(await importOriginal(), { dataRoot: () => tempRoot }));
vi.mock('../instances.js', async importOriginal => ({ ...(await importOriginal()), getPeers: vi.fn(async () => []) }));
vi.mock('../../lib/peerHttpClient.js', async importOriginal => ({ ...(await importOriginal()), peerFetch: vi.fn() }));
vi.mock('../../lib/databaseMaintenanceJournal.js', async importOriginal => ({ ...(await importOriginal()), assertDatabaseAdmission: () => {} }));
vi.mock('../mediaAssetIndex/index.js', () => ({
  reconcileMediaAssets: vi.fn(async () => ({ ok: true, skippedPrune: [] })),
  indexImage: vi.fn(async () => {}),
  unindexImage: vi.fn(async () => {}),
}));
vi.mock('../../lib/pythonSetup.js', () => ({ resolveFlux2Python: () => null, FLUX2_VENV_DEFAULT: '/fake/venv/bin/python3' }));
vi.mock('../instanceIdentity.js', async importOriginal => ({ ...(await importOriginal()), getInstanceId: vi.fn(async () => 'local-inst') }));
// Trash moves into a fixture-owned bin, never the host Trash.
vi.mock('../../lib/nativeTrash.js', () => ({ moveToNativeTrash: async paths => {
  const { rename, mkdir } = await vi.importActual('fs/promises');
  const bin = join(tempRoot, 'trash-bin');
  await mkdir(bin, { recursive: true });
  for (const path of paths) await rename(path, join(bin, path.split(/[\\/]/).pop()));
} }));

tempRoot = createTempDataRoot('portos-image-tombstone-');
process.env.PORTOS_MEDIA_MODELS_FILE = join(tempRoot, 'media-models.json');
const { PORTOS_SCHEMA_VERSIONS } = await import('../../lib/schemaVersions.js');
const { PATHS } = await import('../../lib/fileUtils.js');
const { getPeers } = await import('../instances.js');
const { peerFetch } = await import('../../lib/peerHttpClient.js');
const { syncMediaLibraryFromPeer, buildMediaLibraryManifest } = await import('./peerMediaLibrarySync.js');
const { listMediaTombstones, recordMediaTombstone } = await import('../mediaTombstones.js');
const { PEER_LIBRARY_TOMBSTONES_HEADER } = await import('../../lib/validation.js');
const { deleteImage } = await import('../imageGen/local.js');

const bytes = Buffer.from('synthetic-peer-image');
const sha = createHash('sha256').update(bytes).digest('hex');
let sequence = 0;
const pairedPeer = (overrides = {}) => ({
  id: `peer-${++sequence}`, instanceId: `peer-inst-${sequence}`, name: `Peer ${sequence}`,
  address: '192.0.2.10', port: 5555, fullSync: true, enabled: true, syncSecret: 's'.repeat(40), ...overrides,
});

function seedImage(filename, sidecar = { prompt: 'a synthetic fox' }) {
  mkdirSync(PATHS.images, { recursive: true });
  writeFileSync(join(PATHS.images, filename), bytes);
  writeFileSync(join(PATHS.images, filename.replace(/\.png$/, '.metadata.json')), JSON.stringify(sidecar));
}

// `peer` advertises `filenames` (and optional tombstones) and serves their bytes.
function advertise(peer, filenames, { tombstones } = {}) {
  vi.mocked(getPeers).mockResolvedValue([peer]);
  const manifest = {
    schemaVersion: PORTOS_SCHEMA_VERSIONS.mediaLibrary,
    manifestHash: createHash('sha256').update(`${filenames.join(',')}|${JSON.stringify(tombstones ?? null)}`).digest('hex'),
    assets: filenames.map(filename => ({ kind: 'image', filename, sha256: sha })),
    ...(tombstones ? { tombstones } : {}),
  };
  vi.mocked(peerFetch).mockImplementation(async url => {
    if (String(url).includes('/library-manifest')) return { ok: true, headers: new Headers(), json: async () => manifest };
    if (String(url).endsWith('.png')) return { ok: true, headers: new Headers({ 'content-length': String(bytes.length) }), arrayBuffer: async () => bytes };
    return { ok: false, status: 404, headers: new Headers() };
  });
}
const held = (filename) => existsSync(join(PATHS.images, filename));
const now = () => new Date().toISOString();
const tombstonedKeys = async () => (await listMediaTombstones('image')).map((t) => t.key);
const imageDownloads = () => vi.mocked(peerFetch).mock.calls.filter(([url]) => String(url).endsWith('.png')).length;

beforeEach(() => {
  rmSync(PATHS.images, { recursive: true, force: true });
  rmSync(join(PATHS.data, 'media-tombstones.json'), { force: true });
  vi.mocked(peerFetch).mockReset();
});
afterAll(() => { rmSync(tempRoot, { recursive: true, force: true }); });

describe('image deletes across the library sweep', () => {
  it('an image deleted here does not come back from a peer that still holds it', async () => {
    const peer = pairedPeer();
    seedImage('fox.png');
    await deleteImage('fox.png');
    expect(existsSync(join(PATHS.images, 'fox.png'))).toBe(false);

    advertise(peer, ['fox.png']);
    await syncMediaLibraryFromPeer(peer);

    expect(existsSync(join(PATHS.images, 'fox.png'))).toBe(false);
    expect(imageDownloads()).toBe(0);
  });

  it("retires the copy here when the image's owner advertises its delete", async () => {
    const owner = pairedPeer();
    seedImage('owned.png', { prompt: 'p', createdAt: '2026-01-01T00:00:00.000Z', originInstanceId: owner.instanceId });
    advertise(owner, [], { tombstones: [{ key: 'owned.png', deletedAt: now() }] });
    await syncMediaLibraryFromPeer(owner);
    expect(held('owned.png')).toBe(false);
    expect(await tombstonedKeys()).toEqual(['owned.png']);
    // The receiver asked for tombstones; an older sender ignores the header.
    const [, options] = vi.mocked(peerFetch).mock.calls.find(([url]) => String(url).includes('/library-manifest'));
    expect(options.headers).toMatchObject({ [PEER_LIBRARY_TOMBSTONES_HEADER]: '1' });
  });

  it('accepts a tombstone for a peer-supplied image from the peer that supplied it', async () => {
    const supplier = pairedPeer();
    seedImage('supplied.png', { prompt: 'p', createdAt: '2026-01-01T00:00:00.000Z', suppliedByInstanceId: supplier.instanceId });
    advertise(supplier, [], { tombstones: [{ key: 'supplied.png', deletedAt: now() }] });
    await syncMediaLibraryFromPeer(supplier);
    expect(held('supplied.png')).toBe(false);
  });

  it.each([
    ['a peer that does not own the image', (p) => p, { originInstanceId: 'someone-else' }],
    ['a peer whose media delete is off here', (p) => ({ ...p, mediaDeleteAllowed: false }), null],
    ['an unpaired peer', (p) => ({ ...p, syncSecret: undefined }), null],
  ])('ignores a tombstone from %s, before anything is deleted or recorded', async (_label, change, sidecarOverride) => {
    const sender = change(pairedPeer());
    seedImage('kept.png', { prompt: 'p', createdAt: '2026-01-01T00:00:00.000Z', originInstanceId: sender.instanceId, ...sidecarOverride });
    advertise(sender, ['kept.png'], { tombstones: [{ key: 'kept.png', deletedAt: now() }] });
    await syncMediaLibraryFromPeer(sender);
    expect(held('kept.png')).toBe(true);
    expect(await tombstonedKeys()).toEqual([]);
  });

  it('ignores a future-dated tombstone and one for an image not held here', async () => {
    const owner = pairedPeer();
    seedImage('future.png', { prompt: 'p', createdAt: '2026-01-01T00:00:00.000Z', originInstanceId: owner.instanceId });
    advertise(owner, ['future.png'], { tombstones: [
      { key: 'future.png', deletedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
      { key: 'never-held.png', deletedAt: now() },
    ] });
    await syncMediaLibraryFromPeer(owner);
    expect(held('future.png')).toBe(true);
    expect(await tombstonedKeys()).toEqual([]);
  });

  it('keeps an image created after the delete', async () => {
    const owner = pairedPeer();
    seedImage('later.png', { prompt: 'p', createdAt: '2026-06-01T00:00:00.000Z', originInstanceId: owner.instanceId });
    advertise(owner, [], { tombstones: [{ key: 'later.png', deletedAt: '2026-05-01T00:00:00.000Z' }] });
    await syncMediaLibraryFromPeer(owner);
    expect(held('later.png')).toBe(true);
  });
});

describe('library manifest tombstones', () => {
  it('advertises image deletes only to a receiver that asks, and only then changes the hash', async () => {
    seedImage('present.png');
    const before = await buildMediaLibraryManifest({ tombstones: true });
    expect(before.tombstones).toBeUndefined();
    expect((await buildMediaLibraryManifest()).manifestHash).toBe(before.manifestHash);

    await recordMediaTombstone('image', 'gone.png');
    const legacy = await buildMediaLibraryManifest();
    const capable = await buildMediaLibraryManifest({ tombstones: true });
    expect(legacy).not.toHaveProperty('tombstones');
    expect(legacy.manifestHash).toBe(before.manifestHash);
    expect(capable.tombstones).toEqual([{ key: 'gone.png', deletedAt: expect.any(String) }]);
    expect(capable.manifestHash).not.toBe(before.manifestHash);
  });
});
