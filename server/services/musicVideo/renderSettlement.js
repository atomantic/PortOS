/**
 * Music Video: the terminal project write of a final render (#15154). A render
 * planned on the old song must not mark the project complete, so every terminal
 * write runs `settleMusicVideoRender` inside the project mutation.
 */
import { audioRevisionOf } from '../../lib/musicVideoSongAudio.js';
import { applyProjectPatch } from './projectsLogic.js';

// #9010: an in-flight render mark names its instance in `renderingOn`. A booting
// machine recovers only ITS OWN marks (or legacy unstamped ones): records
// federate, and a peer's render may still be running.
export const isLocalRenderMark = (renderingOn, instanceId) => !renderingOn || renderingOn === instanceId;

export const SONG_CHANGED_DURING_RENDER = 'The song changed during the final render';

const CLEARED_RENDER_MARK = Object.freeze({ renderingOn: null, renderPartialFilename: null, renderResume: null, renderAudioRevision: null });

// Terminal writes clear the in-flight stamp and partial-output pointer; no error
// unless `extra` names one.
export const settledRender = (status, extra = {}) => ({ status, renderError: null, ...extra, ...CLEARED_RENDER_MARK });

/**
 * Settle a render job on `current` (read inside the mutation). `settled` is false
 * when the song changed after the job started; its outputs are not applied.
 */
export function settleMusicVideoRender(current, { jobRevision, status, extra = {}, instanceId }) {
  if (audioRevisionOf(current) === audioRevisionOf(jobRevision)) {
    return { project: applyProjectPatch(current, settledRender(status, extra)), settled: true };
  }
  // The mark is ours only if not written by a newer render on the new song.
  const ownsMark = isLocalRenderMark(current.renderingOn, instanceId)
    && (current.renderAudioRevision == null || audioRevisionOf(current.renderAudioRevision) === audioRevisionOf(jobRevision));
  if (!ownsMark) return { project: current, settled: false };
  // Keep the newer command's status; only a `rendering` mark from this job is demoted.
  const demoted = current.status === 'rendering' ? { status: current.audioAnalysis ? 'analyzed' : 'draft' } : {};
  return { project: applyProjectPatch(current, { ...demoted, ...CLEARED_RENDER_MARK }), settled: false };
}
