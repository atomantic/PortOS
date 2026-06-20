/**
 * Artist file-backend store — CRUD + LWW merge outcomes.
 *
 * Covers the CRUD round-trip on the file backend (which the normal, non-DB suite
 * exercises) and the `mergeArtistsFromSync` LWW outcomes (insert / newer-wins /
 * older-loses / tombstone), asserted via getArtist/listArtists.
 *
 * NOTE: the conflict-journal base-hash + journaling SIDE EFFECTS that authors'
 * file.test.js asserts are intentionally NOT covered here — they depend on the
 * artist record kind being registered in syncWire/peerSync (cross-peer sync),
 * which is deferred (artists are local-only for now — see issue #1502). When that
 * registration lands, this suite should grow the base-hash/journaling assertions
 * to mirror authors. Runs against a tmpdir so it never touches real `data/`.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'artists-file-test-'));

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, data: TEST_DATA_ROOT } };
});

const file = await import('./file.js');

function reset() {
  rmSync(join(TEST_DATA_ROOT, 'artists.json'), { force: true });
  rmSync(join(TEST_DATA_ROOT, 'sharing'), { recursive: true, force: true });
  rmSync(join(TEST_DATA_ROOT, 'conflict-journal'), { recursive: true, force: true });
}

const artist = (id, extra = {}) => ({
  id, name: id, genre: '', bio: '', musicalStyle: '', physicalDescription: '',
  portraitStyle: '', portraitImageUrl: '',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  deleted: false, deletedAt: null, ...extra,
});

beforeEach(reset);
afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

describe('artists file backend — CRUD', () => {
  it('creates, reads, updates and soft-deletes an artist', async () => {
    const created = await file.createArtist({ name: 'Nova', genre: 'dream pop' });
    expect(created.id).toMatch(/^artist-/);
    expect((await file.getArtist(created.id)).genre).toBe('dream pop');

    const updated = await file.updateArtist(created.id, { genre: 'shoegaze' });
    expect(updated.genre).toBe('shoegaze');

    await file.deleteArtist(created.id);
    expect(await file.getArtist(created.id)).toBeNull();
    expect(await file.getArtist(created.id, { includeDeleted: true })).toBeTruthy();
    expect(await file.listArtists()).toHaveLength(0);
  });

  it('lists live artists sorted by name', async () => {
    await file.createArtist({ name: 'Zephyr' });
    await file.createArtist({ name: 'Aria' });
    const names = (await file.listArtists()).map((a) => a.name);
    expect(names).toEqual(['Aria', 'Zephyr']);
  });
});

describe('artists file backend — mergeArtistsFromSync (LWW outcomes)', () => {
  it('inserts a remote artist with no local counterpart', async () => {
    const res = await file.mergeArtistsFromSync([artist('artist-1', { bio: 'inserted' })]);
    expect(res).toEqual({ applied: true, count: 1 });
    expect((await file.getArtist('artist-1')).bio).toBe('inserted');
  });

  it('a newer remote wins; an older remote is a no-op', async () => {
    await file.mergeArtistsFromSync([artist('artist-1', { bio: 'v1', updatedAt: '2026-02-01T00:00:00.000Z' })]);

    const newer = await file.mergeArtistsFromSync([artist('artist-1', { bio: 'v2', updatedAt: '2026-03-01T00:00:00.000Z' })]);
    expect(newer).toEqual({ applied: true, count: 1 });
    expect((await file.getArtist('artist-1')).bio).toBe('v2');

    const older = await file.mergeArtistsFromSync([artist('artist-1', { bio: 'stale', updatedAt: '2020-01-01T00:00:00.000Z' })]);
    expect(older).toEqual({ applied: false, count: 0 });
    expect((await file.getArtist('artist-1')).bio).toBe('v2');
  });

  it('a newer remote tombstone soft-deletes the live local record', async () => {
    await file.mergeArtistsFromSync([artist('artist-1', { bio: 'live', updatedAt: '2026-01-01T00:00:00.000Z' })]);
    await file.mergeArtistsFromSync([
      artist('artist-1', { deleted: true, deletedAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z' }),
    ]);
    expect(await file.getArtist('artist-1')).toBeNull();
    expect(await file.getArtist('artist-1', { includeDeleted: true })).toBeTruthy();
  });

  it('pruneTombstonedArtists hard-removes an old tombstone', async () => {
    await file.mergeArtistsFromSync([
      artist('artist-dead', { deleted: true, deletedAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' }),
    ]);
    const res = await file.pruneTombstonedArtists(Date.parse('2030-01-01T00:00:00.000Z'));
    expect(res).toEqual({ pruned: 1 });
    expect(await file.getArtist('artist-dead', { includeDeleted: true })).toBeNull();
  });
});
