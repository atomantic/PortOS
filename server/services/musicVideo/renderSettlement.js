/**
 * Music Video — the terminal project write of a final render (#15154).
 *
 * A render plans from the project it read at start. If the song changed while
 * it ran, that plan belongs to the old song, so its settle must not mark the
 * project complete. Every terminal status write runs `settleMusicVideoRender`
 * inside the project mutation, against the freshest row.
 */
import { audioRevisionOf } from '../../lib/musicVideoSongAudio.js';
import { applyProjectPatch } from './projectsLogic.js';

// #9010: an in-flight render mark (`status: 'rendering'` on a project, or on
// one of its draft excerpts) names the instance running it in `renderingOn`.
// Project records federate between a user's machines, so a booting machine
// must only treat ITS OWN marks as crashed jobs — a peer's mark describes a
// render that may still be running there. A legacy mark with no stamp predates
// the field and is recovered as before.
export const isLocalRenderMark = (renderingOn, instanceId) => !renderingOn || renderingOn === instanceId;

const CLEARED_RENDER_MARK = Object.freeze({ renderingOn: null, renderPartialFilename: null, renderResume: null, renderAudioRevision: null });

// Every terminal project write clears the in-flight mark's stamp and the
// partial-output pointer alongside the status.
// A settled render carries no error unless `extra` names one: a finished render
// never keeps the message of an earlier attempt.
export const settledRender = (status, extra = {}) => ({ status, renderError: null, ...extra, ...CLEARED_RENDER_MARK });

/**
 * Settle a render job on `current`, the project row read inside the mutation.
 * Returns `{ project, settled }`; `settled` is false when the song changed after
 * the job started, and then the job's status and outputs are not applied.
 *
 * Ordering is guaranteed on one machine only: the track change and this settle
 * share the per-project write queue. Peer sync stays last-write-wins, so a peer
 * that settles before it has seen the revision bump can still complete.
 */
export function settleMusicVideoRender(current, { jobRevision, status, extra = {}, instanceId }) {
  if (audioRevisionOf(current) === audioRevisionOf(jobRevision)) {
    return { project: applyProjectPatch(current, settledRender(status, extra)), settled: true };
  }
  // The mark is this job's only when it is ours and was not written by a newer
  // render (one started on the new song after this job released its slot).
  const ownsMark = isLocalRenderMark(current.renderingOn, instanceId)
    && (current.renderAudioRevision == null || audioRevisionOf(current.renderAudioRevision) === audioRevisionOf(jobRevision));
  if (!ownsMark) return { project: current, settled: false };
  // The status the newer command stored stays. Only a `rendering` mark this job
  // wrote after the track change is demoted, to what the new song supports.
  const demoted = current.status === 'rendering' ? { status: current.audioAnalysis ? 'analyzed' : 'draft' } : {};
  return { project: applyProjectPatch(current, { ...demoted, ...CLEARED_RENDER_MARK }), settled: false };
}
