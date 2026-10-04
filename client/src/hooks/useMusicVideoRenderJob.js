import { useEffect, useRef, useState } from 'react';
import {
  getMusicVideoActiveRender,
  renderMusicVideoProject,
  musicVideoRenderEventsUrl,
  cancelMusicVideoRender,
} from '../services/apiMusicVideo.js';
import toast from '../components/ui/Toast';
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
 *
 * A project the server marks `rendering` re-attaches on load (#9940) — the
 * same way excerpt renders do — through a READ of the live job
 * (`getMusicVideoActiveRender`), never a POST that would start a new render.
 * `reattach(projectId)` is the explicit retry the "Needs attention" banner
 * offers when that automatic attempt found no job or the slot was busy.
 */
export default function useMusicVideoRenderJob({ project, onRendered, onFailed } = {}) {
  const [failure, setFailure] = useState(null);
  const slot = useSseJobSlot({
    startRequest: startRender,
    eventsUrl: musicVideoRenderEventsUrl,
    cancelRequest: cancelMusicVideoRender,
    readPercent: readRenderPercent,
    onComplete: (frame, projectId) => { setFailure(null); onRendered?.(projectId, frame.result || {}); },
    onErrorFrame: (frame, projectId) => {
      setFailure({ projectId, message: frame.error || 'Render failed' });
      onFailed?.(projectId, frame.error || 'Render failed');
    },
    onKickoffError: (error, projectId) => { setFailure({ projectId, message: error?.message || 'Failed to start render' }); },
    successToast: () => 'Music video rendered',
    errorFallback: 'Render failed',
    canceledMessage: 'Render cancelled',
    lostConnectionMessage: 'Lost connection to the render — check Media History for the result',
    startErrorFallback: 'Failed to start render',
  });

  const [reattaching, setReattaching] = useState(false);
  const slotRef = useRef(slot);
  slotRef.current = slot;

  // Adopt the project's live render into the idle slot. Resolves true when it
  // is attached (or already is); false when there is none to attach to.
  const reattach = (projectId, { announce = true } = {}) => {
    if (!projectId) return Promise.resolve(false);
    setReattaching(true);
    return getMusicVideoActiveRender(projectId, { silent: true })
      .then(({ jobId }) => {
        if (!jobId) {
          if (announce) toast.info('No live render found on this machine — it may be rendering elsewhere, or it was interrupted');
          return false;
        }
        if (slotRef.current.jobId === jobId) return true;
        const attached = slotRef.current.attach(jobId, projectId);
        if (!attached && announce) toast.info('Another render already holds the progress view — finish or cancel it first');
        return attached;
      })
      .catch((err) => {
        if (announce) toast.error(err?.message || 'Could not look up the render');
        return false;
      })
      .finally(() => setReattaching(false));
  };

  const projectId = project?.id || null;
  const rendering = project?.status === 'rendering';
  useEffect(() => {
    if (!projectId || !rendering || slotRef.current.active) return undefined;
    let active = true;
    getMusicVideoActiveRender(projectId, { silent: true })
      .then(({ jobId }) => {
        if (active && jobId && !slotRef.current.active) slotRef.current.attach(jobId, projectId);
      })
      .catch(() => {});
    return () => { active = false; };
  }, [projectId, rendering]);

  return {
    ...slot,
    failure,
    reattaching,
    reattach,
    start: (id) => {
      if (slot.active) return;
      setFailure(null);
      slot.start(id);
    },
    job: slot.jobId ? { jobId: slot.jobId, projectId: slot.context } : null,
    progress: slot.active ? slot.percent : 0,
  };
}
