/**
 * Per-scene generation lanes (reference frame and clip) for Music Video over the scene render
 * lifecycle, with prompt builders and visual-spec reference conditioning.
 */

import { sceneRenderTierPlan } from '../../../server/lib/musicVideo/musicVideoRenderTier.js';
import { shotActionContractProblem } from '../../../server/lib/musicVideo/musicVideoActionContract.js';
import { isOutsideMusicVideoReference, musicVideoConditioningReferences, musicVideoLinkedCastIds } from '../../../server/lib/musicVideo/musicVideoConditioning.js';
import { authoredShotPrompt, musicVideoFrameModelInput, visualDirection } from '../../../server/lib/musicVideo/musicVideoShotPrompt.js';
import { useEffect, useRef, useState } from 'react';
import socket from '../services/socket';
import toast from '../components/ui/Toast';
import { addMusicVideoSceneTake, getMusicVideoSceneJobs, renderMusicVideoSceneClip, renderMusicVideoSceneFrame } from '../services/apiMusicVideo.js';
import { listCatalogIngredientsMedia } from '../services/apiCatalog.js';
import { generateVideo } from '../services/apiImageVideo.js';
import useMusicVideoGreyboxPlaces from './useMusicVideoGreyboxPlaces.js';
import useSceneBatch from './useSceneBatch.js';
import useSceneRenderLifecycle from './useSceneRenderLifecycle.js';
import { useVisibilityEvent } from './useVisibilityEvent.js';
import { isLtx2FamilyRuntime } from '../lib/runnerFamilies';
import { isLayeredComposition, isSelfDrawnLayer, sceneVisualLayer } from '../lib/musicVideoLayers.js';
import { buildSceneClipRequest } from '../lib/musicVideoSceneClipRequest.js';
import { isPerformanceScene, performanceBlockedReason } from '../lib/musicVideoShotTiming.js';

// Refusals the image route returns when the resolved backend can't consume
// reference images — surfaced as explicit capability feedback, never retried
// silently without the references.
const REFERENCE_CAPABILITY_CODES = new Set([
  'REFERENCE_IMAGES_FLUX2_ONLY',
  'IMAGE_EDIT_UNSUPPORTED_MODE',
  'TOO_MANY_REFERENCE_IMAGES',
  'TOO_MANY_INPUT_IMAGES',
]);

/** The project-wide palette and camera rules, shared with the server's composers. */
export { visualDirection };

/** Shared scene-aware frame conditioning. */
export const conditioningReferences = musicVideoConditioningReferences;
/** A mood board / Pinterest reference: look text only, never a conditioning image. */
export const isOutsideReference = isOutsideMusicVideoReference;

/**
 * Per-scene media generation for a music-video project: the reference-frame
 * (image) lane and the scene-clip (i2v / a2v / native-extend) lane.
 *
 * Each lane is a `useSceneRenderLifecycle` (#1798) that owns its spinner state,
 * job-id correlation, orphan-terminal reconcile, and socket subscription — the
 * client-side analog of the server's #1791 image/video hook unification. The
 * finished still attaches durably via `music-video:scene-image`, the finished
 * clip via `music-video:scene-video`; both ride the media-job queue, so the
 * spinner is cleared by the job-id-correlated `*-gen:completed/failed/canceled`
 * events.
 *
 * `videoSettings` is the `useMusicVideoModelSettings` result (the saved renderer
 * pin the job payload is built from). `applyScenePatch(projectId, sceneId,
 * patch)` merges ONLY the given scene fields via a functional update, so a
 * render that resolves after the user edited the board can't clobber those
 * edits with a stale project snapshot.
 *
 * Finished renders land as scene TAKES (#8965): the durable attach events carry
 * the scene's current selection plus its full take list, and a new take only
 * fills an unselected slot — so a late render never replaces the frame or clip
 * the director chose.
 */
const CAST_RELOAD_MIN_MS = 30_000;

export default function useMusicVideoSceneMedia({ project, videoSettings, applyScenePatch, onReconciled } = {}) {
  const frameBatch = useSceneBatch();
  const videoBatch = useSceneBatch();
  // Latest scenes for the failure toasts' scene names, read lazily (a lane
  // callback fires long after the render that created it).
  const projectRef = useRef(project);
  projectRef.current = project;
  const sceneLabel = (sceneId) => {
    const scene = projectRef.current?.scenes?.find((s) => s.sceneId === sceneId);
    return scene ? (scene.sectionLabel || scene.label || `Scene ${(scene.order ?? 0) + 1}`) : '';
  };
  const frameLane = useSceneRenderLifecycle({
    attachEvent: 'music-video:scene-image',
    completedEvent: 'image-gen:completed',
    failedEvent: 'image-gen:failed',
    canceledEvent: 'image-gen:canceled',
    startedEvent: 'image-gen:started',
    progressEvent: 'image-gen:progress',
    onSettled: frameBatch.settled,
    // The same event lands start and end frames (#11173), so it folds in both slots.
    apply: ({ projectId, sceneId, referenceImageId, endImageId, takes, lastFailure }) =>
      applyScenePatch?.(projectId, sceneId, { referenceImageId, ...(endImageId !== undefined ? { endImageId } : {}), ...(Array.isArray(takes) ? { takes } : {}), ...(lastFailure !== undefined ? { lastFailure } : {}) }),
    failMessage: 'Frame render failed',
    sceneLabel,
  });
  // Style-break end frames (#11173): their own spinners, so a scene can render
  // its start and end frame at once. The frame lane above applies the landed
  // still (both ride music-video:scene-image), so this lane only tracks jobs.
  const endFrameLane = useSceneRenderLifecycle({
    attachEvent: 'music-video:scene-image',
    completedEvent: 'image-gen:completed',
    failedEvent: 'image-gen:failed',
    canceledEvent: 'image-gen:canceled',
    apply: () => {},
    failMessage: 'End frame render failed',
    sceneLabel,
  });
  const videoLane = useSceneRenderLifecycle({
    attachEvent: 'music-video:scene-video',
    completedEvent: 'video-gen:completed',
    failedEvent: 'video-gen:failed',
    canceledEvent: 'video-gen:canceled',
    startedEvent: 'video-gen:started',
    progressEvent: 'video-gen:progress',
    onSettled: videoBatch.settled,
    apply: ({ projectId, sceneId, videoHistoryId, takes, lastFailure }) =>
      applyScenePatch?.(projectId, sceneId, { videoHistoryId, ...(Array.isArray(takes) ? { takes } : {}), ...(lastFailure !== undefined ? { lastFailure } : {}) }),
    failMessage: 'Scene video render failed',
    sceneLabel,
  });

  const upscaleLane = useSceneRenderLifecycle({
    completedEvent: 'video-gen:completed',
    failedEvent: 'video-gen:failed',
    canceledEvent: 'video-gen:canceled',
    startedEvent: 'video-gen:started',
    progressEvent: 'video-gen:progress',
    failMessage: 'Shot upscale failed',
    sceneLabel,
  });

  // The server persists a failed scene render on the scene (#10154); fold it in
  // live so the card's "failed · Retry" chip appears without a refetch.
  const applyRef = useRef(applyScenePatch);
  applyRef.current = applyScenePatch;
  useEffect(() => {
    const onFailure = ({ projectId, sceneId, lastFailure }) => applyRef.current?.(projectId, sceneId, { lastFailure: lastFailure ?? null });
    socket.on('music-video:scene-failure', onFailure);
    return () => socket.off('music-video:scene-failure', onFailure);
  }, []);

  // After a reload the lanes' spinners (React state) are gone while the queue
  // keeps rendering — restore them from the server so the batch actions skip
  // those scenes and no duplicate (possibly paid) render is submitted (#10154).
  const projectId = project?.id;
  const { restoreJobs: restoreFrameJobs, reconcileJobs: reconcileFrameJobs } = frameLane;
  const { restoreJobs: restoreVideoJobs, reconcileJobs: reconcileVideoJobs } = videoLane;
  const { restoreJobs: restoreEndFrameJobs, reconcileJobs: reconcileEndFrameJobs } = endFrameLane;
  const { restoreJobs: restoreUpscaleJobs, reconcileJobs: reconcileUpscaleJobs } = upscaleLane;
  const onReconciledRef = useRef(onReconciled);
  onReconciledRef.current = onReconciled;
  useEffect(() => {
    if (!projectId) return undefined;
    let live = true;
    // Only the newest listing counts: an older response landing last would re-light a spinner for a job the newer one shows finished.
    let latest = 0;
    const load = (reconnected) => {
      latest += 1;
      const requestId = latest;
      return getMusicVideoSceneJobs(projectId, { silent: true })
        .then(async ({ jobs }) => {
          if (!live || !Array.isArray(jobs) || requestId !== latest) return;
          restoreFrameJobs(jobs.filter((j) => j.lane === 'image'));
          restoreVideoJobs(jobs.filter((j) => j.lane === 'video'));
          restoreUpscaleJobs(jobs.filter((j) => j.lane === 'upscale'));
          restoreEndFrameJobs(jobs.filter((j) => j.lane === 'endImage'));
          if (!reconnected) return;
          // Terminal events fired while the socket was down are never replayed: settle the
          // tracked jobs the server no longer lists, then reload so their finished takes land.
          const activeIds = jobs.map((j) => j.jobId);
          const counts = await Promise.all([reconcileFrameJobs, reconcileVideoJobs, reconcileEndFrameJobs, reconcileUpscaleJobs].map((reconcile) => reconcile(activeIds)));
          if (live && counts.some((n) => n > 0)) onReconciledRef.current?.(projectId);
        })
        .catch(() => {}); // best-effort: a failed lookup just means no restored spinners
    };
    load(false);
    const onConnect = () => load(true);
    socket.on('connect', onConnect);
    return () => {
      live = false;
      socket.off('connect', onConnect);
    };
  }, [projectId, restoreFrameJobs, restoreVideoJobs, restoreEndFrameJobs, reconcileFrameJobs, reconcileVideoJobs, reconcileEndFrameJobs, restoreUpscaleJobs, reconcileUpscaleJobs]);
  // The Casting media of every character linked from the catalog and every cast member
  // a shot names in its `characterVariant` (#12763), keyed by ingredient id: an array once loaded, null when the first load
  // failed, absent while pending. A shot's frames lead with that member's guides;
  // without an array the shot uses the automatic set. Casting has no change event,
  // so the board reloads them when its tab comes back into view.
  const castIds = [...new Set([...musicVideoLinkedCastIds(project), ...(project?.scenes || []).map((scene) => scene?.characterVariant?.ingredientId).filter(Boolean)])].sort().join(',');
  const [castMedia, setCastMedia] = useState({});
  const greyboxPlaces = useMusicVideoGreyboxPlaces(project);
  const [castRefresh, setCastRefresh] = useState(0);
  const castLoadedAt = useRef(0);
  // Returning to the tab refetches only when the last load is stale; a failed-member retry forces one (reloadCastMedia).
  useVisibilityEvent((state) => { if (state === 'visible' && Date.now() - castLoadedAt.current > CAST_RELOAD_MIN_MS) setCastRefresh((n) => n + 1); });
  useEffect(() => {
    if (!castIds) return undefined;
    let active = true;
    const ids = castIds.split(',');
    // One batched read for every cast member (#16076); a failed read marks only never-loaded members failed (null).
    listCatalogIngredientsMedia(ids, { silent: true })
      .catch(() => ({}))
      .then((byId) => {
        if (!active) return;
        castLoadedAt.current = Date.now();
        setCastMedia((prev) => Object.fromEntries(ids.map((id) => [id, (Array.isArray(byId?.[id]) ? byId[id] : null) ?? prev[id] ?? null])));
      });
    return () => { active = false; };
  }, [castIds, castRefresh]);
  // Failed members return to "loading" while the retry is in flight, so a render waits instead of being told the read failed.
  const reloadCastMedia = () => {
    setCastMedia((prev) => Object.fromEntries(Object.entries(prev).map(([id, media]) => [id, media === null ? undefined : media])));
    castLoadedAt.current = 0;
    setCastRefresh((n) => n + 1);
  };

  const genScenes = frameLane.genScenes;
  const genVideoScenes = videoLane.genScenes;
  const failedScenes = { frame: frameLane.failedScenes, video: videoLane.failedScenes };

  const conditioning = conditioningReferences(project);

  /**
   * Render a still reference frame for one scene from its frame prompt. The
   * async local/Codex lanes ride the media-job queue and are attached durably
   * server-side (musicVideoSceneImageHook → music-video:scene-image); we record
   * the job id and let the terminal image-gen:completed/failed event clear the
   * spinner (so a failed render doesn't strand the button). The synchronous
   * external SD-API lane returns a finished filename inline — add it as a take.
   *
   * The server loads cast media and the shot's references (POST .../frame).
   * A backend that can't consume them refuses the render, and the toast names
   * that capability gap instead of quietly rendering without the references.
   *
   * Returns a promise that always RESOLVES (never rejects) to `{ ok }` — `ok`
   * is false when the kickoff request itself failed (refused, network error),
   * true once it reaches the queue or finishes synchronously. The revision
   * hook (#9011) passes `revisionId` and awaits this to release a claimed
   * section whose kickoff never made it to the queue, and to count only
   * confirmed submissions rather than every call it fired. A queued job also
   * returns its `jobId`, and `onJob(jobId)` is told of it before the lane starts
   * tracking it (a batch registers the job there, so a terminal event that raced
   * ahead of the kickoff is still attributed to it).
   *
   * `refine` (with `referenceImageId`) edits that frame by a short instruction
   * instead: the prompt is the instruction, and the frame leads the shot's references.
   * `imageTarget` names this render's image service. Omit it and the project pin applies.
   */
  // Start and end stills share the queue, inline-take, and capability-error path.
  // `spec` is the only difference: take kind, selection field, and toast copy.
  const FRAME_SLOT = {
    start: {
      kind: 'image',
      failMessage: 'Frame generation failed',
      capabilitySuffix: "Switch the image backend, or take references off the shot's References row.",
      attachFail: 'Failed to attach frame',
      selectionOf: (scene) => scene.referenceImageId || null,
      patchOf: (updated) => ({ referenceImageId: updated.referenceImageId, takes: updated.takes }),
    },
    end: {
      kind: 'endImage',
      failMessage: 'End frame generation failed',
      capabilitySuffix: 'Switch the image backend to one that takes a reference image.',
      attachFail: 'Failed to attach end frame',
      selectionOf: (scene) => scene.endImageId || null,
      patchOf: (updated) => ({ endImageId: updated.endImageId ?? null, takes: updated.takes }),
    },
  };

  const submitSceneFrame = (scene, slot, {
    revisionId, onJob, referenceImageId = null, refine = null, includeReferences = true,
    replaceSelection = false, thenClip = null, imageTarget = null, lane,
  } = {}) => {
    const spec = FRAME_SLOT[slot];
    const refining = Boolean(refine?.trim() && referenceImageId);
    const projectId = project.id;
    const renderKey = lane.startScene(scene.sceneId);
    return renderMusicVideoSceneFrame(projectId, scene.sceneId, {
      slot,
      ...(imageTarget?.mode ? { imageTarget } : {}),
      ...(refining ? { refine, referenceImageId, ...(includeReferences ? {} : { includeReferences: false }) } : referenceImageId ? { fromFrame: true, referenceImageId } : {}),
      ...(revisionId ? { revisionId } : {}),
      ...(replaceSelection ? { select: true } : {}),
      ...(thenClip ? { thenClip } : {}),
    }, { silent: true })
      .then((res) => {
        const stillRunning = res?.status === 'queued' || res?.status === 'running';
        if (stillRunning) {
          // async lane: correlate the job so its terminal event clears the spinner.
          // trackJob reconciles a terminal event that raced ahead of this .then.
          const jobId = res?.jobId || res?.generationId;
          if (!jobId) { lane.clearScene(scene.sceneId, renderKey); return { ok: false }; }
          onJob?.(jobId);
          lane.trackJob(jobId, scene.sceneId, renderKey);
          return { ok: true, jobId };
        }
        const filename = res?.filename;
        if (filename) {
          const castInputs = res.castInputs;
          addMusicVideoSceneTake(projectId, scene.sceneId, {
            kind: spec.kind, assetId: filename, source: 'generated', ...(castInputs ? { castInputs } : {}),
            ...(replaceSelection ? { replaceSelection: true, expectedSelection: spec.selectionOf(scene) } : {}),
          }, { silent: true })
            .then(({ scene: updated }) => applyScenePatch?.(projectId, scene.sceneId, spec.patchOf(updated)))
            .catch((err) => toast.error(err?.message || spec.attachFail));
          // Only queued renders chain into a clip; this lane answered inline.
          if (thenClip) toast.info('Still ready. Render its clip from the shot card.');
        }
        lane.clearScene(scene.sceneId, renderKey);
        return { ok: true };
      })
      .catch((err) => {
        toast.error(REFERENCE_CAPABILITY_CODES.has(err?.code)
          ? `${err.message} ${spec.capabilitySuffix}`
          : err?.message || spec.failMessage);
        lane.clearScene(scene.sceneId, renderKey);
        return { ok: false };
      });
  };

  const generateFrame = (scene, options = {}) => {
    const { referenceImageId = null, refine = null } = options;
    const refining = Boolean(refine?.trim() && referenceImageId);
    const problem = refining ? null : shotActionContractProblem(scene.direction?.actionContract, scene);
    if (problem) { toast.error(problem); return Promise.resolve({ ok: false }); }
    // A planned shot with no text still renders from its look, frame clause and actions.
    if (!refining && !musicVideoFrameModelInput(project, scene).prompt) { toast.error('Add a frame prompt or shot prompt first'); return Promise.resolve({ ok: false }); }
    return submitSceneFrame(scene, 'start', { ...options, lane: frameLane });
  };

  /**
   * Render a style-break end frame (#11173): the scene's end-frame prompt
   * (e.g. "the same frame as a pencil-sketch rotoscope") conditioned on its
   * selected start frame, so the composition carries over and only the look
   * changes. It lands as an `endImage` take (musicVideoSceneImageHook files the
   * `slot: 'end'` tag); a fal clip on a model that takes an end frame then ends
   * on it. Resolves `{ ok }` like generateFrame.
   */
  const generateEndFrame = (scene, { referenceImageId = scene.referenceImageId, refine = null, ...rest } = {}) => {
    const refining = Boolean(refine?.trim() && referenceImageId);
    if (!scene.endFramePrompt?.trim() && !refining) { toast.error('Describe the end frame first'); return Promise.resolve({ ok: false }); }
    return submitSceneFrame(scene, 'end', { ...rest, referenceImageId, refine, lane: endFrameLane });
  };

  // Correlate a kicked-off video job with its scene, or clear the spinner when
  // the response carried no id to track. trackJob reconciles a terminal event
  // that raced ahead of this .then. Resolves `{ ok }` — see generateFrame's
  // doc comment for why the caller never sees a rejection.
  // `key` is the render startScene lit, so a shot rendering on two providers settles each on its own.
  const trackVideoJob = (res, sceneId, key, onJob) => {
    const jobId = res?.jobId || res?.generationId;
    if (!jobId) { videoLane.clearScene(sceneId, key); return { ok: false }; }
    onJob?.(jobId);
    videoLane.trackJob(jobId, sceneId, key);
    return { ok: true, jobId };
  };

  const handleVideoError = (err, sceneId, key, fallbackMessage) => {
    toast.error(err?.message || fallbackMessage);
    videoLane.clearScene(sceneId, key);
    return { ok: false };
  };

  /**
   * Generate this scene's video from its chosen reference frame via the video
   * route's image (i2v) mode. The render always rides the media-job queue, so we
   * correlate the returned job id and let the terminal video-gen:completed/failed
   * event clear the spinner; the finished clip's history id lands durably via
   * music-video:scene-video (musicVideoSceneVideoHook). generateVideo() throws on
   * a non-OK response, so the catch owns the only error toast (no double-toast).
   *
   * Returns a promise that always resolves to `{ ok }` — see generateFrame's
   * doc comment. `revisionId` (optional) is the revision hook's kickoff tag (#9011).
   */
  const generateSceneVideo = (scene, { revisionId, onJob, target = null, card = null, tier = null } = {}) => {
    // `card` is the shot card's Render text and toggles. `target` renders this
    // shot elsewhere without changing the saved pin. `tier` is draft or final.
    const built = buildSceneClipRequest({ scene, project, card, target, tier, revisionId, videoSettings, castMedia });
    if (built.error) { toast.error(built.error); return Promise.resolve({ ok: false }); }
    const renderKey = videoLane.startScene(scene.sceneId, { label: built.label });
    return renderMusicVideoSceneClip(project.id, scene.sceneId, built.body, { silent: true })
      .then((res) => trackVideoJob(res, scene.sceneId, renderKey, onJob))
      .catch((err) => handleVideoError(err, scene.sceneId, renderKey, 'Scene video generation failed'));
  };

  /**
   * Selective native continuation for ltx2 models. It replaces only this
   * scene's attached clip when the continuation finishes, preserving the
   * reference frame and authored timeline span. Passing sourceImageFile keeps
   * the music-video route's fail-closed reference-frame contract intact while
   * extendFromVideoId supplies the actual native continuation source.
   */
  const continueSceneVideo = (scene) => {
    if (!scene.videoHistoryId || !scene.referenceImageId) return;
    const { settings, activeModel, effectiveModelId, videoBlockedReason } = videoSettings;
    if (settings.backend !== 'local' || !isLtx2FamilyRuntime(activeModel?.runtime)) {
      toast.error('Choose an LTX local model with native continuation support');
      return;
    }
    if (videoBlockedReason) { toast.error(videoBlockedReason); return; }
    const renderKey = videoLane.startScene(scene.sceneId, { label: 'local' });
    generateVideo({
      prompt: authoredShotPrompt(scene),
      backend: 'local',
      modelId: effectiveModelId || undefined,
      disableAudio: true,
      mode: 'extend',
      extendFromVideoId: scene.videoHistoryId,
      sourceImageFile: scene.referenceImageId,
      musicVideo: JSON.stringify({ projectId: project.id, sceneId: scene.sceneId, compose: true, catalogBasis: project.castAndSets?.catalogCheckin?.basis }),
    })
      .then((res) => trackVideoJob(res, scene.sceneId, renderKey))
      .catch((err) => handleVideoError(err, scene.sceneId, renderKey, 'Shot continuation failed'));
  };

  const scenes = project?.scenes || [];
  // #8985: a composed render's title cards need no frame, and its stills need
  // no clip — the batch generators skip them.
  const layered = isLayeredComposition(project);
  const frameScenes = scenes.filter((scene) => !isSelfDrawnLayer(sceneVisualLayer(scene, { layered })));
  const footageScenes = scenes.filter((scene) => sceneVisualLayer(scene, { layered }) === 'footage');
  const planMissingFrames = () => frameScenes.filter((scene) =>
    !scene.referenceImageId && !genScenes[scene.sceneId] && musicVideoFrameModelInput(project, scene).prompt);

  // The clips a Videos batch would submit: a footage scene with a frame, no clip
  // and nothing in flight. A scene still waiting for its frame never blocks the
  // others (#10153). Performance shots the current lane cannot lip-sync are
  // dropped here and reported once (#8977).
  const planMissingVideos = () => {
    const candidates = footageScenes.filter((scene) =>
      scene.referenceImageId && !scene.videoHistoryId && !genVideoScenes[scene.sceneId] && authoredShotPrompt(scene));
    const { settings, audioReactiveSelected } = videoSettings;
    const lipSyncBlocked = performanceBlockedReason(audioReactiveSelected ? 'local' : settings.backend);
    const pending = lipSyncBlocked ? candidates.filter((scene) => !isPerformanceScene(scene)) : candidates;
    return { pending, skipped: candidates.length - pending.length, lipSyncBlocked };
  };

  // Fire every scene at once, counting the batch so the board can show
  // "N of M done", and cancel what is left on request (useSceneBatch).
  const runBatch = (batch, pending, generate) => {
    batch.begin(pending.length);
    pending.forEach((scene) => generate(scene, { onJob: batch.register }).then((res) => {
      if (!res.ok) batch.kickoffFailed();
      else if (!res.jobId) batch.completedWithoutJob();
    }));
  };

  const generateMissingFrames = () => {
    const pending = planMissingFrames();
    if (pending.length === 0) {
      toast.info('Every scene already has a reference frame');
      return;
    }
    runBatch(frameBatch, pending, generateFrame);
  };

  const generateMissingVideos = () => {
    const { pending, skipped, lipSyncBlocked } = planMissingVideos();
    if (skipped > 0) toast.info(`Skipped ${skipped} performance shot${skipped === 1 ? '' : 's'}: ${lipSyncBlocked}`);
    if (pending.length === 0) {
      if (skipped > 0) return;
      toast.info(footageScenes.some((scene) => !scene.referenceImageId && !scene.videoHistoryId)
        ? 'Generate a reference frame first — no waiting scene has one yet'
        : 'Every scene already has a video');
      return;
    }
    // #16136: a batch renders drafts on a model with resolution tiers; an untiered lane renders as before.
    const draftTier = (scene) => (sceneRenderTierPlan(videoSettings.settings.backend, { scene, scenes: project?.scenes, videoSettings: videoSettings.settings }) ? { tier: 'draft' } : {});
    runBatch(videoBatch, pending, (scene, options) => generateSceneVideo(scene, { ...options, ...draftTier(scene) }));
  };

  return {
    genScenes,
    genVideoScenes,
    failedScenes,
    genEndFrameScenes: endFrameLane.genScenes,
    sceneProgress: frameLane.sceneProgress,
    videoSceneProgress: videoLane.sceneProgress,
    videoSceneJobs: videoLane.sceneJobs,
    upscaleSceneJobs: upscaleLane.sceneJobs,
    trackShotUpscale: upscaleLane.trackJob,
    frameBatch,
    videoBatch,
    conditioning,
    castMedia,
    reloadCastMedia,
    greyboxPlaces,
    generateFrame,
    generateEndFrame,
    generateSceneVideo,
    continueSceneVideo,
    planMissingFrames,
    planMissingVideos,
    generateMissingFrames,
    generateMissingVideos,
  };
}
