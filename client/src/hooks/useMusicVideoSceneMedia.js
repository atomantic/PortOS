import { shotActionContractProblem, shotActionPrompt } from '../../../server/lib/musicVideoActionContract.js';
import { musicVideoConditioningReferences, MUSIC_VIDEO_MAX_CONDITIONING_REFERENCES } from '../../../server/lib/musicVideoConditioning.js';
import { musicVideoCreativeContext } from '../../../server/lib/musicVideoCreativeContext.js';
import { useEffect, useRef } from 'react';
import socket from '../services/socket';
import toast from '../components/ui/Toast';
import { addMusicVideoSceneTake, getMusicVideoSceneJobs } from '../services/apiMusicVideo.js';
import { generateImage } from '../services/apiSystem.js';
import { generateVideo } from '../services/apiImageVideo.js';
import useSceneBatch from './useSceneBatch.js';
import useSceneRenderLifecycle from './useSceneRenderLifecycle.js';
import { isLtx2FamilyRuntime } from '../lib/runnerFamilies';
import { isLayeredComposition, isSelfDrawnLayer, sceneVisualLayer } from '../lib/musicVideoLayers.js';
import { musicVideoFrameGenSize } from '../lib/musicVideoAspect.js';
import { MOTION_CONTINUITY_CLAUSE } from '../lib/musicVideoMotion.js';
import {
  approximateMotionCues, falSceneTake, falTakeRequestFields, grokCoverage, isPerformanceScene, performanceBlockedReason,
} from '../lib/musicVideoShotTiming.js';

// Audio-reactive generation conditions motion on the song itself, so the prompt
// has to rule out anything that reads as a performance of it.
const AUDIO_REACTIVE_PERFORMANCE_GUARD = 'The music drives only environmental motion, lighting, particles, reflections, fabric, and subtle camera accents. No singing, lip-sync, speaking, mouth movement, dancing, instruments, performers, or musical performance.';

// The image backends accept at most four reference images for most models
// (server imageGen/prepareParams.js), mirrored by the server's
// MUSIC_VIDEO_MAX_CONDITIONING_REFERENCES.
export const MAX_CONDITIONING_REFERENCES = MUSIC_VIDEO_MAX_CONDITIONING_REFERENCES;

// Refusals the image route returns when the resolved backend can't consume
// reference images — surfaced as explicit capability feedback, never retried
// silently without the references.
const REFERENCE_CAPABILITY_CODES = new Set([
  'REFERENCE_IMAGES_FLUX2_ONLY',
  'IMAGE_EDIT_UNSUPPORTED_MODE',
  'TOO_MANY_REFERENCE_IMAGES',
  'TOO_MANY_INPUT_IMAGES',
]);

/**
 * The project-wide visual direction appended to every generated prompt —
 * palette and camera rules from the visual spec (#8965). Kept in step with
 * `visualDirection` in server/services/musicVideo/handoff.js, which composes
 * the same suffix for the external-tool handoff manifest.
 *
 * Typography is deliberately excluded from this suffix (#8992): the visual
 * spec's font/caption guidance belongs to the separately composited text
 * layer (#8984), not to the image/video model's prompt — describing a font
 * style there works against the "no text, letters, captions" guard the
 * applied treatment adds and encourages text baked into the generated
 * pixels. `spec.typography` still reaches the composition/typography lane
 * directly and the external handoff manifest (`visualSpec.typography`).
 */
export function visualDirection(spec) {
  if (!spec) return '';
  return [
    spec.palette?.length ? `color palette ${spec.palette.join(' ')}` : '',
    spec.cameraRules?.trim() ? `camera: ${spec.cameraRules.trim()}` : '',
  ].filter(Boolean).join('; ');
}

/** Shared scene-aware frame conditioning, with the legacy capped fallback. */
export const conditioningReferences = musicVideoConditioningReferences;

// A scene's authored span on the song, or null while it is untimed.
const sceneSpanSec = (scene) => (typeof scene.startSec === 'number' && typeof scene.endSec === 'number' && scene.endSec > scene.startSec
  ? scene.endSec - scene.startSec
  : null);

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
export default function useMusicVideoSceneMedia({ project, videoSettings, applyScenePatch } = {}) {
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
    apply: ({ projectId, sceneId, referenceImageId, takes, lastFailure }) =>
      applyScenePatch?.(projectId, sceneId, { referenceImageId, ...(Array.isArray(takes) ? { takes } : {}), ...(lastFailure !== undefined ? { lastFailure } : {}) }),
    failMessage: 'Frame render failed',
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
  const { restoreJobs: restoreFrameJobs } = frameLane;
  const { restoreJobs: restoreVideoJobs } = videoLane;
  useEffect(() => {
    if (!projectId) return undefined;
    let live = true;
    getMusicVideoSceneJobs(projectId, { silent: true })
      .then(({ jobs }) => {
        if (!live || !Array.isArray(jobs)) return;
        restoreFrameJobs(jobs.filter((j) => j.lane === 'image'));
        restoreVideoJobs(jobs.filter((j) => j.lane === 'video'));
      })
      .catch(() => {}); // best-effort: a failed lookup just means no restored spinners
    return () => { live = false; };
  }, [projectId, restoreFrameJobs, restoreVideoJobs]);
  const genScenes = frameLane.genScenes;
  const genVideoScenes = videoLane.genScenes;
  const failedScenes = { frame: frameLane.failedScenes, video: videoLane.failedScenes };

  const style = project?.concept?.style?.trim();
  const direction = [musicVideoCreativeContext(project?.concept), visualDirection(project?.visualSpec)].filter(Boolean).join('; ');
  // The i2v prompt leaves the mood-board look out (handoff.js composePrompt): the frame already carries it.
  const motionDirection = [musicVideoCreativeContext(project?.concept, { moodBoard: false }), visualDirection(project?.visualSpec)].filter(Boolean).join('; ');
  const conditioning = conditioningReferences(project);
  // The image prompt for a scene's reference frame: its frame prompt (or the
  // shot prompt as a fallback) suffixed with the project's global concept style
  // and the visual spec's palette/camera direction (typography excluded, #8992).
  // An applied treatment (#8980) adds the scene's composition constraints last:
  // focal subject, framing, the region reserved for the composited typography,
  // and no lettering in the generated pixels. Same order as the server's
  // handoff manifest (handoff.js composePrompt).
  const buildFramePrompt = (scene) =>
    [[(scene.framePrompt?.trim() || scene.prompt?.trim() || ''), style, direction, scene.direction?.frameClause?.trim()].filter(Boolean).join(', '), shotActionPrompt(project, scene, { frame: true })].filter(Boolean).join('\n');
  // The i2v prompt for a scene's clip: its shot prompt (or the frame prompt as a
  // fallback) suffixed the same way. The reference frame already fixes the
  // look; this prompt guides the motion.
  const buildShotPrompt = (scene) =>
    [[(scene.prompt?.trim() || scene.framePrompt?.trim() || ''), style, motionDirection, scene.direction?.motionClause?.trim(), MOTION_CONTINUITY_CLAUSE].filter(Boolean).join(', '), shotActionPrompt(project, scene)].filter(Boolean).join('\n');

  /**
   * Render a still reference frame for one scene from its frame prompt. The
   * async local/Codex lanes ride the media-job queue and are attached durably
   * server-side (musicVideoSceneImageHook → music-video:scene-image); we record
   * the job id and let the terminal image-gen:completed/failed event clear the
   * spinner (so a failed render doesn't strand the button). The synchronous
   * external SD-API lane returns a finished filename inline — add it as a take.
   *
   * References flagged "condition" on the visual spec ride along as real
   * conditioning inputs (`referenceImageFiles`). A backend that can't consume
   * them refuses the render, and the toast names that capability gap instead of
   * quietly rendering without the references.
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
   */
  const generateFrame = (scene, { revisionId, onJob } = {}) => {
    const conditioning = conditioningReferences(project, scene);
    const problem = shotActionContractProblem(scene.direction?.actionContract, scene);
    if (problem) { toast.error(problem); return Promise.resolve({ ok: false }); }
    const prompt = buildFramePrompt(scene);
    if (!prompt) { toast.error('Add a frame prompt or shot prompt first'); return Promise.resolve({ ok: false }); }
    const projectId = project.id;
    frameLane.startScene(scene.sceneId);
    return generateImage({
      prompt,
      ...musicVideoFrameGenSize(project),
      ...(conditioning.length ? { referenceImageFiles: conditioning.map((ref) => ref.imageId) } : {}),
      musicVideo: { projectId, sceneId: scene.sceneId, ...(revisionId ? { revisionId } : {}) },
    }, { silent: true })
      .then((res) => {
        const stillRunning = res?.status === 'queued' || res?.status === 'running';
        if (stillRunning) {
          // async lane: correlate the job so its terminal event clears the spinner
          // (and the durable scene-image event lands the generated frame). trackJob
          // reconciles a terminal event that raced ahead of this .then (fast fail).
          const jobId = res?.jobId || res?.generationId;
          if (!jobId) { frameLane.clearScene(scene.sceneId); return { ok: false }; } // no id to track → don't strand the button
          onJob?.(jobId);
          frameLane.trackJob(jobId, scene.sceneId);
          return { ok: true, jobId };
        }
        const filename = res?.filename;
        if (filename) {
          addMusicVideoSceneTake(projectId, scene.sceneId, { kind: 'image', assetId: filename, source: 'generated' }, { silent: true })
            .then(({ scene: updated }) => applyScenePatch?.(projectId, scene.sceneId, {
              referenceImageId: updated.referenceImageId, takes: updated.takes,
            }))
            .catch((err) => toast.error(err?.message || 'Failed to attach frame'));
        }
        frameLane.clearScene(scene.sceneId);
        return { ok: true };
      })
      .catch((err) => {
        if (conditioning.length && REFERENCE_CAPABILITY_CODES.has(err?.code)) {
          toast.error(`The current image backend can't condition on ${conditioning.length} reference image${conditioning.length === 1 ? '' : 's'}: ${err.message}. Switch the image backend, or untick "Condition frames" on the visual-spec references.`);
        } else {
          toast.error(err?.message || 'Frame generation failed');
        }
        frameLane.clearScene(scene.sceneId);
        return { ok: false };
      });
  };

  // Correlate a kicked-off video job with its scene, or clear the spinner when
  // the response carried no id to track. trackJob reconciles a terminal event
  // that raced ahead of this .then. Resolves `{ ok }` — see generateFrame's
  // doc comment for why the caller never sees a rejection.
  const trackVideoJob = (res, sceneId, onJob) => {
    const jobId = res?.jobId || res?.generationId;
    if (!jobId) { videoLane.clearScene(sceneId); return { ok: false }; }
    onJob?.(jobId);
    videoLane.trackJob(jobId, sceneId);
    return { ok: true, jobId };
  };

  const handleVideoError = (err, sceneId, fallbackMessage) => {
    toast.error(err?.message || fallbackMessage);
    videoLane.clearScene(sceneId);
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
  const generateSceneVideo = (scene, { revisionId, onJob } = {}) => {
    if (!scene.referenceImageId) { toast.error('Generate a reference frame first'); return Promise.resolve({ ok: false }); }
    const problem = shotActionContractProblem(scene.direction?.actionContract, scene);
    if (problem) { toast.error(problem); return Promise.resolve({ ok: false }); }
    const basePrompt = buildShotPrompt(scene);
    if (!basePrompt) { toast.error('Add a shot prompt first'); return Promise.resolve({ ok: false }); }
    const { settings, audioReactiveSelected, detectedAudioReactiveLora, videoBlockedReason } = videoSettings;
    if (videoBlockedReason) { toast.error(videoBlockedReason); return Promise.resolve({ ok: false }); }
    // #8977: a performance shot lip-syncs to the master recording, which only a
    // verified source-audio provider can do — never a cutaway lane with an
    // invented voice. The server slices the song and re-checks the capability.
    const performance = isPerformanceScene(scene);
    const performanceBlocked = performance
      ? (audioReactiveSelected ? performanceBlockedReason('local') : performanceBlockedReason(settings.backend))
      : null;
    if (performanceBlocked) { toast.error(performanceBlocked); return Promise.resolve({ ok: false }); }
    const spanSec = sceneSpanSec(scene);
    // Grok's CLI lane takes no timed controls: phrase intents ride as prose
    // whose timing is explicitly approximate. The environmental-motion guard
    // stays exclusive to the audio-reactive lane.
    const motionCues = settings.backend === 'grok' ? approximateMotionCues(project?.phrases, scene.startSec, scene.endSec) : '';
    const prompt = audioReactiveSelected
      ? `${basePrompt}. ${AUDIO_REACTIVE_PERFORMANCE_GUARD}`
      : [basePrompt, motionCues].filter(Boolean).join('. ');
    videoLane.startScene(scene.sceneId);
    return generateVideo({
      prompt,
      ...(settings.backend ? { backend: settings.backend } : {}),
      ...(settings.backend === 'grok'
        // Request the 6/10s clip that COVERS this shot; the saved pin is only
        // the fallback for a scene not yet timed on the song.
        ? { grokDuration: spanSec != null ? grokCoverage(spanSec).requestSec : settings.grokDuration }
        // fal.ai (#8968) — image-to-video only (see VideoRenderSettings). The
        // request is exactly the take the scene card prices (falSceneTake):
        // a cutaway names its model, the length covering the shot (or the
        // pinned length) and its resolution; a performance clip's length
        // follows its song slice (server-side), so it sends only the lip-sync
        // resolution.
        : settings.backend === 'fal'
          ? falTakeRequestFields(falSceneTake({ scene, videoSettings: settings, songDurationSec: project?.audioAnalysis?.durationSec ?? null }))
          : settings.backend === 'local'
            ? { modelId: settings.modelId || undefined, disableAudio: true }
            // A named model is local-only machinery at the server boundary and
            // would force the resolver off a Grok install default. Keep the
            // shared pin saved, but omit it until this peer chooses Local.
            : { grokDuration: settings.grokDuration, disableAudio: true }),
      mode: audioReactiveSelected || settings.generationMode === 'suppliedAudio' ? 'a2v' : 'image',
      sourceImageFile: scene.referenceImageId,
      ...(audioReactiveSelected ? {
        audioStartSec: scene.startSec || 0,
        loraFilenames: [detectedAudioReactiveLora.filename],
        loraScales: [settings.audioReactiveScale],
      } : {}),
      musicVideo: JSON.stringify({ projectId: project.id, sceneId: scene.sceneId, ...(revisionId ? { revisionId } : {}) }),
    })
      .then((res) => trackVideoJob(res, scene.sceneId, onJob))
      .catch((err) => handleVideoError(err, scene.sceneId, 'Scene video generation failed'));
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
    videoLane.startScene(scene.sceneId);
    generateVideo({
      prompt: buildShotPrompt(scene),
      backend: 'local',
      modelId: effectiveModelId || undefined,
      disableAudio: true,
      mode: 'extend',
      extendFromVideoId: scene.videoHistoryId,
      sourceImageFile: scene.referenceImageId,
      musicVideo: JSON.stringify({ projectId: project.id, sceneId: scene.sceneId }),
    })
      .then((res) => trackVideoJob(res, scene.sceneId))
      .catch((err) => handleVideoError(err, scene.sceneId, 'Shot continuation failed'));
  };

  const scenes = project?.scenes || [];
  // #8985: a composed render's title cards need no frame, and its stills need
  // no clip — the batch generators skip them.
  const layered = isLayeredComposition(project);
  const frameScenes = scenes.filter((scene) => !isSelfDrawnLayer(sceneVisualLayer(scene, { layered })));
  const footageScenes = scenes.filter((scene) => sceneVisualLayer(scene, { layered }) === 'footage');
  const planMissingFrames = () => frameScenes.filter((scene) =>
    !scene.referenceImageId && !genScenes[scene.sceneId] && buildFramePrompt(scene));

  // The clips a Videos batch would submit: a footage scene with a frame, no clip
  // and nothing in flight. A scene still waiting for its frame never blocks the
  // others (#10153). Performance shots the current lane cannot lip-sync are
  // dropped here and reported once (#8977).
  const planMissingVideos = () => {
    const candidates = footageScenes.filter((scene) =>
      scene.referenceImageId && !scene.videoHistoryId && !genVideoScenes[scene.sceneId] && buildShotPrompt(scene));
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
    sceneProgress: frameLane.sceneProgress,
    videoSceneProgress: videoLane.sceneProgress,
    frameBatch,
    videoBatch,
    conditioning,
    buildFramePrompt,
    buildShotPrompt,
    generateFrame,
    generateSceneVideo,
    continueSceneVideo,
    planMissingFrames,
    planMissingVideos,
    generateMissingFrames,
    generateMissingVideos,
  };
}
