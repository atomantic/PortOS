import { useEffect, useRef, useState } from 'react';
import toast from '../components/ui/Toast';
import socket from '../services/socket';
import {
  getMusicVideoProject,
  buildMusicVideoDcp, musicVideoDcpEventsUrl, cancelMusicVideoDcp,
  buildMusicVideoPublishKit,
  musicVideoPublishKitEventsUrl,
  cancelMusicVideoPublishKit,
  draftMusicVideoPublishCopy,
  updateMusicVideoPublishCopy,
  composeMusicVideoYoutubeThumbnail,
  clearMusicVideoYoutubeThumbnail,
  addMusicVideoThumbnailTest,
  paintMusicVideoYoutubeThumbnail,
  removeMusicVideoThumbnailTest,
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
  const [composingThumbnail, setComposingThumbnail] = useState(false);
  const [paintingThumbnail, setPaintingThumbnail] = useState(false);

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

  const dcpJob = useSseJobSlot({
    startRequest: input => buildMusicVideoDcp(projectId, input, { silent: true }),
    eventsUrl: musicVideoDcpEventsUrl,
    cancelRequest: cancelMusicVideoDcp,
    onComplete: (_frame, id) => reload(id),
    onKickoffError: err => {
      if (err?.code === 'DCP_IN_PROGRESS' && err.context?.jobId) { dcpJob.attach(err.context.jobId, projectId); return true; }
      return false;
    },
    errorFallback: 'Cinema package export failed',
    canceledMessage: 'Cinema package export cancelled',
    lostConnectionMessage: 'Lost connection to the cinema package export',
  });
  const attachedDcp = useRef(new Set());
  const activeDcpId = project?.activeDcpBuild?.jobId || null;
  useEffect(() => {
    if (!activeDcpId || !projectId || attachedDcp.current.has(activeDcpId)) return;
    if (dcpJob.attach(activeDcpId, projectId)) attachedDcp.current.add(activeDcpId);
  }, [activeDcpId, projectId]);

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
    // Dependency list is intentionally partial.
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
  const composeThumbnail = (body) => {
    setComposingThumbnail(true);
    return composeMusicVideoYoutubeThumbnail(projectId, body)
      .then(apply)
      .catch(() => null)
      .finally(() => setComposingThumbnail(false));
  };
  // In flight from the click until the job is queued; after that the record's `pending` reports progress.
  const paintThumbnail = (body) => {
    setPaintingThumbnail(true);
    return paintMusicVideoYoutubeThumbnail(projectId, body)
      .then(apply)
      .catch(() => null)
      .finally(() => setPaintingThumbnail(false));
  };
  const addThumbnailTest = () => addMusicVideoThumbnailTest(projectId).then(apply).catch(() => null);
  const removeThumbnailTest = (filename) => removeMusicVideoThumbnailTest(projectId, filename).then(apply).catch(() => null);
  const clearThumbnail = () => {
    setComposingThumbnail(true);
    return clearMusicVideoYoutubeThumbnail(projectId)
      .then(apply)
      .catch(() => null)
      .finally(() => setComposingThumbnail(false));
  };
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
    dcp: { active: dcpJob.active, stage: dcpJob.stage, build: input => dcpJob.start(input, projectId), cancel: dcpJob.cancel },
    building: job.active,
    progress: job.active ? job.percent : 0,
    build: () => job.start({}, projectId),
    cancelBuild: job.cancel,
    drafting,
    saving,
    draftCopy,
    saveCopy,
    composingThumbnail,
    composeThumbnail,
    clearThumbnail,
    addThumbnailTest,
    paintingThumbnail,
    paintThumbnail,
    removeThumbnailTest,
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
