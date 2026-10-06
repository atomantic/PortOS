import { useEffect, useRef, useState } from 'react';
import toast from '../components/ui/Toast';
import {
  getMusicVideoProject,
  buildMusicVideoPublishKit,
  musicVideoPublishKitEventsUrl,
  cancelMusicVideoPublishKit,
  draftMusicVideoPublishCopy,
  updateMusicVideoPublishCopy,
  selectMusicVideoPublishThumbnail,
  updateMusicVideoSingleArtwork,
  generateMusicVideoSingleArtwork,
  adjustMusicVideoSingleArtwork,
  composeMusicVideoSingleArtwork,
  approveMusicVideoSingleArtwork,
  unapproveMusicVideoSingleArtwork,
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
  const [artworkBusy, setArtworkBusy] = useState(null);

  const reload = (id) => {
    if (!id) return;
    getMusicVideoProject(id, { silent: true }).then(replaceProject).catch(() => {});
  };

  const attachedJobs = useRef(new Set());

  const job = useSseJobSlot({
    startRequest: () => buildMusicVideoPublishKit(projectId, { silent: true }),
    eventsUrl: musicVideoPublishKitEventsUrl,
    cancelRequest: cancelMusicVideoPublishKit,
    readPercent,
    onComplete: (_frame, id) => reload(id),
    onKickoffError: (err) => {
      // A build is already running (another tab, or this one before a reload): adopt it.
      if (err?.code === 'PUBLISH_KIT_BUILD_IN_PROGRESS' && err.context?.jobId) {
        job.attach(err.context.jobId, projectId);
        return true;
      }
      if (err?.status === 409) { toast.error(err.message || 'The publishing kit cannot be built yet'); return true; }
      return false;
    },
    successToast: () => 'Publishing kit ready',
    errorFallback: 'Publishing kit build failed',
    canceledMessage: 'Publishing kit build cancelled',
    lostConnectionMessage: 'Lost connection to the publishing kit build',
    startErrorFallback: 'Failed to start the publishing kit build',
  });

  // Reload or second tab: adopt the build the server says is running. Each jobId is
  // adopted once, so the stale record can't re-adopt a build that already finished.
  const runningJobId = project?.activePublishKitBuild?.jobId || null;
  useEffect(() => {
    if (!runningJobId || !projectId || attachedJobs.current.has(runningJobId)) return;
    if (job.attach(runningJobId, projectId)) attachedJobs.current.add(runningJobId);
  }, [runningJobId, projectId]);

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

  // Single artwork (#10331): one action at a time, each returning the whole project.
  const artworkAction = (label, run) => {
    setArtworkBusy(label);
    return run().then(apply).catch(() => null).finally(() => setArtworkBusy(null));
  };
  const singleArtwork = {
    busy: artworkBusy,
    save: (patch) => artworkAction('save', () => updateMusicVideoSingleArtwork(projectId, patch)),
    generate: (body) => artworkAction('generate', () => generateMusicVideoSingleArtwork(projectId, body)),
    adjust: (optionId, note) => artworkAction('adjust', () => adjustMusicVideoSingleArtwork(projectId, optionId, note)),
    compose: (body) => artworkAction('compose', () => composeMusicVideoSingleArtwork(projectId, body)),
    approve: (optionId) => artworkAction('approve', () => approveMusicVideoSingleArtwork(projectId, optionId)),
    unapprove: () => artworkAction('approve', () => unapproveMusicVideoSingleArtwork(projectId)),
  };

  return {
    singleArtwork,
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
