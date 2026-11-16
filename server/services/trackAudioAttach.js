/**
 * Attach a library audio file to a track as its active render. Shared by the
 * per-track upload/attach routes and the autonomous Music Video run, so every
 * path that lands audio on a track records the same render card.
 */
import { ServerError } from '../lib/errorHandler.js';
import * as tracks from './tracks/index.js';

/**
 * Make `filename` the active audio and record it in the render history. An
 * uploaded render has no engine/model, so active gen-metadata is cleared; `take`
 * carries provenance, prompt/lyrics and probed duration. Re-attaching a file
 * already in history just re-selects it. Re-reads the track so the append builds
 * on the freshest persisted renders, not the caller's stale array.
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
