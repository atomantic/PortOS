/**
 * Track-to-album mutations shared by HTTP saves and Music Studio completion.
 * Validate the destination before writing either side: the album sanitizer's
 * read/sync cap intentionally truncates overflow rather than rejecting it.
 */
import { ServerError } from '../lib/errorHandler.js';
import { TRACK_IDS_MAX } from './albums/logic.js';
import * as albums from './albums/index.js';
import * as tracks from './tracks/index.js';
import { withMusicMutation } from './musicMembershipMutation.js';

async function destinationAlbum(albumId, trackId) {
  if (!albumId) return null;
  const album = await albums.getAlbum(albumId);
  if (!album) throw new ServerError('Album not found', { status: 404, code: 'ALBUM_NOT_FOUND' });
  const ids = album.trackIds || [];
  if (!ids.includes(trackId) && ids.length >= TRACK_IDS_MAX) {
    throw new ServerError(`Album already has ${TRACK_IDS_MAX} tracks. Remove a track before adding another.`, {
      status: 409, code: 'ALBUM_FULL',
    });
  }
  return album;
}

async function appendTrackToAlbum(trackId, album) {
  if (!album || (album.trackIds || []).includes(trackId)) return;
  await albums.updateAlbum(album.id, { trackIds: [...(album.trackIds || []), trackId] });
}

async function removeTrackFromAlbum(trackId, albumId) {
  if (!albumId) return;
  const album = await albums.getAlbum(albumId);
  if (album?.trackIds?.includes(trackId)) {
    await albums.updateAlbum(albumId, { trackIds: album.trackIds.filter((id) => id !== trackId) });
  }
}

/** Completed audio may survive an unavailable destination as a single. */
export async function createTrackWithAlbum(input, { preserveUnassigned = false } = {}) {
  return withMusicMutation(async () => {
    let albumAssignmentError = null;
    const album = await destinationAlbum(input.albumId).catch((err) => {
      if (!preserveUnassigned || !['ALBUM_FULL', 'ALBUM_NOT_FOUND'].includes(err.code)) throw err;
      albumAssignmentError = { code: err.code, message: err.message };
      return null;
    });
    const track = await tracks.createTrack({ ...input, albumId: album?.id || '' });
    await appendTrackToAlbum(track.id, album);
    return { track, albumAssignmentError };
  });
}

export async function updateTrackWithAlbum(current, patch) {
  return withMusicMutation(async () => {
    // Callers may have read the track before another move/delete committed.
    const fresh = await tracks.getTrack(current.id);
    if (!fresh) throw new ServerError('Track not found', { status: 404, code: 'NOT_FOUND' });
    if (!('albumId' in patch)) return tracks.updateTrack(fresh.id, patch);
    const album = await destinationAlbum(patch.albumId, fresh.id);
    const track = await tracks.updateTrack(fresh.id, patch);
    await appendTrackToAlbum(track.id, album);
    if (fresh.albumId !== track.albumId) await removeTrackFromAlbum(track.id, fresh.albumId);
    return track;
  });
}

export async function deleteTrackWithAlbum(id) {
  return withMusicMutation(async () => {
    const track = await tracks.getTrack(id);
    if (!track) throw new ServerError('Track not found', { status: 404, code: 'NOT_FOUND' });
    await removeTrackFromAlbum(id, track.albumId);
    return tracks.deleteTrack(id);
  });
}

async function reconcileAlbumMembership(album) {
  const desired = new Set(album.trackIds || []);
  const all = await tracks.listTracks();
  for (const track of all) {
    if (desired.has(track.id)) {
      if (track.albumId === album.id) continue;
      await removeTrackFromAlbum(track.id, track.albumId);
      await tracks.updateTrack(track.id, { albumId: album.id });
    } else if (track.albumId === album.id) {
      await tracks.updateTrack(track.id, { albumId: '' });
    }
  }
  // Missing/deleted ids remain tolerated, as in the existing album contract.
  // Read/write failures propagate and roll back the entire mutation.
}

export async function createAlbumWithTracks(input) {
  return withMusicMutation(async () => {
    const album = await albums.createAlbum(input);
    await reconcileAlbumMembership(album);
    return album;
  });
}

export async function updateAlbumWithTracks(id, patch) {
  return withMusicMutation(async () => {
    const album = await albums.updateAlbum(id, patch);
    if ('trackIds' in patch) await reconcileAlbumMembership(album);
    return album;
  });
}

export async function deleteAlbumWithTracks(id) {
  return withMusicMutation(async () => {
    const result = await albums.deleteAlbum(id);
    await reconcileAlbumMembership({ id, trackIds: [] });
    return result;
  });
}
