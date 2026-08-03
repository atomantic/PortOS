import { useEffect, useState } from 'react';
import toast from '../components/ui/Toast';
import { updateMusicVideoProject } from '../services/apiMusicVideo.js';
import useYoutubeTrackImport from './useYoutubeTrackImport.js';

// Every surface that blocks a project switch during an in-flight import says the
// same thing — the page reuses this for its own list-picker/delete guards.
const SWITCH_BLOCKED_MESSAGE = 'Finish or cancel the in-progress YouTube import before switching projects';

/**
 * The music-video page's two YouTube audio-import slots (#1945): paste a URL,
 * PortOS downloads + extracts the track via yt-dlp and lands it in the shared
 * library. Two INDEPENDENT job slots — one per surface that can kick off an
 * import (the create form and the detail view's track-change row) — so starting
 * one doesn't orphan the other's in-flight job (see useYoutubeTrackImport).
 *
 * The edit slot is one shared slot for the whole detail view (not per-project),
 * so it captures the project it was started against and this hook re-asserts
 * that binding against URL-driven navigation (deep link, browser Back/Forward,
 * ⌘K / voice nav) — which changes the route without going through the page's own
 * selection guard. The import itself keeps running and still attaches to its
 * bound project; the bounce only keeps the shared progress UI from
 * misattributing to another project.
 *
 * `onTrackImported(track)` fires for both slots (add it to the track library);
 * `onCreateComplete(track)` only for the create form; `onProjectUpdated(project)`
 * once the edit slot's finished track is attached to its bound project.
 */
export default function useMusicVideoYoutubeImport({
  routeProjectId, navigate, onTrackImported, onCreateComplete, onProjectUpdated,
} = {}) {
  const [createUrl, setCreateUrl] = useState('');
  const [editUrl, setEditUrl] = useState('');
  // The project a detail-view import is bound to (captured at kickoff). The
  // import's shared UI slot (progress button + disabled track controls) belongs
  // to this project; it backstops the URL-nav guard below so a deep link / Back
  // / ⌘K can't strand that slot's UI against another project.
  const [editProjectId, setEditProjectId] = useState(null);

  const createJob = useYoutubeTrackImport({
    onComplete: (track) => {
      onTrackImported?.(track);
      onCreateComplete?.(track);
      setCreateUrl('');
    },
  });
  const editJob = useYoutubeTrackImport({
    onComplete: (track, projectId) => {
      onTrackImported?.(track);
      updateMusicVideoProject(projectId, { trackId: track.id }, { silent: true })
        .then((proj) => onProjectUpdated?.(proj))
        .catch((err) => toast.error(err?.message || 'Imported the track but failed to attach it to the project'));
      setEditUrl('');
    },
  });

  // Drop the binding once the import settles (or is cancelled) so the backstop
  // below stops guarding a project the user is free to leave again.
  useEffect(() => { if (!editJob.active) setEditProjectId(null); }, [editJob.active]);
  // While a detail-view import runs, bounce any navigation away from its bound
  // project back (replace, so history isn't polluted).
  useEffect(() => {
    if (!editJob.active || !editProjectId) return;
    if (routeProjectId !== editProjectId) {
      toast.error(SWITCH_BLOCKED_MESSAGE);
      navigate(`/music-video/${editProjectId}`, { replace: true });
    }
  }, [routeProjectId, editJob.active, editProjectId, navigate]);

  return {
    createUrl,
    setCreateUrl,
    editUrl,
    setEditUrl,
    createJob,
    editJob,
    switchBlockedMessage: SWITCH_BLOCKED_MESSAGE,
    startCreate: () => createJob.start(createUrl),
    startEdit: (projectId) => {
      setEditProjectId(projectId);
      editJob.start(editUrl, projectId);
    },
  };
}
