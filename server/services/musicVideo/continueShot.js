/**
 * Music Video continuing shots: start a shot from the frame the previous shot
 * ends on in the cut.
 *
 * A clip is often longer than the shot that plays it, so the clip's true last
 * frame is not the last frame the viewer saw. Handing that later frame to the
 * next shot jumps the action forward and can lose what was in frame (a car
 * that had both headlights on screen at the cut kept only one by the clip's
 * end). This extracts the previous shot's on-screen out-frame
 * (lib/musicVideoHandoffFrame.js) into the gallery and selects it as this
 * scene's start frame. With `keepStillAsEnd`, the scene's current start frame
 * becomes its style-break end frame (#11173), so a fal clip on an end-frame
 * model travels from the handoff to the planned still.
 */
import { join } from 'path';
import { existsSync } from 'fs';
import { ServerError } from '../../lib/errorHandler.js';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { findFfmpeg, probeVideoGeometry, runFfmpegProcess, safeUnder } from '../../lib/ffmpeg.js';
import { previousShot, sceneClipOutFrameSec } from '../../lib/musicVideoHandoffFrame.js';
import { getHistoryItem } from '../videoGen/history.js';
import { appendSceneTakes, getProject, selectSceneTake } from './projects.js';

const refuse = (message, code, status = 409) => new ServerError(message, { status, code });

/**
 * Extract the previous shot's on-screen out-frame and make it `sceneId`'s
 * start frame. Returns `{ scene, frame: { imageId, atSec, fromSceneId } }`.
 */
export async function continueFromPreviousShot(projectId, sceneId, { keepStillAsEnd = false } = {}) {
  const project = await getProject(projectId);
  if (!project) throw refuse('Project not found', 'NOT_FOUND', 404);
  const scene = project.scenes?.find((s) => s.sceneId === sceneId);
  if (!scene) throw refuse('Scene not found', 'NOT_FOUND', 404);
  const previous = previousShot(project, sceneId);
  if (!previous) throw refuse('This is the first shot, so there is no previous shot to continue from', 'MUSIC_VIDEO_NO_PREVIOUS_SHOT');
  const entry = previous.videoHistoryId ? await getHistoryItem(previous.videoHistoryId) : null;
  const videoPath = entry?.filename ? safeUnder(PATHS.videos, entry.filename) : null;
  if (!videoPath || !existsSync(videoPath)) {
    throw refuse('The previous shot has no selected clip to continue from', 'MUSIC_VIDEO_PREVIOUS_CLIP_MISSING');
  }
  const geometry = await probeVideoGeometry(videoPath);
  const atSec = sceneClipOutFrameSec(previous, geometry?.durationSec, geometry?.fps);
  if (atSec == null) throw refuse('Could not read where the previous shot ends in its clip', 'MUSIC_VIDEO_PREVIOUS_CLIP_UNREADABLE', 422);

  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw refuse('ffmpeg not found on PATH', 'FFMPEG_MISSING', 500);
  await ensureDir(PATHS.images);
  // Keyed by clip and time, so the same handoff is extracted once.
  const imageId = `handoff-${entry.id}-${Math.round(atSec * 1000)}.png`;
  const outPath = join(PATHS.images, imageId);
  if (!existsSync(outPath)) {
    const result = await runFfmpegProcess({
      bin: ffmpeg,
      args: ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(atSec), '-i', videoPath, '-frames:v', '1', outPath],
    });
    if (!result.ok || !existsSync(outPath)) {
      throw refuse(`Could not extract the previous shot's out-frame: ${result.reason || 'ffmpeg failed'}`, 'MUSIC_VIDEO_HANDOFF_FRAME_FAILED', 500);
    }
  }
  console.log(`🎞️ Handoff frame for ${sceneId}: ${previous.sceneId} clip at ${atSec}s of ${geometry.durationSec.toFixed(2)}s`);

  const plannedStill = keepStillAsEnd && scene.referenceImageId && scene.referenceImageId !== imageId ? scene.referenceImageId : null;
  const { appended } = await appendSceneTakes(projectId, sceneId, [
    { kind: 'image', assetId: imageId, source: 'generated', provider: 'portos', prompt: `Out-frame of the previous shot at ${atSec}s of its clip` },
    ...(plannedStill ? [{ kind: 'endImage', assetId: plannedStill, source: 'imported', provider: 'portos' }] : []),
  ]);
  let updated = await selectSceneTake(projectId, sceneId, appended[0].takeId);
  if (plannedStill) updated = await selectSceneTake(projectId, sceneId, appended[1].takeId);
  return { scene: updated, frame: { imageId, atSec, fromSceneId: previous.sceneId } };
}
