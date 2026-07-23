/**
 * Music tracks — storage backend dispatcher.
 *
 * Tracks are `db-primary` (PostgreSQL `tracks` table). This thin dispatcher
 * mirrors `services/albums/index.js`: select the backend lazily on first call.
 *   - PostgreSQL (db.js) for normal installs.
 *   - File (file.js) only via MEMORY_BACKEND=file or NODE_ENV=test.
 *
 * The recordEvents emits feed the per-record peer-sync pipeline, so tracks
 * federate when peers enable the Tracks sync category.
 */

import { randomUUID } from 'crypto';
import { createRecordStoreBackendSelector } from '../../lib/pgFileFacade.js';
import { emitRecordUpdated, emitRecordDeleted, autoSubscribeRecordToAllPeers } from '../sharing/recordEvents.js';
import { makeRender as makeRenderLogic } from './logic.js';

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
  RENDER_ID_MAX,
  RENDERS_MAX,
  TRACK_ID_RE,
  trackAudioFilename,
  makeRender,
  selectRenderPatch,
  deleteRenderPatch,
} from './logic.js';

// Shared dispatcher (#2909). ensureSchema() runs inside the selector so the
// backend is self-sufficient regardless of boot ordering.
const { selectBackend, getBackendName, reset } = createRecordStoreBackendSelector({
  label: 'Tracks',
  loadFileBackend: () => import('./file.js'),
  loadDbBackend: () => import('./db.js'),
  requireDbMessage: 'Tracks require PostgreSQL — run `npm run setup:db` (dev/test only: set MEMORY_BACKEND=file in .env for the unsupported file backend)',
});

/**
 * Mint a new render (unique id + timestamp) and return the appended history +
 * the render itself. Centralizes the id/now generation + append so every
 * render-creation path (generate, upload, attach) stays identical — callers
 * layer their own active-pointer fields onto the returned `renders` patch.
 */
export function buildRenderAppend(track, renderInput) {
  const render = makeRenderLogic(renderInput, { id: `render-${randomUUID()}`, now: new Date().toISOString() });
  return { render, renders: [...(track?.renders || []), render] };
}

/** Name of the active backend, or null before first call (for diagnostics/tests). */
export function getTracksBackendName() {
  return getBackendName();
}

/** Test seam — drop the memoized backend so a suite can re-select. */
export function _resetTracksBackend() {
  reset();
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
