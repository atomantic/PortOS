/**
 * Image deletes across the standalone media-library sweep: a gallery image
 * deleted here must not come back from a peer that still holds it.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
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
// Trash moves into a fixture-owned bin, never the host Trash. `trashHold`
// lets a test hold the move open or fail it.
let trashHold = null;
vi.mock('../../lib/nativeTrash.js', () => ({ moveToNativeTrash: async paths => {
  if (trashHold) await trashHold();
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
const { FORCE_REVALIDATE_EVERY } = await import('./peerSyncShared.js');
const { diffAssetManifestAgainstLocal } = await import('./peerSyncAssets.js');
const { listMediaTombstones, recordMediaTombstone } = await import('../mediaTombstones.js');
const { PEER_LIBRARY_TOMBSTONES_HEADER, PEER_LIBRARY_TOMBSTONES_SINCE_HEADER } = await import('../../lib/validation.js');
const { sidecarGenParamsHash } = await import('../../lib/assetHash.js');
const { deleteImage } = await import('../imageGen/local.js');
const { localizeImageUrl } = await import('../moodBoard/localize.js');

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
function advertise(peer, filenames, { tombstones, createdAt } = {}) {
  vi.mocked(getPeers).mockResolvedValue([peer]);
  const manifest = {
    schemaVersion: PORTOS_SCHEMA_VERSIONS.mediaLibrary,
    manifestHash: createHash('sha256').update(`${filenames.join(',')}|${JSON.stringify(tombstones ?? null)}`).digest('hex'),
    assets: filenames.map(filename => ({ kind: 'image', filename, sha256: sha, ...(createdAt ? { createdAt } : {}) })),
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
  rmSync(PATHS.videos, { recursive: true, force: true });
  rmSync(join(PATHS.data, 'media-tombstones.json'), { force: true });
  vi.mocked(peerFetch).mockReset();
  trashHold = null;
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

// Names are re-used (a re-rendered handoff frame, a LoRA preview step), so every
// image tombstone check compares stamps instead of blocking the name forever.
describe('a re-used image name', () => {
  const DELETED_AT = '2026-03-01T00:00:00.000Z';
  const BEFORE = new Date('2026-02-01T00:00:00.000Z');
  const AFTER = new Date('2026-04-01T00:00:00.000Z');
  const setFileTimes = (filename, when) => utimesSync(join(PATHS.images, filename), when, when);
  // A copy made here with no creation stamp: its sidecar names only this
  // machine (local-inst, the mocked identity) as origin, so its file time counts.
  const seedMadeHere = (filename, when) => {
    seedImage(filename, { originInstanceId: 'local-inst' });
    setFileTimes(filename, when);
  };
  const entry = (filename, extra = {}) => ({ kind: 'image', filename, sha256: sha, ...extra });

  it('pulls a copy made after the delete, and still blocks the deleted one or one with no usable stamp', async () => {
    await recordMediaTombstone('image', 'frame.png', DELETED_AT);
    const names = async (entries) => (await diffAssetManifestAgainstLocal(entries)).map((e) => `${e.filename}@${e.createdAt ?? '-'}`);
    expect(await names([entry('frame.png', { createdAt: AFTER.toISOString() })])).toEqual([`frame.png@${AFTER.toISOString()}`]);
    expect(await names([entry('frame.png', { createdAt: BEFORE.toISOString() })])).toEqual([]);
    expect(await names([entry('frame.png')])).toEqual([]);
    expect(await names([entry('frame.png', { createdAt: 'not-a-date' })])).toEqual([]);
  });

  it('advertises its live stamp to a receiver that asked, and drops its own superseded tombstone', async () => {
    seedImage('again.png', { prompt: 'p', createdAt: AFTER.toISOString() });
    seedMadeHere('bare.png', AFTER);
    await recordMediaTombstone('image', 'again.png', DELETED_AT);
    await recordMediaTombstone('image', 'bare.png', DELETED_AT);
    await recordMediaTombstone('image', 'gone.png', DELETED_AT);
    const manifest = await buildMediaLibraryManifest({ tombstones: true });
    expect(manifest.assets.find((a) => a.filename === 'again.png').createdAt).toBe(AFTER.toISOString());
    expect(Date.parse(manifest.assets.find((a) => a.filename === 'bare.png').createdAt)).toBeGreaterThanOrEqual(AFTER.getTime());
    expect(manifest.tombstones.map((t) => t.key)).toEqual(['gone.png']);
    // An older receiver's strict schema would refuse the stamp, so it never gets one.
    expect((await buildMediaLibraryManifest()).assets.every((a) => !('createdAt' in a))).toBe(true);
  });

  it('a stale manifest tombstone from the owner spares a copy its sidecar stamps as made after it', async () => {
    const owner = pairedPeer();
    seedImage('reborn.png', { prompt: 'p', createdAt: AFTER.toISOString(), originInstanceId: owner.instanceId });
    advertise(owner, [], { tombstones: [{ key: 'reborn.png', deletedAt: DELETED_AT }] });
    await syncMediaLibraryFromPeer(owner);
    expect(held('reborn.png')).toBe(true);
  });

  it.each([
    ['owned by the peer', (owner) => ({ prompt: 'p', originInstanceId: owner })],
    ['supplied by the peer', (owner) => ({ prompt: 'p', suppliedByInstanceId: owner })],
  ])("retires a copy %s with no creation stamp, however recently its file landed", async (_label, sidecar) => {
    const owner = pairedPeer();
    seedImage('landed.png', sidecar(owner.instanceId));
    setFileTimes('landed.png', AFTER);
    advertise(owner, [], { tombstones: [{ key: 'landed.png', deletedAt: DELETED_AT }] });
    await syncMediaLibraryFromPeer(owner);
    expect(held('landed.png')).toBe(false);
  });

  it('a copy re-made here under a deleted name is spared by the stale tombstone and still offered to peers', async () => {
    seedMadeHere('handoff.png', AFTER);
    await recordMediaTombstone('image', 'handoff.png', DELETED_AT);
    const { applyRemoteImageTombstones } = await import('../imageGen/imageRecords.js');
    expect(await applyRemoteImageTombstones([{ key: 'handoff.png', deletedAt: DELETED_AT }])).toBe(0);
    expect(held('handoff.png')).toBe(true);
    const manifest = await buildMediaLibraryManifest({ tombstones: true });
    const offered = manifest.assets.find((a) => a.filename === 'handoff.png');
    expect(Date.parse(offered.createdAt)).toBeGreaterThan(Date.parse(DELETED_AT));
    expect(manifest.tombstones ?? []).toEqual([]);
    // A peer holding the old tombstone pulls the re-made copy.
    rmSync(join(PATHS.images, 'handoff.png'));
    expect(await diffAssetManifestAgainstLocal([offered])).toHaveLength(1);
  });

  it('an origin-less copy that lands after the delete counts as old: retired, advertised unstamped, never pulled back', async () => {
    // Deleted here; the copy then returns by a path that records no supplier
    // (an older peer's pull, an avatar sync, a restore), with a fresh file time.
    await recordMediaTombstone('image', 'returned.png', DELETED_AT);
    mkdirSync(PATHS.images, { recursive: true });
    writeFileSync(join(PATHS.images, 'returned.png'), bytes);
    setFileTimes('returned.png', AFTER);
    const manifest = await buildMediaLibraryManifest({ tombstones: true });
    const offered = manifest.assets.find((a) => a.filename === 'returned.png');
    expect(offered).not.toHaveProperty('createdAt');
    expect(manifest.tombstones.map((t) => t.key)).toEqual(['returned.png']);
    // A peer holding the delete keeps the name blocked against this copy.
    rmSync(join(PATHS.images, 'returned.png'));
    expect(await diffAssetManifestAgainstLocal([offered])).toEqual([]);
    // Back here, the same delete relayed by the peer that supplied the copy
    // (an owner candidate) retires it.
    const relay = pairedPeer();
    seedImage('returned.png', { suppliedByInstanceId: relay.instanceId });
    setFileTimes('returned.png', AFTER);
    advertise(relay, [], { tombstones: [{ key: 'returned.png', deletedAt: DELETED_AT }] });
    await syncMediaLibraryFromPeer(relay);
    expect(held('returned.png')).toBe(false);
  });

  it('a delete held here, relayed by a peer that is no owner of the copy, never retires it', async () => {
    // Unstamped, origin-less, supplier-less: counts as old, but no peer owns it.
    await recordMediaTombstone('image', 'unowned.png', DELETED_AT);
    mkdirSync(PATHS.images, { recursive: true });
    writeFileSync(join(PATHS.images, 'unowned.png'), bytes);
    setFileTimes('unowned.png', AFTER);
    const stranger = pairedPeer();
    advertise(stranger, [], { tombstones: [{ key: 'unowned.png', deletedAt: DELETED_AT }] });
    await syncMediaLibraryFromPeer(stranger);
    expect(held('unowned.png')).toBe(true);
    // Still offered without a stamp, so peers holding the delete keep it blocked.
    const offered = (await buildMediaLibraryManifest({ tombstones: true })).assets.find((a) => a.filename === 'unowned.png');
    expect(offered).not.toHaveProperty('createdAt');
  });

  it('a mood-board image deleted and saved again is stamped newer than the delete, so a peer holding the tombstone accepts it', async () => {
    // Board copies are named by a content hash, so saving the same bytes again
    // re-uses the deleted name; the local-origin sidecar written at save time
    // is what makes the copy newer than the old delete (#14095).
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
    const saved = (await localizeImageUrl(dataUrl)).split('/').pop();
    await deleteImage(saved);
    expect(held(saved)).toBe(false);
    const [deleted] = await listMediaTombstones('image');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await localizeImageUrl(dataUrl);

    const sidecar = JSON.parse(readFileSync(join(PATHS.images, saved.replace(/\.png$/, '.metadata.json')), 'utf8'));
    expect(sidecar.originInstanceId).toBe('local-inst');
    const offered = (await buildMediaLibraryManifest({ tombstones: true })).assets.find((a) => a.filename === saved);
    expect(new Date(offered.createdAt).getTime()).toBeGreaterThan(new Date(deleted.deletedAt).getTime());

    // A peer that still holds the tombstone pulls it from the creating machine.
    rmSync(PATHS.images, { recursive: true, force: true });
    await recordMediaTombstone('image', saved, deleted.deletedAt);
    const owner = pairedPeer();
    advertise(owner, [saved], { createdAt: offered.createdAt });
    await syncMediaLibraryFromPeer(owner);
    expect(held(saved)).toBe(true);
  });

  it('a pulled copy with no creation stamp is advertised without one, and its tombstone keeps travelling', async () => {
    seedImage('relay.png', { prompt: 'p', originInstanceId: 'origin-inst', suppliedByInstanceId: 'origin-inst' });
    setFileTimes('relay.png', AFTER);
    await recordMediaTombstone('image', 'relay.png', DELETED_AT);
    const manifest = await buildMediaLibraryManifest({ tombstones: true });
    expect(manifest.assets.find((a) => a.filename === 'relay.png')).not.toHaveProperty('createdAt');
    expect(manifest.tombstones.map((t) => t.key)).toEqual(['relay.png']);
  });

  it('the same tombstone still retires a copy older than it', async () => {
    const owner = pairedPeer();
    seedImage('old.png', { prompt: 'p', originInstanceId: owner.instanceId });
    setFileTimes('old.png', BEFORE);
    advertise(owner, [], { tombstones: [{ key: 'old.png', deletedAt: DELETED_AT }] });
    await syncMediaLibraryFromPeer(owner);
    expect(held('old.png')).toBe(false);
  });

  it('a re-created image is pulled from the peer that made it despite the tombstone here', async () => {
    const owner = pairedPeer();
    await recordMediaTombstone('image', 'remade.png', DELETED_AT);
    advertise(owner, ['remade.png'], { createdAt: AFTER.toISOString() });
    await syncMediaLibraryFromPeer(owner);
    expect(held('remade.png')).toBe(true);
    expect(imageDownloads()).toBe(1);
  });
});

describe('a pulled image without a peer sidecar', () => {
  it('records its supplier, so its file time is never taken as made here', async () => {
    const peer = pairedPeer();
    advertise(peer, ['bare-pull.png']);
    await syncMediaLibraryFromPeer(peer);
    expect(held('bare-pull.png')).toBe(true);
    const sidecar = JSON.parse(readFileSync(join(PATHS.images, 'bare-pull.metadata.json'), 'utf8'));
    expect(sidecar.suppliedByInstanceId).toBe(peer.instanceId);
    const { readHeldImage } = await import('../imageGen/imageRecords.js');
    expect((await readHeldImage('bare-pull.png')).createdAt).toBeUndefined();
    // No gen-params were added, so nothing new is advertised for it.
    const entry = (await buildMediaLibraryManifest({ tombstones: true })).assets.find((a) => a.filename === 'bare-pull.png');
    expect(entry).not.toHaveProperty('sidecarSha256');
    expect(entry).not.toHaveProperty('createdAt');
  });
});

describe('a held image without an origin', () => {
  it("is not re-pulled every sweep because the sender's copy names its origin", async () => {
    seedImage('legacy.png', { prompt: 'a fox' });
    const advertised = { kind: 'image', filename: 'legacy.png', sha256: sha, sidecarSha256: sidecarGenParamsHash({ prompt: 'a fox', originInstanceId: 'sender-inst' }) };
    expect(await diffAssetManifestAgainstLocal([advertised], { senderInstanceId: 'sender-inst' })).toEqual([]);
    expect(await diffAssetManifestAgainstLocal([{ ...advertised, sidecarSha256: sidecarGenParamsHash({ prompt: 'a wolf' }) }], { senderInstanceId: 'sender-inst' })).toHaveLength(1);
  });
});

describe('library manifest tombstones', () => {
  // #14088: a peer sweeping while the files are still being trashed must not
  // receive a delete that a failed trash would then withdraw.
  it('advertises a delete only once its trash commits', async () => {
    seedImage('fading.png');
    // Warm the sidecar hash cache first: computing it takes the image's sidecar
    // queue, which the delete holds for as long as its trash runs.
    await buildMediaLibraryManifest({ tombstones: true });
    let release;
    let started;
    const trashing = new Promise((resolve) => { started = resolve; });
    trashHold = () => new Promise((resolve) => { release = resolve; started(); });
    const deleting = deleteImage('fading.png');
    try {
      await trashing;
      const during = await buildMediaLibraryManifest({ tombstones: true });
      expect(during.tombstones).toBeUndefined();
      expect(during.assets.map((a) => a.filename)).toContain('fading.png');
    } finally {
      release();
      await deleting;
    }
    const after = await buildMediaLibraryManifest({ tombstones: true });
    expect(after.tombstones).toEqual([{ key: 'fading.png', deletedAt: expect.any(String) }]);
  });

  it('a failed trash leaves no delete to advertise and the image still listed', async () => {
    seedImage('stuck.png');
    trashHold = async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(deleteImage('stuck.png')).rejects.toMatchObject({ code: 'MEDIA_TRASH_FAILED' });
    err.mockRestore();
    const manifest = await buildMediaLibraryManifest({ tombstones: true });
    expect(manifest.tombstones).toBeUndefined();
    expect(manifest.assets.map((a) => a.filename)).toContain('stuck.png');
    expect(await tombstonedKeys()).toEqual([]);
  });

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

describe('tombstone cursor', () => {
  const libraryFetches = () => vi.mocked(peerFetch).mock.calls.filter(([url]) => String(url).includes('/library-manifest'));

  it('sends only tombstones newer than the receiver cursor, and the full list without one', async () => {
    await recordMediaTombstone('image', 'old.png', '2026-01-01T00:00:00.000Z');
    await recordMediaTombstone('image', 'new.png', '2026-02-01T00:00:00.000Z');
    const keys = async (since) => ((await buildMediaLibraryManifest({ tombstones: true, tombstonesSince: since })).tombstones ?? []).map((t) => t.key);
    expect(await keys(undefined)).toEqual(['new.png', 'old.png']);
    expect(await keys('garbage')).toEqual(['new.png', 'old.png']);
    expect(await keys('2026-01-01T00:00:00.000Z')).toEqual(['new.png']);
    expect(await keys('2026-02-01T00:00:00.000Z')).toEqual([]);
  });

  it('asks with the newest admitted deletedAt on the next sweep, and sends none on the first', async () => {
    const owner = pairedPeer();
    seedImage('cursor.png', { prompt: 'p', createdAt: '2026-01-01T00:00:00.000Z', originInstanceId: owner.instanceId });
    const deletedAt = now();
    advertise(owner, [], { tombstones: [{ key: 'cursor.png', deletedAt }] });
    vi.mocked(peerFetch).mockClear();
    await syncMediaLibraryFromPeer(owner);
    await syncMediaLibraryFromPeer(owner);
    const [first, second] = libraryFetches();
    expect(first[1].headers[PEER_LIBRARY_TOMBSTONES_SINCE_HEADER]).toBeUndefined();
    expect(second[1].headers[PEER_LIBRARY_TOMBSTONES_SINCE_HEADER]).toBe(deletedAt);
  });

  it('asks for the full list again every FORCE_REVALIDATE_EVERY sweeps so a missed older-stamped tombstone heals', async () => {
    const owner = pairedPeer();
    seedImage('heal.png', { prompt: 'p', createdAt: '2026-01-01T00:00:00.000Z', originInstanceId: owner.instanceId });
    advertise(owner, [], { tombstones: [{ key: 'heal.png', deletedAt: now() }] });
    vi.mocked(peerFetch).mockClear();
    for (let i = 0; i < FORCE_REVALIDATE_EVERY; i++) await syncMediaLibraryFromPeer(owner);
    const sent = libraryFetches().map(([, o]) => o.headers[PEER_LIBRARY_TOMBSTONES_SINCE_HEADER] !== undefined);
    expect(sent[0]).toBe(false);
    expect(sent[1]).toBe(true);
    expect(sent[FORCE_REVALIDATE_EVERY - 1]).toBe(false);
  });

  it('keeps the cursor back while a tombstone is refused so it is offered again', async () => {
    const sender = pairedPeer();
    seedImage('refused.png', { prompt: 'p', createdAt: '2026-01-01T00:00:00.000Z', originInstanceId: 'someone-else' });
    advertise(sender, ['refused.png'], { tombstones: [{ key: 'refused.png', deletedAt: now() }] });
    vi.mocked(peerFetch).mockClear();
    await syncMediaLibraryFromPeer(sender);
    await syncMediaLibraryFromPeer(sender);
    expect(libraryFetches().every(([, o]) => o.headers[PEER_LIBRARY_TOMBSTONES_SINCE_HEADER] === undefined)).toBe(true);
  });
});

describe('video deletes across the library sweep', () => {
  const advertiseVideos = (peer, filenames) => {
    vi.mocked(getPeers).mockResolvedValue([peer]);
    const manifest = {
      schemaVersion: PORTOS_SCHEMA_VERSIONS.mediaLibrary,
      manifestHash: createHash('sha256').update(`video|${filenames.join(',')}`).digest('hex'),
      assets: filenames.map(filename => ({ kind: 'video', filename, sha256: sha })),
    };
    vi.mocked(peerFetch).mockImplementation(async url => {
      if (String(url).includes('/library-manifest')) return { ok: true, headers: new Headers(), json: async () => manifest };
      if (String(url).endsWith('.mp4')) return { ok: true, headers: new Headers({ 'content-length': String(bytes.length) }), arrayBuffer: async () => bytes };
      return { ok: false, status: 404, headers: new Headers() };
    });
  };
  const videoDownloads = () => vi.mocked(peerFetch).mock.calls.filter(([url]) => String(url).endsWith('.mp4')).map(([url]) => String(url));

  it('a deleted video is not pulled back, while a re-created one under a new id still syncs', async () => {
    const peer = pairedPeer();
    await recordMediaTombstone('video', 'gone-id');
    advertiseVideos(peer, ['gone-id.mp4', 'new-id.mp4']);
    await syncMediaLibraryFromPeer(peer);

    expect(existsSync(join(PATHS.videos, 'gone-id.mp4'))).toBe(false);
    expect(existsSync(join(PATHS.videos, 'new-id.mp4'))).toBe(true);
    expect(videoDownloads().some((url) => url.includes('gone-id'))).toBe(false);
  });
});
