/**
 * Music Video checks a video submission runs as its last steps before the queue
 * write: the production and brief gates, the shot prompt, timing and action
 * contract guards, dependency capture and the board cost stamp. Staging and
 * FableLoom compilation can take real time, so everything here re-reads the
 * project and refuses a submission whose scene or song moved meanwhile.
 * Loaded on demand by `videoGen/submitJob.js`, only for a tagged submission.
 */
import { basename } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { musicVideoBriefAllowsVideo } from '../../lib/musicVideoMediumPlan.js';
import { assertShotActionContract, withShotActionPrompt } from '../../lib/musicVideoActionContract.js';
import { captureTakeDependencies, musicVideoDependencyChanges } from '../../lib/musicVideoDependencies.js';
import { silentMotionPrompt } from '../../lib/musicVideoMotion.js';
import { musicVideoCreativeContext } from '../../lib/musicVideoCreativeContext.js';
import { musicVideoShotModelInput } from '../../lib/musicVideoShotPrompt.js';
import { falSceneTake, runwaySceneTake } from '../../lib/musicVideoShotTiming.js';
import { VIDEO_GEN_MODE } from '../videoGen/modes.js';

const SONG_SAMPLE_RATE = 48000;

const refuse = (status, code, message) => { throw new ServerError(message, { status, code }); };

/** A Music Video motion prompt for a take that hears no audio, with the project's look clauses removed. */
async function silentMusicVideoMotionPrompt(prompt, project, scene) {
  const { visualDirection } = await import('./handoff.js');
  return silentMotionPrompt(prompt, { styleParts: [project?.concept?.style, musicVideoCreativeContext(project?.concept, { moodBoard: false }),
    visualDirection(project?.visualSpec)].filter(Boolean), keep: [scene?.direction?.motionClause] });
}

/** Rewrites `params.prompt` for the shot and returns the labeled additions the composer put around it. */
export async function composeShotPrompt({ body, params, project, scene, prepared, performance, backend, greybox }) {
  const { musicVideo } = body;
  // A take that hears nothing (no lip-sync or supplied song audio) gets plain physical
  // motion: the model would act out song cues and look words instead of reading them.
  const hearsAudio = !!(performance || prepared.audio || params.audioConditioning || params.audioFilePath);
  const offsetSec = performance?.shotInstruction?.edit?.inSec || 0;
  if (musicVideo.compose) {
    // The director's text plus each labeled block PortOS adds (#11317), from the same
    // composer the shot card shows; a take that hears nothing gets no look or song timing.
    const composed = musicVideoShotModelInput(project, scene, {
      greybox, authored: params.prompt, asTyped: musicVideo.promptAsTyped === true, hears: hearsAudio, backend,
      audioReactive: musicVideo.audioReactive === true, offsetSec, fixes: body._clipFixes || '',
      // A music-driven take on a reference model hears the song slice as "Audio 1" / @Audio1.
      audioReferenceModelId: backend === VIDEO_GEN_MODE.FAL ? performance?.modelId || null : null,
    });
    params.prompt = composed.prompt;
    return composed.promptAdditions;
  }
  // A client from before the composer sends its prompt already composed.
  // A shot card's prompt is sent as shown, its shot actions included; only a performance
  // take re-times them to its padded song slice.
  if (!musicVideo.promptAsTyped || performance) {
    params.prompt = withShotActionPrompt(params.prompt, project, scene, { offsetSec });
  }
  if (!hearsAudio && !musicVideo.promptAsTyped) params.prompt = await silentMusicVideoMotionPrompt(params.prompt, project, scene);
  if (greybox) {
    params.prompt = [params.prompt, ...greybox.promptAdditions.map((a) => a.text)].filter(Boolean).join('\n');
    return greybox.promptAdditions;
  }
  return [];
}

function assertShotTiming({ params, scene, performance, prepared }) {
  if (params.audioConditioning && Math.round(scene?.startSec * SONG_SAMPLE_RATE) !== params.audioConditioning.startSample) {
    refuse(409, 'MUSIC_VIDEO_SHOT_TIMING_CHANGED', 'Scene timing changed while source audio was prepared');
  }
  const interval = performance?.shotInstruction?.songInterval || prepared.audio?.songInterval;
  if (interval && (interval.startSec !== scene?.startSec || interval.endSec !== scene?.endSec)) {
    refuse(409, 'MUSIC_VIDEO_SHOT_TIMING_CHANGED', 'The shot timing changed while its performance audio was prepared — submit again');
  }
}

/** Refuses a provider clip too short for the shot's last action, and stamps the contract on the take. */
function applyActionContract({ params, scene, performance }) {
  const contract = scene?.direction?.actionContract;
  if (contract == null) return;
  const offsetSec = performance?.shotInstruction?.edit?.inSec || 0;
  const requestedSec = performance?.shotInstruction?.audioWindow?.durationSec ?? params.duration
    ?? (Number.isFinite(params.numFrames) ? (params.numFrames - 1) / (params.fps || 24) : null);
  const lastEventSec = Math.max(0, ...['actions', 'reactions'].flatMap((key) => (contract[key] || []).map((event) => event.endSec))) + offsetSec;
  if (Number.isFinite(requestedSec) && lastEventSec > requestedSec) {
    refuse(422, 'MUSIC_VIDEO_ACTION_CONTRACT_INVALID', 'Shot actions do not fit inside the requested provider clip — increase its duration');
  }
  params.shotInstruction = {
    ...(params.shotInstruction || { version: 1, shotMode: scene.shotMode || 'cutaway', songInterval: { startSec: scene.startSec, endSec: scene.endSec } }),
    actionContract: structuredClone(contract),
  };
}

async function assertSourceAudioCurrent({ project, prepared }) {
  if (!prepared.audio) return;
  if (musicVideoDependencyChanges(project, prepared.audio.audioDependencies).length) {
    refuse(409, 'MUSIC_VIDEO_AUDIO_SOURCE_CHANGED', 'The source song changed while supplied audio was prepared');
  }
  const { assertCurrentSourceAudioWindow } = await import('../federatedMedia/sourceAudio.js');
  await assertCurrentSourceAudioWindow(project, prepared.audio.audioConditioning);
}

function captureDependencies({ body, params, scene, prepared }) {
  if (!scene) return;
  // A style-break end frame (#11173) is a dependency too, so changing it stales the clip.
  const endImageId = body.lastImageFile && body.lastImageFile === scene.endImageId ? scene.endImageId : null;
  params.musicVideoDependencies = captureTakeDependencies(scene, prepared.sourceImagePath ? basename(prepared.sourceImagePath) : null, endImageId);
  if (prepared.audio) params.musicVideoDependencies.references.push(...prepared.audio.audioDependencies.references);
}

// The priced hosted backends: each quotes the take it would render for a scene.
const SCENE_TAKE_BY_BACKEND = {
  [VIDEO_GEN_MODE.RUNWAY]: ({ body, scene }) => runwaySceneTake({
    scene,
    videoSettings: { runwayModelId: body.runwayModelId, runwayDuration: body.runwayDuration, runwayResolution: body.runwayResolution },
  }),
  [VIDEO_GEN_MODE.FAL]: ({ body, scene, project, performance }) => falSceneTake({
    scene,
    videoSettings: {
      falMusicModelId: (performance?.shotInstruction?.performanceStyle === 'music' ? performance.modelId : null)
        ?? project.videoSettings?.falMusicModelId ?? null,
      falModelId: body.falModelId, falDuration: body.falDuration, falResolution: body.falResolution,
      falLipSyncResolution: body.falResolution, falMusicResolution: body.falResolution,
    },
    songDurationSec: project.audioAnalysis?.durationSec ?? null,
  }),
};

/**
 * #10157: a board-started (manual or auto-review) hosted clip records the
 * estimate it was priced at so project spend counts it. A production-run step
 * is already charged to the run's own usage, so it is skipped.
 */
function stampSceneTakeCost({ body, params, scene, project, performance, backend }) {
  const quote = SCENE_TAKE_BY_BACKEND[backend];
  if (!scene || !quote || body.musicVideo.productionRunId) return;
  const { costUsd, modelId } = quote({ body, scene, project, performance });
  if (Number.isFinite(costUsd)) Object.assign(params, { musicVideoCostUsd: costUsd, musicVideoCostModelId: modelId });
}

/**
 * Applies a tagged submission's guards to the job `params` about to be queued:
 * rewrites the prompt, stamps the shot instruction, dependencies and cost, and
 * throws a coded `ServerError` when the project no longer matches what was
 * prepared. Returns the labeled prompt additions the composer produced.
 */
export async function applyMusicVideoSubmissionGuards({ body, params, prepared, performance, backend }) {
  const { musicVideo } = body;
  if (musicVideo.productionRunId) {
    const { assertProductionSubmission } = await import('./productionService.js');
    await assertProductionSubmission(musicVideo.projectId, musicVideo.productionRunId,
      musicVideo.productionStepKey, { sceneId: musicVideo.sceneId, kind: 'video' });
  }
  const { getProject } = await import('./projects.js');
  const project = await getProject(musicVideo.projectId);
  // A brief that names tools and no video tool never dispatches generated footage;
  // an approved plan or sheet stays as saved until the director replans.
  if (project && !musicVideoBriefAllowsVideo(project)) {
    refuse(409, 'MUSIC_VIDEO_NO_VIDEO_TOOL', 'No video tool is selected in this project\'s brief, so generated footage is not dispatched. Add a video tool, or replan the project without generated video.');
  }
  const scene = project?.scenes?.find((entry) => entry.sceneId === musicVideo.sceneId);
  assertShotActionContract(scene);
  const { loadMusicVideoGreybox } = await import('./greyboxReferences.js');
  const greybox = await loadMusicVideoGreybox(project, scene);
  if (greybox && !params.referenceImagePaths?.some((p) => basename(p) === greybox.reference.imageId)) {
    refuse(409, 'MUSIC_VIDEO_GREYBOX_CHANGED', 'The greybox capture changed while the shot was prepared. Submit again.');
  }
  const composedAdditions = await composeShotPrompt({ body, params, project, scene, prepared, performance, backend, greybox });
  assertShotTiming({ params, scene, performance, prepared });
  applyActionContract({ params, scene, performance });
  await assertSourceAudioCurrent({ project, prepared });
  captureDependencies({ body, params, scene, prepared });
  stampSceneTakeCost({ body, params, scene, project, performance, backend });
  return composedAdditions;
}
