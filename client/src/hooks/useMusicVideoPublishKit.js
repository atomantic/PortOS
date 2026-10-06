import { useEffect, useRef, useState } from 'react';
import toast from '../components/ui/Toast';
import socket from '../services/socket';
import {
  getMusicVideoProject,
  buildMusicVideoPublishKit,
  musicVideoPublishKitEventsUrl,
  cancelMusicVideoPublishKit,
  draftMusicVideoPublishCopy,
  updateMusicVideoPublishCopy,
  selectMusicVideoPublishThumbnail,
  composeMusicVideoCoverArt,
  generateMusicVideoCoverArt,
  designMusicVideoCoverArt,
  saveMusicVideoCoverDesign,
} from '../services/apiMusicVideo.js';
import useSseJobSlot from './useSseJobSlot.js';

const readPercent = (frame) => (Number.isFinite(frame.progress) ? frame.progress * 100 : undefined);

/**
 * Music Video publishing kit (#9281): the build is a `useSseJobSlot` job whose
 * terminal frame reloads the project it was started for (the kit lives on the
 * server record); the copy draft, copy edits, thumbnail choice and cover art
 * each return the whole project and apply it with `replaceProject`. A cover
 * image made by a backend lands later, over `music-video:cover-art`.
 */
export default function useMusicVideoPublishKit({ project, replaceProject } = {}) {
  const projectId = project?.id || null;
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [composing, setComposing] = useState(false);
  const [designing, setDesigning] = useState(false);
  const [savingLettering, setSavingLettering] = useState(false);
  const [requestingImage, setRequestingImage] = useState(false);

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

  useEffect(() => {
    if (!projectId) return undefined;
    const onCover = (e) => { if (e?.projectId === projectId && e.project) replaceProject(e.project); };
    socket.on('music-video:cover-art', onCover);
    return () => { socket.off('music-video:cover-art', onCover); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

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
  const composeCover = (body) => {
    setComposing(true);
    return composeMusicVideoCoverArt(projectId, body)
      .then(apply)
      .catch(() => null)
      .finally(() => setComposing(false));
  };
  const designCover = (body) => {
    setDesigning(true);
    return designMusicVideoCoverArt(projectId, body)
      .then(apply)
      .catch(() => null)
      .finally(() => setDesigning(false));
  };
  // The Lettering controls: the song's design set directly (no AI call), the cover re-set in it.
  const saveCoverDesign = (design) => {
    setSavingLettering(true);
    return saveMusicVideoCoverDesign(projectId, design)
      .then(apply)
      .catch(() => null)
      .finally(() => setSavingLettering(false));
  };
  // In flight from the click until the request is queued (a song with no design
  // drafts one first); after that the record's `pending` reports progress.
  const generateCover = (body) => {
    setRequestingImage(true);
    return generateMusicVideoCoverArt(projectId, body)
      .then(apply)
      .catch(() => null)
      .finally(() => setRequestingImage(false));
  };

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
    composing,
    composeCover,
    designing,
    designCover,
    savingLettering,
    saveCoverDesign,
    requestingImage,
    generateCover,
  };
}
