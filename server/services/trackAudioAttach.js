/**
 * Attach a library audio file to a track as its active render. Shared by the
 * per-track upload/attach routes and the autonomous Music Video run, so every
 * path that lands audio on a track records the same render card.
 */
import { ServerError } from '../lib/errorHandler.js';
import * as tracks from './tracks/index.js';

/**
 * Make `filename` the active audio AND record it in the render history so an
 * uploaded/attached take shows up as a card alongside generated ones. An
 * uploaded render has no engine/model, so the active gen-metadata is cleared
 * (keeps the read-only badges honest); `take` carries what IS known about it —
 * provenance, the prompt/lyrics it was made from, its probed duration.
 * Re-attaching a file already in the history just re-selects it (no duplicate
 * card).
 *
 * Re-reads the track by id (the caller validated existence earlier) so the
 * append builds on the FRESHEST persisted history: a render added to this track
 * between the caller's initial load and now — a long generation finishing, or a
 * parallel upload, both of which can span the file-import window — isn't dropped
 * by writing back a stale renders array. (The sub-millisecond getTrack→
 * updateTrack window is a single-user request race we don't lock against per the
 * trust model.)
 */
export async function attachAudioAsRender(trackId, filename, take = {}) {
  const track = await tracks.getTrack(trackId);
  if (!track) throw new ServerError('Track not found', { status: 404, code: 'NOT_FOUND' });
  const existing = (track.renders || []).find((r) => r.audioFilename === filename);
  if (existing) {
    const patch = tracks.selectRenderPatch(track, existing.id) || { audioFilename: filename };
    return tracks.updateTrack(trackId, patch);
  }
  const { renders } = tracks.buildRenderAppend(track, { ...take, audioFilename: filename });
  return tracks.updateTrack(trackId, {
    audioFilename: filename,
    engine: '',
    modelId: '',
    durationSec: take.durationSec ?? null,
    renders,
  });
}
