import { shotActionContractProblem } from '../../../server/lib/musicVideoActionContract.js';
import { isOutsideMusicVideoReference, musicVideoClipConditioningReferences, musicVideoConditioningReferences, musicVideoLinkedCastIds, musicVideoSceneCastIds } from '../../../server/lib/musicVideoConditioning.js';
import { preMusicClipSound } from '../../../server/lib/musicVideoColdOpen.js';
import { sceneEndFrameRequestFields } from '../../../server/lib/musicVideoEndFrame.js';
import { authoredShotPrompt, musicVideoFrameModelInput, visualDirection } from '../../../server/lib/musicVideoShotPrompt.js';
import { useEffect, useRef, useState } from 'react';
import socket from '../services/socket';
import toast from '../components/ui/Toast';
import { addMusicVideoSceneTake, getMusicVideoSceneJobs, renderMusicVideoSceneClip, renderMusicVideoSceneFrame } from '../services/apiMusicVideo.js';
import { listCatalogIngredientMedia } from '../services/apiCatalog.js';
import { generateVideo } from '../services/apiImageVideo.js';
import useMusicVideoGreyboxPlaces from './useMusicVideoGreyboxPlaces.js';
import useSceneBatch from './useSceneBatch.js';
import useSceneRenderLifecycle from './useSceneRenderLifecycle.js';
import { useVisibilityEvent } from './useVisibilityEvent.js';
import { isLtx2FamilyRuntime } from '../lib/runnerFamilies';
import { ltxReferenceFrames as ltxReferenceFramesFor } from '../../../server/lib/musicVideoShotTiming.js';
import { sourceClipNeedSec } from '../../../server/lib/musicVideoSourceTake.js';
import { LTX_REFERENCES_GENERATION_MODE, LTX_REFERENCES_IC_MODE, LTX_REFERENCES_MAX_REFERENCES, isLtx25Model } from '../lib/musicVideoLtxReferences.js';
import { isLayeredComposition, isSelfDrawnLayer, sceneVisualLayer } from '../lib/musicVideoLayers.js';
import {
  falSceneTake, falTakeRequestFields, grokSceneRequestDuration, isPerformanceScene, performanceBlockedReason, runwaySceneTake, runwayTakeRequestFields, sceneRenderShot,
} from '../lib/musicVideoShotTiming.js';

// Refusals the image route returns when the resolved backend can't consume
// reference images — surfaced as explicit capability feedback, never retried
// silently without the references.
const REFERENCE_CAPABILITY_CODES = new Set([
  'REFERENCE_IMAGES_FLUX2_ONLY',
  'IMAGE_EDIT_UNSUPPORTED_MODE',
  'TOO_MANY_REFERENCE_IMAGES',
  'TOO_MANY_INPUT_IMAGES',
]);

// A project-default reference render has no per-card length override.
const ltxReferenceFrames = (scene, target) => ltxReferenceFramesFor(scene, target?.numFrames);

// The provider a clip render runs on, as its placeholder take names it ("Rendering grok…").
// A pool that may pick either this machine or a peer names neither.
function videoRenderLabel(settings) {
  if (settings?.renderPool?.mode === 'peers') return 'peer';
  if (settings?.renderPool?.mode === 'both') return null;
  return settings?.backend || 'local';
}

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
          restoreEndFrameJobs(jobs.filter((j) => j.lane === 'endImage'));
          if (!reconnected) return;
          // Terminal events fired while the socket was down are never replayed: settle the
          // tracked jobs the server no longer lists, then reload so their finished takes land.
          const activeIds = jobs.map((j) => j.jobId);
          const counts = await Promise.all([reconcileFrameJobs, reconcileVideoJobs, reconcileEndFrameJobs].map((reconcile) => reconcile(activeIds)));
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
  }, [projectId, restoreFrameJobs, restoreVideoJobs, restoreEndFrameJobs, reconcileFrameJobs, reconcileVideoJobs, reconcileEndFrameJobs]);
  // The Casting media of every character linked from the catalog and every cast member
  // a shot names in its `characterVariant` (#12763), keyed by ingredient id: an array once loaded, null when the first load
  // failed, absent while pending. A shot's frames lead with that member's guides;
  // without an array the shot uses the automatic set. Casting has no change event,
  // so the board reloads them when its tab comes back into view.
  const castIds = [...new Set([...musicVideoLinkedCastIds(project), ...(project?.scenes || []).map((scene) => scene?.characterVariant?.ingredientId).filter(Boolean)])].sort().join(',');
  const [castMedia, setCastMedia] = useState({});
  const greyboxPlaces = useMusicVideoGreyboxPlaces(project);
  const [castRefresh, setCastRefresh] = useState(0);
  useVisibilityEvent((state) => { if (state === 'visible') setCastRefresh((n) => n + 1); });
  useEffect(() => {
    if (!castIds) return undefined;
    let active = true;
    Promise.all(castIds.split(',').map((id) => listCatalogIngredientMedia(id, { silent: true })
      .then((media) => [id, Array.isArray(media) ? media : null], () => [id, null])))
      // A failed reload keeps the media already loaded; only a never-loaded member is marked failed (null).
      .then((entries) => { if (active) setCastMedia((prev) => Object.fromEntries(entries.map(([id, media]) => [id, media ?? prev[id] ?? null]))); });
    return () => { active = false; };
  }, [castIds, castRefresh]);
  // Failed members return to "loading" while the retry is in flight, so a render waits instead of being told the read failed.
  const reloadCastMedia = () => {
    setCastMedia((prev) => Object.fromEntries(Object.entries(prev).map(([id, media]) => [id, media === null ? undefined : media])));
    setCastRefresh((n) => n + 1);
  };
  // A render before the shot's cast guides load, or after a failed read (null), would silently go out without them.
  const castGuidesPending = (scene) => {
    const ids = musicVideoSceneCastIds(project, scene);
    const failed = ids.find((id) => castMedia[id] === null);
    if (failed) {
      const name = (project?.concept?.subjects || []).find((s) => s?.ingredientId === failed)?.name || failed;
      toast.error(`Cast guides could not be loaded for ${name}. Retry before rendering.`);
      return true;
    }
    if (ids.every((id) => castMedia[id] !== undefined)) return false;
    toast.error('Cast guides are still loading. Try again in a moment.');
    return true;
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
  const generateFrame = (scene, { revisionId, onJob, referenceImageId = null, refine = null, replaceSelection = false, thenClip = null, imageTarget = null } = {}) => {
    const refining = Boolean(refine?.trim() && referenceImageId);
    const problem = refining ? null : shotActionContractProblem(scene.direction?.actionContract, scene);
    if (problem) { toast.error(problem); return Promise.resolve({ ok: false }); }
    // A planned shot with no text still renders from its look, frame clause and actions.
    if (!refining && !musicVideoFrameModelInput(project, scene).prompt) { toast.error('Add a frame prompt or shot prompt first'); return Promise.resolve({ ok: false }); }
    const projectId = project.id;
    const renderKey = frameLane.startScene(scene.sceneId);
    return renderMusicVideoSceneFrame(projectId, scene.sceneId, {
      slot: 'start',
      ...(imageTarget?.mode ? { imageTarget } : {}),
      ...(refining ? { refine: refine.trim(), referenceImageId } : referenceImageId ? { fromFrame: true, referenceImageId } : {}),
      ...(revisionId ? { revisionId } : {}),
      ...(replaceSelection ? { select: true } : {}),
      ...(thenClip ? { thenClip } : {}),
    }, { silent: true })
      .then((res) => {
        const stillRunning = res?.status === 'queued' || res?.status === 'running';
        if (stillRunning) {
          // async lane: correlate the job so its terminal event clears the spinner
          // (and the durable scene-image event lands the generated frame). trackJob
          // reconciles a terminal event that raced ahead of this .then (fast fail).
          const jobId = res?.jobId || res?.generationId;
          if (!jobId) { frameLane.clearScene(scene.sceneId, renderKey); return { ok: false }; } // no id to track → don't strand the button
          onJob?.(jobId);
          frameLane.trackJob(jobId, scene.sceneId, renderKey);
          return { ok: true, jobId };
        }
        const filename = res?.filename;
        if (filename) {
          const castInputs = res.castInputs;
          addMusicVideoSceneTake(projectId, scene.sceneId, {
            kind: 'image', assetId: filename, source: 'generated', ...(castInputs ? { castInputs } : {}), ...(replaceSelection ? { replaceSelection: true, expectedSelection: scene.referenceImageId || null } : {}),
          }, { silent: true })
            .then(({ scene: updated }) => applyScenePatch?.(projectId, scene.sceneId, {
              referenceImageId: updated.referenceImageId, takes: updated.takes,
            }))
            .catch((err) => toast.error(err?.message || 'Failed to attach frame'));
          // Only queued renders chain into a clip (musicVideoSceneImageHook); this lane answered inline.
          if (thenClip) toast.info('Still ready. Render its clip from the shot card.');
        }
        frameLane.clearScene(scene.sceneId, renderKey);
        return { ok: true };
      })
      .catch((err) => {
        toast.error(REFERENCE_CAPABILITY_CODES.has(err?.code)
          ? `${err.message} Switch the image backend, or take references off the shot's References row.`
          : err?.message || 'Frame generation failed');
        frameLane.clearScene(scene.sceneId, renderKey);
        return { ok: false };
      });
  };

  /**
   * Render a style-break end frame (#11173): the scene's end-frame prompt
   * (e.g. "the same frame as a pencil-sketch rotoscope") conditioned on its
   * selected start frame, so the composition carries over and only the look
   * changes. It lands as an `endImage` take (musicVideoSceneImageHook files the
   * `slot: 'end'` tag); a fal clip on a model that takes an end frame then ends
   * on it. Resolves `{ ok }` like generateFrame.
   */
  const generateEndFrame = (scene, { referenceImageId = scene.referenceImageId, refine = null, replaceSelection = false, imageTarget = null } = {}) => {
    const refining = Boolean(refine?.trim() && referenceImageId);
    const endPrompt = scene.endFramePrompt?.trim();
    if (!endPrompt && !refining) { toast.error('Describe the end frame first'); return Promise.resolve({ ok: false }); }
    const projectId = project.id;
    const renderKey = endFrameLane.startScene(scene.sceneId);
    return renderMusicVideoSceneFrame(projectId, scene.sceneId, {
      slot: 'end',
      ...(imageTarget?.mode ? { imageTarget } : {}),
      ...(refining ? { refine: refine.trim(), referenceImageId } : referenceImageId ? { fromFrame: true, referenceImageId } : {}),
      ...(replaceSelection ? { select: true } : {}),
    }, { silent: true })
      .then((res) => {
        if (res?.status === 'queued' || res?.status === 'running') {
          const jobId = res?.jobId || res?.generationId;
          if (!jobId) { endFrameLane.clearScene(scene.sceneId, renderKey); return { ok: false }; }
          endFrameLane.trackJob(jobId, scene.sceneId, renderKey);
          return { ok: true, jobId };
        }
        if (res?.filename) {
          const castInputs = res.castInputs;
          addMusicVideoSceneTake(projectId, scene.sceneId, {
            kind: 'endImage', assetId: res.filename, source: 'generated', ...(castInputs ? { castInputs } : {}), ...(replaceSelection ? { replaceSelection: true, expectedSelection: scene.endImageId || null } : {}),
          }, { silent: true })
            .then(({ scene: updated }) => applyScenePatch?.(projectId, scene.sceneId, {
              endImageId: updated.endImageId ?? null, takes: updated.takes,
            }))
            .catch((err) => toast.error(err?.message || 'Failed to attach end frame'));
        }
        endFrameLane.clearScene(scene.sceneId, renderKey);
        return { ok: true };
      })
      .catch((err) => {
        toast.error(REFERENCE_CAPABILITY_CODES.has(err?.code)
          ? `${err.message} Switch the image backend to one that takes a reference image.`
          : err?.message || 'End frame generation failed');
        endFrameLane.clearScene(scene.sceneId, renderKey);
        return { ok: false };
      });
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
  const generateSceneVideo = (scene, { revisionId, onJob, target = null, card = null } = {}) => {
    if (!scene.referenceImageId) { toast.error('Generate a reference frame first'); return Promise.resolve({ ok: false }); }
    const problem = shotActionContractProblem(scene.direction?.actionContract, scene);
    if (problem) { toast.error(problem); return Promise.resolve({ ok: false }); }
    // `card` is the shot card's Render: the director's text and its input toggles
    // ({ prompt, endFrame, songAudio, wholeLine }), composed as the card shows it (SceneRenderInputs).
    // The server composes every addition from the director's text (musicVideoShotPrompt.js).
    const prompt = card ? card.prompt : authoredShotPrompt(scene);
    if (!prompt) { toast.error('Add a shot prompt first'); return Promise.resolve({ ok: false }); }
    // `target` renders this one shot elsewhere (a scene card's Render on pick) without changing the saved setting.
    const settings = target ? { ...videoSettings.settings, ...target } : videoSettings.settings;
    const { detectedAudioReactiveLora } = videoSettings;
    const audioReactiveSelected = target ? settings.backend === 'local' && settings.generationMode === 'audioReactive' : videoSettings.audioReactiveSelected;
    const videoBlockedReason = target && videoSettings.blockedReasonFor ? videoSettings.blockedReasonFor(settings) : videoSettings.videoBlockedReason;
    if (videoBlockedReason) { toast.error(videoBlockedReason); return Promise.resolve({ ok: false }); }
    // #8977: a performance shot lip-syncs to the master recording, which only a
    // verified source-audio provider can do — never a cutaway lane with an
    // invented voice. The server slices the song and re-checks the capability.
    const performance = isPerformanceScene(scene);
    const performanceBlocked = performance
      ? (audioReactiveSelected ? performanceBlockedReason('local') : performanceBlockedReason(settings.backend))
      : null;
    if (performanceBlocked) { toast.error(performanceBlocked); return Promise.resolve({ ok: false }); }
    // Hosted performance shots use their own server-prepared song window, not
    // the Local cutaway's supplied-audio route.
    const hostedPerformance = performance && settings.backend === 'fal';
    // The shot card's checkbox (true/false) overrides the project's LTX 2.5 References mode. A project-default
    // render without a card (bulk, revision) resolves the shot's clip references itself; the server then adds the
    // reference-sheet prefix. A greybox shot, or a model that is not LTX 2.5, renders as usual.
    const localCutaway = settings.backend === 'local' && !performance && !audioReactiveSelected;
    const projectLtxReferences = settings.generationMode === LTX_REFERENCES_GENERATION_MODE && localCutaway
      && isLtx25Model((videoSettings.models || []).find((m) => m.id === (settings.modelId || videoSettings.defaultModel)))
      && !scene.setReference?.greyboxShotId;
    const useLtxReferences = localCutaway && (typeof card?.ltxReferences === 'boolean' ? card.ltxReferences : projectLtxReferences);
    const ltxReferenceFiles = !useLtxReferences ? null : card?.ltxReferences === true ? card.expectedClipReferenceFiles
      : musicVideoClipConditioningReferences(project, scene, castMedia, { limit: LTX_REFERENCES_MAX_REFERENCES }).map((ref) => ref.imageId);
    if (useLtxReferences && card?.ltxReferences !== true) {
      if (castGuidesPending(scene)) return Promise.resolve({ ok: false });
      if (!ltxReferenceFiles.length) { toast.error('Choose at least one clip reference for LTX 2.5 References'); return Promise.resolve({ ok: false }); }
    }
    const coverSec = sourceClipNeedSec(scene, project?.scenes);
    const ownSpan = typeof scene?.endSec === 'number' && typeof scene?.startSec === 'number' ? scene.endSec - scene.startSec : null;
    const ltxScene = coverSec != null && ownSpan != null && coverSec > ownSpan + 1e-6 ? { startSec: 0, endSec: coverSec } : scene;
    const referenceFrames = useLtxReferences ? ltxReferenceFrames(ltxScene, target) : null;
    if (useLtxReferences && referenceFrames == null) {
      toast.error('This shot is too long for one LTX reference clip. Split it or choose a shorter clip length.');
      return Promise.resolve({ ok: false });
    }
    const songAudio = useLtxReferences || hostedPerformance ? false : typeof card?.songAudio === 'boolean' ? card.songAudio : settings.generationMode === 'suppliedAudio';
    const mode = useLtxReferences ? LTX_REFERENCES_IC_MODE : audioReactiveSelected || songAudio ? 'a2v' : 'image';
    const falFields = settings.backend === 'fal'
      ? falTakeRequestFields(falSceneTake({ scene, scenes: project?.scenes, videoSettings: settings, songDurationSec: project?.audioAnalysis?.durationSec ?? null }))
      : null;
    // Runway — image-to-video cutaways, the take the scene card prices (runwaySceneTake).
    const runwayFields = settings.backend === 'runway'
      ? runwayTakeRequestFields(runwaySceneTake({ scene, scenes: project?.scenes, videoSettings: settings }))
      : null;
    // Only a cold-open shot playing its clip's own sound renders with sound (fal asks via falSceneTake).
    const disableAudio = !preMusicClipSound(scene);
    const renderKey = videoLane.startScene(scene.sceneId, { label: videoRenderLabel(settings) });
    return renderMusicVideoSceneClip(project.id, scene.sceneId, {
      prompt,
      ...(settings.backend ? { backend: settings.backend } : {}),
      ...(settings.backend === 'grok'
        // Request the 6/10s clip that COVERS this shot; the saved pin is only
        // the fallback for a scene not yet timed on the song.
        // A scene card's Length pick wins.
        ? { grokDuration: grokSceneRequestDuration(scene, settings, target, project?.scenes) }
        // fal.ai (#8968) — image-to-video only (see VideoRenderSettings). The
        // request is exactly the take the scene card prices (falSceneTake):
        // a cutaway names its model, the length covering the shot (or the
        // pinned length) and its resolution; a performance clip's length
        // follows its song slice (server-side), so it sends only the lip-sync
        // resolution.
        : falFields || runwayFields
          ? falFields || runwayFields
          : settings.backend === 'gemini'
            // Gemini's composer has no length or audio control.
            ? {}
            : settings.backend === 'local'
            // A scene card's pick names its model and length; else the saved model at the model's default length.
            ? { modelId: settings.modelId || undefined,
              ...(useLtxReferences ? { numFrames: referenceFrames,
                icReferenceImageFiles: ltxReferenceFiles } : target?.numFrames ? { numFrames: target.numFrames } : {}), disableAudio }
            // A named model is local-only machinery at the server boundary and
            // would force the resolver off a Grok install default. Keep the
            // shared pin saved, but omit it until this peer chooses Local.
            : { grokDuration: settings.grokDuration, disableAudio }),
      mode,
      sourceImageFile: scene.referenceImageId,
      // A style-break end frame (#11173), when this fal or local model takes one
      // (a local LTX clip then renders first+last frame, #11258).
      ...(useLtxReferences || (card && (card.endFrame === false || songAudio)) ? {} : sceneEndFrameRequestFields(scene, {
        backend: settings.backend, falModelId: falFields?.falModelId, runwayModelId: runwayFields?.runwayModelId, mode, // A card's local pick names its own model; else the active one.
        localRuntime: (target?.modelId ? (videoSettings.models || []).find((m) => m.id === target.modelId)?.runtime : videoSettings.activeModel?.runtime) ?? null,
      })),
      ...(audioReactiveSelected ? {
        audioStartSec: scene.startSec || 0,
        loraFilenames: [detectedAudioReactiveLora.filename],
        loraScales: [settings.audioReactiveScale],
      } : {}),
      musicVideo: JSON.stringify({
        catalogBasis: project.castAndSets?.catalogCheckin?.basis,
        projectId: project.id, sceneId: scene.sceneId, ...(revisionId ? { revisionId } : {}),
        compose: true, expectedShot: sceneRenderShot(scene), ...(audioReactiveSelected ? { audioReactive: true } : {}),
        ...(hostedPerformance ? { songAudio: false } : {}),
        ...(card ? { promptAsTyped: true, ...(typeof card.songAudio === 'boolean' && !performance ? { songAudio: card.songAudio } : {}) } : {}),
        ...(Array.isArray(card?.expectedClipReferenceFiles) ? { expectedClipReferenceFiles: card.expectedClipReferenceFiles }
          : useLtxReferences ? { expectedClipReferenceFiles: ltxReferenceFiles } : {}),
        ...(Array.isArray(card?.expectedClipReferenceLabels) ? { expectedClipReferenceLabels: card.expectedClipReferenceLabels } : {}),
        ...(card?.wholeLine && performance ? { wholeLine: true } : {}),
        ...(card?.startFrameLayout ? { startFrameLayout: true } : {}),
      }),
    }, { silent: true })
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
    runBatch(videoBatch, pending, generateSceneVideo);
  };

  return {
    genScenes,
    genVideoScenes,
    failedScenes,
    genEndFrameScenes: endFrameLane.genScenes,
    sceneProgress: frameLane.sceneProgress,
    videoSceneProgress: videoLane.sceneProgress,
    videoSceneJobs: videoLane.sceneJobs,
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
