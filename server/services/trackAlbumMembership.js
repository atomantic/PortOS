/**
 * Track-to-album mutations shared by HTTP saves and Music Studio completion.
 * Validate the destination before writing either side: the album sanitizer's
 * read/sync cap intentionally truncates overflow rather than rejecting it.
 */
import { ServerError } from '../lib/errorHandler.js';
import { TRACK_IDS_MAX } from './albums/logic.js';
import * as albums from './albums/index.js';
import * as tracks from './tracks/index.js';

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

export async function removeTrackFromAlbum(trackId, albumId) {
  if (!albumId) return;
  const album = await albums.getAlbum(albumId);
  if (album?.trackIds?.includes(trackId)) {
    await albums.updateAlbum(albumId, { trackIds: album.trackIds.filter((id) => id !== trackId) });
  }
}

/** Completed audio may survive an unavailable destination as a single. */
export async function createTrackWithAlbum(input, { preserveUnassigned = false } = {}) {
  let albumAssignmentError = null;
  const album = await destinationAlbum(input.albumId).catch((err) => {
    if (!preserveUnassigned || !['ALBUM_FULL', 'ALBUM_NOT_FOUND'].includes(err.code)) throw err;
    albumAssignmentError = { code: err.code, message: err.message };
    return null;
  });
  const track = await tracks.createTrack({ ...input, albumId: album?.id || '' });
  await appendTrackToAlbum(track.id, album);
  return { track, albumAssignmentError };
}

export async function updateTrackWithAlbum(current, patch) {
  if (!('albumId' in patch)) return tracks.updateTrack(current.id, patch);
  const album = await destinationAlbum(patch.albumId, current.id);
  const track = await tracks.updateTrack(current.id, patch);
  await appendTrackToAlbum(track.id, album);
  if (current.albumId !== track.albumId) await removeTrackFromAlbum(track.id, current.albumId);
  return track;
}
