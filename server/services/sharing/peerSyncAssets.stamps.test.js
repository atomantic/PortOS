/**
 * Per-record push manifests carry an image's `createdAt` only for a receiver that
 * advertised it (#14067), so a re-made image under a re-used name outranks the
 * receiver's delete while an older receiver's strict schema never sees the field.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

let tempRoot;
vi.mock('../../lib/fileUtils.js', async importOriginal => makePathsProxy(await importOriginal(), { dataRoot: () => tempRoot }));
vi.mock('../../lib/paths.js', async importOriginal => makePathsProxy(await importOriginal(), { dataRoot: () => tempRoot }));

tempRoot = createTempDataRoot('portos-asset-stamps-');
const { PATHS } = await import('../../lib/fileUtils.js');
const { buildAssetManifest, diffAssetManifestAgainstLocal, stampImageManifestEntries, peerAcceptsAssetStamps } = await import('./peerSyncAssets.js');
const { recordMediaTombstone } = await import('../mediaTombstones.js');
const { PORTOS_SCHEMA_VERSIONS } = await import('../../lib/schemaVersions.js');

const REMADE = '2026-06-01T00:00:00.000Z';
const DELETED_AT = Date.parse('2026-03-01T00:00:00.000Z');

function seedImage(filename, sidecar) {
  mkdirSync(PATHS.images, { recursive: true });
  writeFileSync(join(PATHS.images, filename), Buffer.from(`bytes-${filename}`));
  writeFileSync(join(PATHS.images, filename.replace(/\.png$/, '.metadata.json')), JSON.stringify(sidecar));
}

beforeEach(() => {
  rmSync(PATHS.images, { recursive: true, force: true });
  rmSync(join(PATHS.data, 'media-tombstones.json'), { force: true });
});
afterAll(() => { rmSync(tempRoot, { recursive: true, force: true }); });

describe('per-record asset manifest image stamps', () => {
  it('an advertised receiver gets the re-made image through its tombstone; an older-stamped or unstamped one stays blocked', async () => {
    seedImage('remade.png', { prompt: 'p', createdAt: REMADE });
    seedImage('older.png', { prompt: 'p', createdAt: '2026-01-01T00:00:00.000Z' });
    seedImage('unstamped.png', { prompt: 'p' });
    const record = { imageRefs: ['remade.png', 'older.png', 'unstamped.png'] };
    const manifest = await buildAssetManifest(record);
    expect(manifest.every((entry) => entry.createdAt === undefined)).toBe(true);

    const stamped = await stampImageManifestEntries(manifest, { localInstanceId: 'local-inst' });
    // Receiver side: the files are not held there, but each name carries a delete.
    rmSync(PATHS.images, { recursive: true, force: true });
    for (const key of ['remade.png', 'older.png', 'unstamped.png']) await recordMediaTombstone('image', key, new Date(DELETED_AT).toISOString());

    const missing = await diffAssetManifestAgainstLocal(stamped);
    expect(missing.map((entry) => entry.filename)).toEqual(['remade.png']);
    expect(missing[0].createdAt).toBe(REMADE);
    // Without the stamp every tombstoned name stays blocked (pre-#14067 behavior).
    expect(await diffAssetManifestAgainstLocal(manifest)).toEqual([]);
  });

  it('stamps only images and leaves other entries untouched', async () => {
    seedImage('a.png', { prompt: 'p', createdAt: REMADE });
    const entries = [{ filename: 'a.png', kind: 'image', sha256: 'x' }, { filename: 'v.mp4', kind: 'video' }];
    const out = await stampImageManifestEntries(entries);
    expect(out[0].createdAt).toBe(REMADE);
    expect(out[1]).toBe(entries[1]);
  });

  it('only a receiver that advertises the capability is sent the field', () => {
    expect(peerAcceptsAssetStamps({ lastHealth: { assetStamps: { version: PORTOS_SCHEMA_VERSIONS.peerAssetStamps } } })).toBe(true);
    expect(peerAcceptsAssetStamps({ lastHealth: { peerAuth: { version: 1 } } })).toBe(false);
    expect(peerAcceptsAssetStamps({})).toBe(false);
    expect(peerAcceptsAssetStamps(null)).toBe(false);
  });
});
