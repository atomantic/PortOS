/**
 * Three machines, one deleted image (a regression test, deterministic).
 * A deletes an image that B already copied. C, offline during the delete,
 * comes back and copies it from B before it hears from A. A pulled file is born
 * when it lands, so a file-time stamp would make C's copy look newer than A's
 * delete. C would keep it and advertise that, A would pull it back, and the
 * image would be back everywhere. Every machine runs the real sweep, manifest,
 * sidecar pull and admission code on its own data root.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

const machines = vi.hoisted(() => ({ here: 'a', roots: {} }));
vi.mock('../../lib/fileUtils.js', async importOriginal => makePathsProxy(await importOriginal(), { dataRoot: () => machines.roots[machines.here] }));
vi.mock('../../lib/paths.js', async importOriginal => makePathsProxy(await importOriginal(), { dataRoot: () => machines.roots[machines.here] }));
vi.mock('../instanceIdentity.js', async importOriginal => ({ ...(await importOriginal()), getInstanceId: vi.fn(async () => `inst-${machines.here}`) }));
vi.mock('../instances.js', async importOriginal => ({ ...(await importOriginal()), getPeers: vi.fn(async () => registryOf(machines.here)) }));
vi.mock('../../lib/peerHttpClient.js', async importOriginal => ({ ...(await importOriginal()), peerFetch: vi.fn((url, options) => serve(url, options)) }));
vi.mock('../../lib/databaseMaintenanceJournal.js', async importOriginal => ({ ...(await importOriginal()), assertDatabaseAdmission: () => {} }));
vi.mock('../mediaAssetIndex/index.js', () => ({
  reconcileMediaAssets: vi.fn(async () => ({ ok: true, skippedPrune: [] })),
  indexImage: vi.fn(async () => {}),
  unindexImage: vi.fn(async () => {}),
}));
vi.mock('../../lib/pythonSetup.js', () => ({ resolveFlux2Python: () => null, FLUX2_VENV_DEFAULT: '/fake/venv/bin/python3' }));
vi.mock('../../lib/nativeTrash.js', () => ({ moveToNativeTrash: async paths => {
  const { rename, mkdir } = await vi.importActual('fs/promises');
  const bin = join(base, 'trash-bin');
  await mkdir(bin, { recursive: true });
  for (const path of paths) await rename(path, join(bin, `${Math.random().toString(36).slice(2)}-${path.split(/[\\/]/).pop()}`));
} }));

const base = createTempDataRoot('portos-three-machines-');
for (const m of ['a', 'b', 'c']) machines.roots[m] = join(base, m);
process.env.PORTOS_MEDIA_MODELS_FILE = join(base, 'media-models.json');
const PORTS = { a: 5101, b: 5102, c: 5103 };
const peerRecord = (m) => ({
  id: `rec-${m}`, instanceId: `inst-${m}`, name: `Machine ${m.toUpperCase()}`, address: '192.0.2.10', port: PORTS[m],
  fullSync: true, enabled: true, status: 'online', syncSecret: 's'.repeat(40),
});
function registryOf(m) { return ['a', 'b', 'c'].filter((other) => other !== m).map(peerRecord); }

const { syncMediaLibraryFromPeer, buildMediaLibraryManifest } = await import('./peerMediaLibrarySync.js');
const { deleteImage } = await import('../imageGen/local.js');
const { listMediaTombstones } = await import('../mediaTombstones.js');
const { applyPeerSyncEvent } = await import('../peerSyncEvents.js');
const { stripImageSidecarLocalBytes } = await import('../../lib/assetHash.js');

const respond = (body, type) => ({
  ok: true, status: 200, headers: new Headers({ 'content-length': String(body.length), 'content-type': type }),
  arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
});
const notFound = () => ({ ok: false, status: 404, headers: new Headers() });

// The peer's HTTP surface: its manifest built on its own root, its static mount.
async function serve(url, options) {
  const { port, pathname } = new URL(url);
  const target = Object.keys(PORTS).find((m) => PORTS[m] === Number(port));
  const requester = machines.here;
  if (pathname === '/api/peer-sync/library-manifest') {
    machines.here = target;
    let manifest;
    try {
      manifest = await buildMediaLibraryManifest({ models: true, tombstones: options?.headers?.['X-PortOS-Library-Tombstones'] === '1' });
    } finally {
      machines.here = requester;
    }
    // Each receiver caches the last hash per sender id; keep the views apart.
    manifest.manifestHash = createHash('sha256').update(`${manifest.manifestHash}:${requester}`).digest('hex');
    return { ok: true, status: 200, headers: new Headers(), json: async () => manifest };
  }
  const name = decodeURIComponent(pathname.replace('/data/images/', ''));
  const file = join(machines.roots[target], 'images', name);
  if (!pathname.startsWith('/data/images/') || !existsSync(file)) return notFound();
  const bytes = readFileSync(file);
  return name.endsWith('.json') ? respond(stripImageSidecarLocalBytes(bytes), 'application/json') : respond(bytes, 'image/png');
}

const on = async (m, fn) => {
  machines.here = m;
  return fn();
};
const sweep = (receiver, sender) => on(receiver, () => syncMediaLibraryFromPeer(peerRecord(sender)));
const holds = (m) => existsSync(join(machines.roots[m], 'images', 'upload-1.png'));

afterAll(() => { rmSync(base, { recursive: true, force: true }); });

describe('a deleted image across three machines', () => {
  it('does not come back when a third machine copies it from a holder after the delete', async () => {
    // A's upload: its own origin, no creation stamp (how uploads were written).
    await on('a', () => {
      mkdirSync(join(machines.roots.a, 'images'), { recursive: true });
      writeFileSync(join(machines.roots.a, 'images', 'upload-1.png'), Buffer.from('synthetic-upload-bytes'));
      writeFileSync(join(machines.roots.a, 'images', 'upload-1.metadata.json'), JSON.stringify({ originInstanceId: 'inst-a', prompt: 'p' }));
    });
    await sweep('b', 'a');
    expect(holds('b')).toBe(true);

    // A deletes while B and C are offline: the realtime frame reaches no one.
    await on('a', () => deleteImage('upload-1.png'));
    expect(holds('a')).toBe(false);

    // C returns and syncs with B first, so it copies the image after the delete.
    await sweep('c', 'b');
    expect(holds('c')).toBe(true);

    // A sweeps C: C's copy carries no creation stamp, so A keeps the name blocked.
    await sweep('a', 'c');
    expect(holds('a')).toBe(false);

    // C sweeps A: A's manifest tombstone retires C's copy despite its new file time.
    await sweep('c', 'a');
    expect(holds('c')).toBe(false);

    // B gets A's delete frame late (on reconnect): it retires its copy too.
    const [tombstone] = await on('a', () => listMediaTombstones('image'));
    const frame = { v: 1, category: 'imageHistory', op: 'delete', id: 'upload-1.png', tombstone, originInstanceId: 'inst-a' };
    expect((await on('b', () => applyPeerSyncEvent({ id: 'rec-a' }, frame))).applied).toBe(true);
    expect(holds('b')).toBe(false);

    // Further sweeps in every direction bring nothing back.
    for (const [receiver, sender] of [['a', 'b'], ['a', 'c'], ['b', 'c'], ['c', 'b'], ['b', 'a']]) await sweep(receiver, sender);
    expect(['a', 'b', 'c'].filter(holds)).toEqual([]);
  });
});
