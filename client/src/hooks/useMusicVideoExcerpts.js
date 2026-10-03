import { useEffect, useRef, useState } from 'react';
import toast from '../components/ui/Toast';
import {
  getMusicVideoProject,
  renderMusicVideoExcerpt,
  musicVideoExcerptRenderEventsUrl,
  cancelMusicVideoExcerptRender,
  deleteMusicVideoExcerpt,
  addMusicVideoExcerptNote,
  updateMusicVideoExcerptNote,
  deleteMusicVideoExcerptNote,
} from '../services/apiMusicVideo.js';
import useSseJobSlot from './useSseJobSlot.js';

const readPercent = (frame) => (Number.isFinite(frame.progress) ? frame.progress * 100 : undefined);

/**
 * Music Video draft excerpt render + timecoded review notes (#8986).
 *
 * The render itself reuses the shared SSE job slot (one excerpt render at a
 * time per project, enforced server-side); every terminal frame — complete,
 * error, or cancelled — reloads the project instead of hand-merging the
 * result, since the persisted shape (status/filename/contactSheetFilename/
 * error) already lives on the server record and a refetch can't drift from it.
 *
 * Notes/delete calls return the fresh whole project in their response body,
 * so those apply it directly with `replaceProject` — no separate reload.
 *
 * `replaceProject(project)` swaps the local record whole; the caller supplies
 * it (mirrors `useMusicVideoTreatment`).
 */
export default function useMusicVideoExcerpts({ project, replaceProject } = {}) {
  const projectId = project?.id || null;
  const seenJobs = useRef(new Set());
  const [noteBusyId, setNoteBusyId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  // Reload the project the render was STARTED for, not whichever one is
  // currently selected — `job.start` below captures `projectId` as the slot's
  // `context`, handed back here on every terminal frame, so switching to a
  // different project mid-render can't reload/overwrite the wrong record.
  const reload = (id) => {
    if (!id) return;
    getMusicVideoProject(id, { silent: true }).then(replaceProject).catch(() => {});
  };

  const job = useSseJobSlot({
    startRequest: (body) => renderMusicVideoExcerpt(projectId, body, { silent: true }),
    eventsUrl: musicVideoExcerptRenderEventsUrl,
    cancelRequest: cancelMusicVideoExcerptRender,
    readPercent,
    onKickoffSuccess: id => seenJobs.current.add(id),
    onSettled: (_reason, id) => reload(id),
    onErrorFrame: () => true, // reload already surfaces the persisted `error` field; skip the generic toast
    onKickoffError: (err) => {
      if (err?.status === 409) { toast.error(err.message || 'An excerpt render is already in progress'); return true; }
      return false;
    },
    successToast: () => 'Excerpt rendered',
    errorFallback: 'Excerpt render failed',
    canceledMessage: 'Excerpt render cancelled',
    lostConnectionMessage: 'Lost connection to the excerpt render',
    startErrorFallback: 'Failed to start the excerpt render',
  });

  useEffect(() => {
    const excerpt = project?.excerpts?.find(e => e.status === 'rendering' && e.jobId);
    if (excerpt && !seenJobs.current.has(excerpt.jobId) && job.attach(excerpt.jobId, projectId)) seenJobs.current.add(excerpt.jobId);
  }, [project, projectId, job.active]);

  // #9280: a social cut passes its own frame (`aspect`) and faded audio edges.
  const startExcerpt = (startSec, endSec, { aspect = null, fade = false } = {}) => job.start({
    startSec, endSec, ...(aspect ? { aspect } : {}), ...(fade ? { fade: true } : {}),
  }, projectId);
  // #8987: a selective revision's resume starts its draft re-render server-side;
  // adopt that job so it shows the same progress and reloads on its finish.
  const attachRender = (jobId, id = projectId) => {
    const attached = job.attach(jobId, id);
    if (attached) seenJobs.current.add(jobId);
    return attached;
  };
  // An excerpt's id IS its render job id, so any rendering excerpt — including
  // one started before a reload, or by a revision — can be cancelled by id.
  const cancelExcerpt = (excerptId) => cancelMusicVideoExcerptRender(excerptId, { silent: true })
    .catch((err) => toast.error(err?.message || 'Failed to cancel the excerpt render'));

  const deleteExcerpt = (excerptId) => {
    setDeletingId(excerptId);
    return deleteMusicVideoExcerpt(projectId, excerptId, { silent: true })
      .then(replaceProject)
      .catch((err) => toast.error(err?.message || 'Failed to delete the excerpt'))
      .finally(() => setDeletingId(null));
  };

  const addNote = (excerptId, { atSec, note, verdict }) => {
    setNoteBusyId(excerptId);
    return addMusicVideoExcerptNote(projectId, excerptId, { atSec, note, ...(verdict ? { verdict } : {}) }, { silent: true })
      .then(({ project: next }) => { replaceProject(next); return next; })
      .catch((err) => { toast.error(err?.message || 'Failed to add the note'); return null; })
      .finally(() => setNoteBusyId(null));
  };

  const editNote = (excerptId, noteId, patch) => {
    setNoteBusyId(excerptId);
    return updateMusicVideoExcerptNote(projectId, excerptId, noteId, patch, { silent: true })
      .then(({ project: next }) => { replaceProject(next); return next; })
      .catch((err) => { toast.error(err?.message || 'Failed to update the note'); return null; })
      .finally(() => setNoteBusyId(null));
  };

  const deleteNote = (excerptId, noteId) => {
    setNoteBusyId(excerptId);
    return deleteMusicVideoExcerptNote(projectId, excerptId, noteId, { silent: true })
      .then(replaceProject)
      .catch((err) => toast.error(err?.message || 'Failed to delete the note'))
      .finally(() => setNoteBusyId(null));
  };

  return {
    occupied: job.active,
    rendering: job.active && job.context === projectId,
    activeRenderId: job.context === projectId ? job.jobId : null,
    connected: job.connected,
    progress: job.active && job.context === projectId ? job.percent : 0,
    deletingId,
    noteBusyId,
    startExcerpt,
    cancelExcerpt,
    attachRender,
    deleteExcerpt,
    addNote,
    editNote,
    deleteNote,
  };
}
