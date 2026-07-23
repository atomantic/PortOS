/**
 * Music albums — storage backend dispatcher.
 *
 * Albums are `db-primary` (PostgreSQL `albums` table). This thin dispatcher
 * mirrors `services/artists/index.js`: select the backend lazily on first call.
 *   - PostgreSQL (db.js) for normal installs.
 *   - File (file.js) only via MEMORY_BACKEND=file or NODE_ENV=test.
 *
 * The recordEvents emits feed the per-record peer-sync pipeline, so albums
 * federate when peers enable the Albums sync category.
 */

import { createRecordStoreBackendSelector } from '../../lib/pgFileFacade.js';
import { emitRecordUpdated, emitRecordDeleted, autoSubscribeRecordToAllPeers } from '../sharing/recordEvents.js';

export {
  TITLE_MAX,
  ARTIST_ID_MAX,
  ARTIST_NAME_MAX,
  DESCRIPTION_MAX,
  GENRE_MAX,
  COVER_IMAGE_URL_MAX,
  TRACK_IDS_MAX,
  TRACK_ID_MAX,
  RELEASE_YEAR_MIN,
  RELEASE_YEAR_MAX,
  ALBUM_ID_RE,
  coverImageFilename,
} from './logic.js';

// Shared dispatcher (#2909). ensureSchema() runs inside the selector so the
// backend is self-sufficient regardless of boot ordering.
const { selectBackend, getBackendName, reset } = createRecordStoreBackendSelector({
  label: 'Albums',
  loadFileBackend: () => import('./file.js'),
  loadDbBackend: () => import('./db.js'),
  requireDbMessage: 'Albums require PostgreSQL — run `npm run setup:db` (dev/test only: set MEMORY_BACKEND=file in .env for the unsupported file backend)',
});

/** Name of the active backend, or null before first call (for diagnostics/tests). */
export function getAlbumsBackendName() {
  return getBackendName();
}

/** Test seam — drop the memoized backend so a suite can re-select. */
export function _resetAlbumsBackend() {
  reset();
}

export async function listAlbums(options = {}) {
  return (await selectBackend()).listAlbums(options);
}

export async function listAlbumIds(options = {}) {
  return (await selectBackend()).listAlbumIds(options);
}

export async function getAlbum(id, options = {}) {
  return (await selectBackend()).getAlbum(id, options);
}

function announceNewAlbum(id) {
  emitRecordUpdated('album', id);
  autoSubscribeRecordToAllPeers('album', id).catch(() => {});
}

export async function createAlbum(input) {
  const album = await (await selectBackend()).createAlbum(input);
  announceNewAlbum(album.id);
  return album;
}

export async function updateAlbum(id, patch) {
  const next = await (await selectBackend()).updateAlbum(id, patch);
  emitRecordUpdated('album', next.id);
  return next;
}

export async function deleteAlbum(id) {
  const result = await (await selectBackend()).deleteAlbum(id);
  emitRecordDeleted('album', result.id);
  return result;
}

/** Merge an incoming batch of album records from a peer (LWW, tombstone-aware). */
export async function mergeAlbumsFromSync(remoteAlbums, options = {}) {
  return (await selectBackend()).mergeAlbumsFromSync(remoteAlbums, options);
}

/** Hard-remove album tombstones older than the cutoff (called by tombstone GC). */
export async function pruneTombstonedAlbums(olderThanMs) {
  return (await selectBackend()).pruneTombstonedAlbums(olderThanMs);
}
