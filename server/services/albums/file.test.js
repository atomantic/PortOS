/**
 * Album file-backend store — CRUD + LWW merge outcomes.
 *
 * Covers the CRUD round-trip the normal (non-DB) suite exercises plus the
 * `mergeAlbumsFromSync` LWW outcomes. The conflict-journal base-hash side
 * effects are NOT asserted here — they depend on the album record kind being
 * registered in syncWire/peerSync (deferred; local-only — see issue #1502).
 * Runs against a tmpdir so it never touches real `data/`.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'albums-file-test-'));

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, data: TEST_DATA_ROOT } };
});

const file = await import('./file.js');

function reset() {
  rmSync(join(TEST_DATA_ROOT, 'albums.json'), { force: true });
  rmSync(join(TEST_DATA_ROOT, 'sharing'), { recursive: true, force: true });
  rmSync(join(TEST_DATA_ROOT, 'conflict-journal'), { recursive: true, force: true });
}

const album = (id, extra = {}) => ({
  id, title: id, artistId: '', artist: '', description: '', genre: '',
  releaseYear: null, coverImageUrl: '', trackIds: [],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  deleted: false, deletedAt: null, ...extra,
});

beforeEach(reset);
afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

describe('albums file backend — CRUD', () => {
  it('creates, reads, updates and soft-deletes an album', async () => {
    const created = await file.createAlbum({ title: 'Debut', genre: 'folk', trackIds: ['track-1'] });
    expect(created.id).toMatch(/^album-/);
    expect((await file.getAlbum(created.id)).trackIds).toEqual(['track-1']);

    const updated = await file.updateAlbum(created.id, { trackIds: ['track-2', 'track-1'] });
    expect(updated.trackIds).toEqual(['track-2', 'track-1']);

    await file.deleteAlbum(created.id);
    expect(await file.getAlbum(created.id)).toBeNull();
    expect(await file.listAlbums()).toHaveLength(0);
  });

  it('lists live albums sorted by title', async () => {
    await file.createAlbum({ title: 'Zenith' });
    await file.createAlbum({ title: 'Aurora' });
    expect((await file.listAlbums()).map((a) => a.title)).toEqual(['Aurora', 'Zenith']);
  });
});

describe('albums file backend — mergeAlbumsFromSync (LWW outcomes)', () => {
  it('inserts, then newer wins / older no-ops', async () => {
    expect(await file.mergeAlbumsFromSync([album('album-1', { genre: 'v1', updatedAt: '2026-02-01T00:00:00.000Z' })]))
      .toEqual({ applied: true, count: 1 });
    expect(await file.mergeAlbumsFromSync([album('album-1', { genre: 'v2', updatedAt: '2026-03-01T00:00:00.000Z' })]))
      .toEqual({ applied: true, count: 1 });
    expect((await file.getAlbum('album-1')).genre).toBe('v2');
    expect(await file.mergeAlbumsFromSync([album('album-1', { genre: 'stale', updatedAt: '2020-01-01T00:00:00.000Z' })]))
      .toEqual({ applied: false, count: 0 });
  });

  it('pruneTombstonedAlbums hard-removes an old tombstone', async () => {
    await file.mergeAlbumsFromSync([album('album-dead', { deleted: true, deletedAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' })]);
    expect(await file.pruneTombstonedAlbums(Date.parse('2030-01-01T00:00:00.000Z'))).toEqual({ pruned: 1 });
    expect(await file.getAlbum('album-dead', { includeDeleted: true })).toBeNull();
  });
});
