import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAlbumRecord, TRACK_IDS_MAX } from './albums/logic.js';
import { buildTrackRecord } from './tracks/logic.js';

const records = vi.hoisted(() => ({ albums: new Map(), tracks: new Map() }));

// Exercise the real stored shapes: returning a patch verbatim would hide the
// album sanitizer silently dropping the appended 201st track while the caller
// still reports success.
vi.mock('./albums/index.js', async () => {
  const { applyAlbumPatch } = await import('./albums/logic.js');
  return {
    getAlbum: async (id) => records.albums.get(id) || null,
    updateAlbum: async (id, patch) => {
      const next = applyAlbumPatch(records.albums.get(id), patch);
      records.albums.set(id, next);
      return next;
    },
  };
});
vi.mock('./tracks/index.js', async () => {
  const logic = await import('./tracks/logic.js');
  return {
    ...logic,
    getTrack: async (id) => records.tracks.get(id) || null,
    createTrack: async (input) => {
      const next = logic.buildTrackRecord(input, { id: 'track-new', now: '2026-01-01T00:00:00.000Z' });
      records.tracks.set(next.id, next);
      return next;
    },
    updateTrack: async (id, patch) => {
      const next = logic.applyTrackPatch(records.tracks.get(id), patch);
      records.tracks.set(id, next);
      return next;
    },
  };
});

import { createTrackWithAlbum, updateTrackWithAlbum, removeTrackFromAlbum } from './trackAlbumMembership.js';

const now = '2026-01-01T00:00:00.000Z';

function seedAlbum(id, count) {
  const album = buildAlbumRecord({
    title: 'Example Album', trackIds: Array.from({ length: count }, (_, i) => `track-example-${i}`),
  }, { id, now });
  records.albums.set(id, album);
  return album;
}

function seedAssignedTrack() {
  const track = buildTrackRecord({ title: 'Example Track', albumId: 'album-old' }, { id: 'track-existing', now });
  const album = buildAlbumRecord({ title: 'Previous Album', trackIds: [track.id] }, { id: track.albumId, now });
  records.tracks.set(track.id, track);
  records.albums.set(album.id, album);
  return { track, album };
}

describe('track album membership through the stored record contract', () => {
  beforeEach(() => {
    records.albums.clear();
    records.tracks.clear();
  });

  it('rejects a create into a full album before persisting a track', async () => {
    const album = seedAlbum('album-full', TRACK_IDS_MAX);
    await expect(createTrackWithAlbum({ title: 'New Track', albumId: album.id }))
      .rejects.toMatchObject({ status: 409, code: 'ALBUM_FULL' });
    expect(records.tracks.size).toBe(0);
    expect(records.albums.get(album.id)).toEqual(album);
  });

  it('preserves the prior track and both albums when moving into a full album', async () => {
    const { track, album: prior } = seedAssignedTrack();
    const full = seedAlbum('album-full', TRACK_IDS_MAX);
    await expect(updateTrackWithAlbum(track, { title: 'Changed', albumId: full.id }))
      .rejects.toMatchObject({ status: 409, code: 'ALBUM_FULL' });
    expect(records.tracks.get(track.id)).toEqual(track);
    expect(records.albums.get(prior.id)).toEqual(prior);
    expect(records.albums.get(full.id)).toEqual(full);
  });

  it('fills the last slot and accepts re-selecting that member in the full album', async () => {
    const album = seedAlbum('album-last-slot', TRACK_IDS_MAX - 1);
    const { track } = await createTrackWithAlbum({ title: 'Last Track', albumId: album.id });
    expect(track.albumId).toBe(album.id);
    const reselected = await updateTrackWithAlbum(track, { albumId: album.id });
    expect(reselected.albumId).toBe(album.id);
    expect(records.albums.get(album.id).trackIds).toEqual([...album.trackIds, track.id]);
  });

  it('rejects a missing destination without removing existing membership', async () => {
    const { track, album } = seedAssignedTrack();
    await expect(updateTrackWithAlbum(track, { albumId: 'album-missing' }))
      .rejects.toMatchObject({ status: 404, code: 'ALBUM_NOT_FOUND' });
    expect(records.tracks.get(track.id)).toEqual(track);
    expect(records.albums.get(album.id)).toEqual(album);
  });

  it('moves a track between albums, appending to the destination and dropping the source', async () => {
    const { track, album: prior } = seedAssignedTrack();
    const next = seedAlbum('album-next', 2);
    const moved = await updateTrackWithAlbum(track, { albumId: next.id });
    expect(moved.albumId).toBe(next.id);
    expect(records.albums.get(next.id).trackIds).toEqual([...next.trackIds, track.id]);
    expect(records.albums.get(prior.id).trackIds).toEqual([]);
  });

  it('keeps completed audio as a single when its destination album is unavailable', async () => {
    const { track, albumAssignmentError } = await createTrackWithAlbum(
      { title: 'Rendered Track', albumId: 'album-missing' },
      { preserveUnassigned: true },
    );
    expect(track.albumId).toBe('');
    expect(albumAssignmentError).toEqual({ code: 'ALBUM_NOT_FOUND', message: 'Album not found' });
    expect(records.tracks.get(track.id)).toEqual(track);
  });

  it('removes a track from its album and ignores an album that no longer exists', async () => {
    const { track, album } = seedAssignedTrack();
    await removeTrackFromAlbum(track.id, album.id);
    expect(records.albums.get(album.id).trackIds).toEqual([]);
    await expect(removeTrackFromAlbum(track.id, 'album-missing')).resolves.toBeUndefined();
  });
});
