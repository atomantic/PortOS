import {
  renderMusicVideoProject,
  musicVideoRenderEventsUrl,
  cancelMusicVideoRender,
} from '../services/apiMusicVideo.js';
import useSseJobSlot from './useSseJobSlot.js';

const readRenderPercent = (frame) => Number.isFinite(frame.progress) ? frame.progress * 100 : undefined;

// A server-owned render may already exist after returning to the page. Attach
// through the same successful kickoff path; a still-preparing 409 has no jobId.
const startRender = (projectId) => renderMusicVideoProject(projectId, { silent: true })
  .catch((err) => {
    if (err?.status === 409 && err?.context?.jobId) return { jobId: err.context.jobId };
    throw err;
  });

/**
 * Final-render adapter over the shared SSE slot. Captures the project before
 * preparation begins, so navigation cannot replace the render or redirect its
 * callbacks. The job shape stays compatible with the existing cancel controls.
 */
export default function useMusicVideoRenderJob({ onRendered, onFailed } = {}) {
  const slot = useSseJobSlot({
    startRequest: startRender,
    eventsUrl: musicVideoRenderEventsUrl,
    cancelRequest: cancelMusicVideoRender,
    readPercent: readRenderPercent,
    onComplete: (frame, projectId) => onRendered?.(projectId, frame.result || {}),
    onErrorFrame: (_frame, projectId) => { onFailed?.(projectId); },
    successToast: () => 'Music video rendered',
    errorFallback: 'Render failed',
    canceledMessage: 'Render cancelled',
    lostConnectionMessage: 'Lost connection to the render — check Media History for the result',
    startErrorFallback: 'Failed to start render',
  });
  return {
    ...slot,
    job: slot.jobId ? { jobId: slot.jobId, projectId: slot.context } : null,
    progress: slot.active ? slot.percent : 0,
  };
}
