import toast from '../components/ui/Toast';
import { updateMusicVideoScene } from '../services/apiMusicVideo.js';
import { generateImage } from '../services/apiSystem.js';
import { generateVideo } from '../services/apiImageVideo.js';
import useSceneRenderLifecycle from './useSceneRenderLifecycle.js';

// Audio-reactive generation conditions motion on the song itself, so the prompt
// has to rule out anything that reads as a performance of it.
const AUDIO_REACTIVE_PERFORMANCE_GUARD = 'The music drives only environmental motion, lighting, particles, reflections, fabric, and subtle camera accents. No singing, lip-sync, speaking, mouth movement, dancing, instruments, performers, or musical performance.';

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
 */
export default function useMusicVideoSceneMedia({ project, videoSettings, applyScenePatch } = {}) {
  const frameLane = useSceneRenderLifecycle({
    attachEvent: 'music-video:scene-image',
    completedEvent: 'image-gen:completed',
    failedEvent: 'image-gen:failed',
    canceledEvent: 'image-gen:canceled',
    apply: ({ projectId, sceneId, referenceImageId }) => applyScenePatch?.(projectId, sceneId, { referenceImageId }),
    failMessage: 'Frame render failed',
  });
  const videoLane = useSceneRenderLifecycle({
    attachEvent: 'music-video:scene-video',
    completedEvent: 'video-gen:completed',
    failedEvent: 'video-gen:failed',
    canceledEvent: 'video-gen:canceled',
    apply: ({ projectId, sceneId, videoHistoryId }) => applyScenePatch?.(projectId, sceneId, { videoHistoryId }),
    failMessage: 'Scene video render failed',
  });
  const genScenes = frameLane.genScenes;
  const genVideoScenes = videoLane.genScenes;

  const style = project?.concept?.style?.trim();
  // The image prompt for a scene's reference frame: its frame prompt (or the
  // shot prompt as a fallback) suffixed with the project's global concept style.
  const buildFramePrompt = (scene) =>
    [(scene.framePrompt?.trim() || scene.prompt?.trim() || ''), style].filter(Boolean).join(', ');
  // The i2v prompt for a scene's clip: its shot prompt (or the frame prompt as a
  // fallback) suffixed with the same style. The reference frame already fixes
  // the look; this prompt guides the motion.
  const buildShotPrompt = (scene) =>
    [(scene.prompt?.trim() || scene.framePrompt?.trim() || ''), style].filter(Boolean).join(', ');

  /**
   * Render a still reference frame for one scene from its frame prompt. The
   * async local/Codex lanes ride the media-job queue and are attached durably
   * server-side (musicVideoSceneImageHook → music-video:scene-image); we record
   * the job id and let the terminal image-gen:completed/failed event clear the
   * spinner (so a failed render doesn't strand the button). The synchronous
   * external SD-API lane returns a finished filename inline — attach it here.
   */
  const generateFrame = (scene) => {
    const prompt = buildFramePrompt(scene);
    if (!prompt) { toast.error('Add a frame prompt or shot prompt first'); return; }
    const projectId = project.id;
    frameLane.startScene(scene.sceneId);
    generateImage({ prompt, musicVideo: { projectId, sceneId: scene.sceneId } }, { silent: true })
      .then((res) => {
        const stillRunning = res?.status === 'queued' || res?.status === 'running';
        if (stillRunning) {
          // async lane: correlate the job so its terminal event clears the spinner
          // (and the durable scene-image event lands the generated frame). trackJob
          // reconciles a terminal event that raced ahead of this .then (fast fail).
          const jobId = res?.jobId || res?.generationId;
          if (!jobId) { frameLane.clearScene(scene.sceneId); return; } // no id to track → don't strand the button
          frameLane.trackJob(jobId, scene.sceneId);
          return;
        }
        const filename = res?.filename;
        if (filename) {
          applyScenePatch?.(projectId, scene.sceneId, { referenceImageId: filename });
          updateMusicVideoScene(projectId, scene.sceneId, { referenceImageId: filename }, { silent: true })
            .catch((err) => toast.error(err?.message || 'Failed to attach frame'));
        }
        frameLane.clearScene(scene.sceneId);
      })
      .catch((err) => {
        toast.error(err?.message || 'Frame generation failed');
        frameLane.clearScene(scene.sceneId);
      });
  };

  // Correlate a kicked-off video job with its scene, or clear the spinner when
  // the response carried no id to track. trackJob reconciles a terminal event
  // that raced ahead of this .then.
  const trackVideoJob = (res, sceneId) => {
    const jobId = res?.jobId || res?.generationId;
    if (!jobId) { videoLane.clearScene(sceneId); return; }
    videoLane.trackJob(jobId, sceneId);
  };

  /**
   * Generate this scene's video from its chosen reference frame via the video
   * route's image (i2v) mode. The render always rides the media-job queue, so we
   * correlate the returned job id and let the terminal video-gen:completed/failed
   * event clear the spinner; the finished clip's history id lands durably via
   * music-video:scene-video (musicVideoSceneVideoHook). generateVideo() throws on
   * a non-OK response, so the catch owns the only error toast (no double-toast).
   */
  const generateSceneVideo = (scene) => {
    if (!scene.referenceImageId) { toast.error('Generate a reference frame first'); return; }
    const basePrompt = buildShotPrompt(scene);
    if (!basePrompt) { toast.error('Add a shot prompt first'); return; }
    const { settings, audioReactiveSelected, audioReactiveReady, detectedAudioReactiveLora } = videoSettings;
    if (audioReactiveSelected && !audioReactiveReady) {
      toast.error('Audio-reactive generation requires an installed LTX-2.3 audio-reactive LoRA and an LTX-2.3 local model');
      return;
    }
    const prompt = audioReactiveSelected
      ? `${basePrompt}. ${AUDIO_REACTIVE_PERFORMANCE_GUARD}`
      : basePrompt;
    videoLane.startScene(scene.sceneId);
    generateVideo({
      prompt,
      ...(settings.backend ? { backend: settings.backend } : {}),
      ...(settings.backend === 'grok'
        ? { grokDuration: settings.grokDuration }
        : settings.backend === 'local'
          ? { modelId: settings.modelId || undefined, disableAudio: true }
          // A named model is local-only machinery at the server boundary and
          // would force the resolver off a Grok install default. Keep the
          // shared pin saved, but omit it until this peer chooses Local.
          : { grokDuration: settings.grokDuration, disableAudio: true }),
      mode: audioReactiveSelected ? 'a2v' : 'image',
      sourceImageFile: scene.referenceImageId,
      ...(audioReactiveSelected ? {
        audioStartSec: scene.startSec || 0,
        loraFilenames: [detectedAudioReactiveLora.filename],
        loraScales: [settings.audioReactiveScale],
      } : {}),
      musicVideo: JSON.stringify({ projectId: project.id, sceneId: scene.sceneId }),
    })
      .then((res) => trackVideoJob(res, scene.sceneId))
      .catch((err) => {
        toast.error(err?.message || 'Scene video generation failed');
        videoLane.clearScene(scene.sceneId);
      });
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
    const { settings, activeModel, effectiveModelId } = videoSettings;
    if (settings.backend !== 'local' || activeModel?.runtime !== 'ltx2') {
      toast.error('Choose an LTX local model with native continuation support');
      return;
    }
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
      .catch((err) => {
        toast.error(err?.message || 'Shot continuation failed');
        videoLane.clearScene(scene.sceneId);
      });
  };

  const scenes = project?.scenes || [];
  const generateMissingFrames = () => {
    const pending = scenes.filter((scene) =>
      !scene.referenceImageId && !genScenes[scene.sceneId] && buildFramePrompt(scene));
    if (pending.length === 0) {
      toast.info('Every scene already has a reference frame');
      return;
    }
    pending.forEach(generateFrame);
  };

  const generateMissingVideos = () => {
    const pending = scenes.filter((scene) =>
      scene.referenceImageId && !scene.videoHistoryId && !genVideoScenes[scene.sceneId] && buildShotPrompt(scene));
    if (pending.length === 0) {
      const referenceFrameCount = scenes.filter((scene) => scene.referenceImageId).length;
      toast.info(referenceFrameCount < scenes.length
        ? 'Generate every reference frame before generating the remaining videos'
        : 'Every scene already has a video');
      return;
    }
    pending.forEach(generateSceneVideo);
  };

  return {
    genScenes,
    genVideoScenes,
    buildFramePrompt,
    buildShotPrompt,
    generateFrame,
    generateSceneVideo,
    continueSceneVideo,
    generateMissingFrames,
    generateMissingVideos,
  };
}
