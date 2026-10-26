/**
 * Shared mutable state for the single local-video lane.
 *
 * Generation, chained orchestration, and SSE attachment live in separate
 * modules but deliberately coordinate through this one process-local record.
 */

import { killWithEscalation } from '../../lib/killWithEscalation.js';
import { ServerError } from '../../lib/errorHandler.js';
import { attachSseClient as attachSse } from '../../lib/sseUtils.js';

export const videoJobState = {
  jobs: new Map(),
  activeProcess: null,
  cancelEpoch: 0,
  activeChain: null,
  // Renders between generateVideo() entry and a wired child. A cancel() in that
  // window has no process to kill but must still stop the render from spawning.
  preparing: 0,
};

// Brackets one render's pre-spawn phase. `throwIfCanceled()` is the spawn gate:
// any cancel() since this call (epoch bump) aborts the render before it starts.
export const beginPreparation = () => {
  const epoch = videoJobState.cancelEpoch;
  videoJobState.preparing += 1;
  let ended = false;
  const wasCanceled = () => videoJobState.cancelEpoch !== epoch;
  return {
    wasCanceled,
    throwIfCanceled: () => {
      if (wasCanceled()) throw new ServerError('Canceled before the render started', { status: 409, code: 'VIDEO_GEN_CANCELED' });
    },
    end: () => {
      if (ended) return;
      ended = true;
      videoJobState.preparing -= 1;
    },
  };
};

export const attachSseClient = (jobId, res) => attachSse(videoJobState.jobs, jobId, res);

export const cancel = () => {
  videoJobState.cancelEpoch += 1;
  // Flag a chain so its orchestrator stops between chunks, then terminate the
  // child currently holding the local GPU lane when one exists.
  if (videoJobState.activeChain) {
    videoJobState.activeChain.stopped = true;
    videoJobState.activeChain.abortController?.abort();
  }
  if (!videoJobState.activeProcess) {
    if (videoJobState.activeChain) return true;
    // 'pending': the job is ours and still preparing; the render will abort
    // itself at its next spawn gate. `false` stays "nothing cancelable here".
    return videoJobState.preparing > 0 ? 'pending' : false;
  }
  const proc = videoJobState.activeProcess;
  // Keep the handle until close so a new render cannot replace it before the
  // escalation timer has had a chance to SIGKILL a stubborn child.
  killWithEscalation(proc, {
    label: 'video child',
    stillRunning: () => videoJobState.activeProcess === proc,
  });
  return true;
};
