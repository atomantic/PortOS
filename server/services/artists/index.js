/**
 * Music artists — storage backend dispatcher.
 *
 * Artists are `db-primary` (PostgreSQL `artists` table). This thin dispatcher
 * mirrors `services/authors/index.js`: select the backend lazily on first call
 * so route imports + tests work regardless of boot ordering.
 *
 *   - PostgreSQL (db.js) for normal installs.
 *   - File (file.js) only via MEMORY_BACKEND=file or NODE_ENV=test.
 *
 * The recordEvents emits below feed the per-record peer-sync pipeline, so
 * artists federate when peers enable the Artists sync category.
 */

import { checkHealth, ensureSchema } from '../../lib/db.js';
import { emitRecordUpdated, emitRecordDeleted, autoSubscribeRecordToAllPeers } from '../sharing/recordEvents.js';

export {
  NAME_MAX,
  GENRE_MAX,
  BIO_MAX,
  MUSICAL_STYLE_MAX,
  PHYSICAL_DESCRIPTION_MAX,
  PORTRAIT_STYLE_MAX,
  PORTRAIT_IMAGE_URL_MAX,
  ARTIST_ID_RE,
  portraitImageFilename,
} from './logic.js';

let backend = null;
let backendName = null;

async function selectBackend() {
  if (backend) return backend;
  if (process.env.MEMORY_BACKEND === 'file' || process.env.NODE_ENV === 'test') {
    backend = await import('./file.js');
    backendName = 'file';
    return backend;
  }
  const health = await checkHealth();
  if (!health.connected) {
    throw new Error('Artists require PostgreSQL — run `npm run setup:db` (dev/test only: set MEMORY_BACKEND=file in .env for the unsupported file backend)');
  }
  await ensureSchema();
  backend = await import('./db.js');
  backendName = 'postgres';
  return backend;
}

/** Name of the active backend, or null before first call (for diagnostics/tests). */
export function getArtistsBackendName() {
  return backendName;
}

/** Test seam — drop the memoized backend so a suite can re-select. */
export function _resetArtistsBackend() {
  backend = null;
  backendName = null;
}

export async function listArtists(options = {}) {
  return (await selectBackend()).listArtists(options);
}

export async function listArtistIds(options = {}) {
  return (await selectBackend()).listArtistIds(options);
}

export async function getArtist(id, options = {}) {
  return (await selectBackend()).getArtist(id, options);
}

function announceNewArtist(id) {
  emitRecordUpdated('artist', id);
  autoSubscribeRecordToAllPeers('artist', id).catch(() => {});
}

export async function createArtist(input) {
  const artist = await (await selectBackend()).createArtist(input);
  announceNewArtist(artist.id);
  return artist;
}

export async function updateArtist(id, patch) {
  const next = await (await selectBackend()).updateArtist(id, patch);
  emitRecordUpdated('artist', next.id);
  return next;
}

export async function deleteArtist(id) {
  const result = await (await selectBackend()).deleteArtist(id);
  emitRecordDeleted('artist', result.id);
  return result;
}

/** Merge an incoming batch of artist records from a peer (LWW, tombstone-aware). */
export async function mergeArtistsFromSync(remoteArtists, options = {}) {
  return (await selectBackend()).mergeArtistsFromSync(remoteArtists, options);
}

/** Hard-remove artist tombstones older than the cutoff (called by tombstone GC). */
export async function pruneTombstonedArtists(olderThanMs) {
  return (await selectBackend()).pruneTombstonedArtists(olderThanMs);
}
