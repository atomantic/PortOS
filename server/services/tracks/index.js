/**
 * Music tracks — storage backend dispatcher.
 *
 * Tracks are `db-primary` (PostgreSQL `tracks` table). This thin dispatcher
 * mirrors `services/albums/index.js`: select the backend lazily on first call.
 *   - PostgreSQL (db.js) for normal installs.
 *   - File (file.js) only via MEMORY_BACKEND=file or NODE_ENV=test.
 *
 * The recordEvents emits are kept so the store is federation-ready, but the
 * track record kind is NOT yet registered in peerSync, so they are no-ops —
 * tracks are local-only until cross-peer sync is wired (see issue #1502).
 */

import { checkHealth, ensureSchema } from '../../lib/db.js';
import { emitRecordUpdated, emitRecordDeleted, autoSubscribeRecordToAllPeers } from '../sharing/recordEvents.js';

export {
  TITLE_MAX,
  ALBUM_ID_MAX,
  ARTIST_ID_MAX,
  ARTIST_NAME_MAX,
  LYRICS_MAX,
  PROMPT_MAX,
  ENGINE_MAX,
  MODEL_ID_MAX,
  AUDIO_FILENAME_MAX,
  DURATION_MIN_SEC,
  DURATION_MAX_SEC,
  TRACK_ID_RE,
  trackAudioFilename,
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
    throw new Error('Tracks require PostgreSQL — run `npm run setup:db` (dev/test only: set MEMORY_BACKEND=file in .env for the unsupported file backend)');
  }
  await ensureSchema();
  backend = await import('./db.js');
  backendName = 'postgres';
  return backend;
}

/** Name of the active backend, or null before first call (for diagnostics/tests). */
export function getTracksBackendName() {
  return backendName;
}

/** Test seam — drop the memoized backend so a suite can re-select. */
export function _resetTracksBackend() {
  backend = null;
  backendName = null;
}

export async function listTracks(options = {}) {
  return (await selectBackend()).listTracks(options);
}

export async function listTrackIds(options = {}) {
  return (await selectBackend()).listTrackIds(options);
}

export async function getTrack(id, options = {}) {
  return (await selectBackend()).getTrack(id, options);
}

function announceNewTrack(id) {
  emitRecordUpdated('track', id);
  autoSubscribeRecordToAllPeers('track', id).catch(() => {});
}

export async function createTrack(input) {
  const track = await (await selectBackend()).createTrack(input);
  announceNewTrack(track.id);
  return track;
}

export async function updateTrack(id, patch) {
  const next = await (await selectBackend()).updateTrack(id, patch);
  emitRecordUpdated('track', next.id);
  return next;
}

export async function deleteTrack(id) {
  const result = await (await selectBackend()).deleteTrack(id);
  emitRecordDeleted('track', result.id);
  return result;
}

/** Merge an incoming batch of track records from a peer (LWW, tombstone-aware). */
export async function mergeTracksFromSync(remoteTracks, options = {}) {
  return (await selectBackend()).mergeTracksFromSync(remoteTracks, options);
}

/** Hard-remove track tombstones older than the cutoff (called by tombstone GC). */
export async function pruneTombstonedTracks(olderThanMs) {
  return (await selectBackend()).pruneTombstonedTracks(olderThanMs);
}
