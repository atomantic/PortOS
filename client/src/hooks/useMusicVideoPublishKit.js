import { useState } from 'react';
import toast from '../components/ui/Toast';
import {
  getMusicVideoProject,
  buildMusicVideoPublishKit,
  musicVideoPublishKitEventsUrl,
  cancelMusicVideoPublishKit,
  draftMusicVideoPublishCopy,
  updateMusicVideoPublishCopy,
  selectMusicVideoPublishThumbnail,
} from '../services/apiMusicVideo.js';
import useSseJobSlot from './useSseJobSlot.js';

const readPercent = (frame) => (Number.isFinite(frame.progress) ? frame.progress * 100 : undefined);

/**
 * Music Video publishing kit (#9281): the build is a `useSseJobSlot` job whose
 * terminal frame reloads the project it was started for (the kit lives on the
 * server record); the copy draft, copy edits and thumbnail choice each return
 * the whole project and apply it with `replaceProject`.
 */
export default function useMusicVideoPublishKit({ project, replaceProject } = {}) {
  const projectId = project?.id || null;
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);

  const reload = (id) => {
    if (!id) return;
    getMusicVideoProject(id, { silent: true }).then(replaceProject).catch(() => {});
  };

  const job = useSseJobSlot({
    startRequest: () => buildMusicVideoPublishKit(projectId, { silent: true }),
    eventsUrl: musicVideoPublishKitEventsUrl,
    cancelRequest: cancelMusicVideoPublishKit,
    readPercent,
    onComplete: (_frame, id) => reload(id),
    onKickoffError: (err) => {
      if (err?.status === 409) { toast.error(err.message || 'The publishing kit cannot be built yet'); return true; }
      return false;
    },
    successToast: () => 'Publishing kit ready',
    errorFallback: 'Publishing kit build failed',
    canceledMessage: 'Publishing kit build cancelled',
    lostConnectionMessage: 'Lost connection to the publishing kit build',
    startErrorFallback: 'Failed to start the publishing kit build',
  });

  const apply = (res) => { if (res?.project) replaceProject(res.project); return res?.project || null; };

  const draftCopy = (body) => {
    setDrafting(true);
    return draftMusicVideoPublishCopy(projectId, body)
      .then(apply)
      .catch(() => null)
      .finally(() => setDrafting(false));
  };
  const saveCopy = (patch) => {
    setSaving(true);
    return updateMusicVideoPublishCopy(projectId, patch)
      .then(apply)
      .catch(() => null)
      .finally(() => setSaving(false));
  };
  const selectThumbnail = (filename) => selectMusicVideoPublishThumbnail(projectId, filename).then(apply).catch(() => null);

  return {
    building: job.active,
    progress: job.active ? job.percent : 0,
    build: () => job.start({}, projectId),
    cancelBuild: job.cancel,
    drafting,
    saving,
    draftCopy,
    saveCopy,
    selectThumbnail,
  };
}
