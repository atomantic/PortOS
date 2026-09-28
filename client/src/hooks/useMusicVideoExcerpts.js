import { useState } from 'react';
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
    startRequest: ({ startSec, endSec }) => renderMusicVideoExcerpt(projectId, { startSec, endSec }, { silent: true }),
    eventsUrl: musicVideoExcerptRenderEventsUrl,
    cancelRequest: cancelMusicVideoExcerptRender,
    readPercent,
    onComplete: (_frame, id) => reload(id),
    onErrorFrame: (_frame, id) => { reload(id); return true; }, // reload already surfaces the persisted `error` field; skip the generic toast
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

  const startExcerpt = (startSec, endSec) => job.start({ startSec, endSec }, projectId);

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
    rendering: job.active,
    progress: job.active ? job.percent : 0,
    deletingId,
    noteBusyId,
    startExcerpt,
    cancelExcerpt: job.cancel,
    deleteExcerpt,
    addNote,
    editNote,
    deleteNote,
  };
}
