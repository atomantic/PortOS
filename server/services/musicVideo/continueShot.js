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
 * model travels from the handoff to the planned still. A still shot before it
 * hands over the picture it ends on (shotHandoffSource) instead of a clip.
 */
import { join } from 'path';
import { existsSync } from 'fs';
import { ServerError } from '../../lib/errorHandler.js';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { findFfmpeg, probeVideoGeometry, runFfmpegProcess, safeUnder } from '../../lib/ffmpeg.js';
import { previousShot, sceneClipOutFrameSec, shotHandoffSource } from '../../lib/musicVideoHandoffFrame.js';
import { isLayeredComposition, sceneVisualLayer } from '../../lib/musicVideoLayers.js';
import { songScenes } from '../../lib/musicVideoColdOpen.js';
import { getHistoryItem } from '../videoGen/history.js';
import { writeLocalImageSidecarIfMissing } from '../imageGen/imageRecords.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { appendSceneTakes, selectSceneTake } from './projects.js';
import { requireProject } from './requireProject.js';

const refuse = (message, code, status = 409) => new ServerError(message, { status, code });

/**
 * Extract the previous shot's on-screen out-frame and make it `sceneId`'s
 * start frame. Returns `{ scene, frame: { imageId, atSec, fromSceneId } }`.
 */
export async function continueFromPreviousShot(projectId, sceneId, { keepStillAsEnd = false } = {}) {
  const project = await requireProject(projectId);
  const scene = project.scenes?.find((s) => s.sceneId === sceneId);
  if (!scene) throw refuse('Scene not found', 'NOT_FOUND', 404);
  const previous = previousShot(project, sceneId);
  if (!previous) throw refuse('This is the first shot, so there is no previous shot to continue from', 'MUSIC_VIDEO_NO_PREVIOUS_SHOT');
  let fps = 24;
  if (isLayeredComposition(project) && project.composition?.mode !== 'document' && previous.visualLayer === 'still'
    && previous.photoSequence && previous.photoSequence.enabled !== false) {
    const lead = songScenes(project).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .find(s => s.videoHistoryId && sceneVisualLayer(s, { layered: true }) === 'footage');
    if (lead) {
      const entry = await getHistoryItem(lead.videoHistoryId);
      const path = entry?.filename ? safeUnder(PATHS.videos, entry.filename) : null;
      if (!path || !existsSync(path)) throw refuse('Could not read the render frame rate for this photo sequence', 'MUSIC_VIDEO_PREVIOUS_CLIP_UNREADABLE', 422);
      const geometry = entry.numFrames && entry.fps && entry.width && entry.height ? entry : { ...entry, ...(await probeVideoGeometry(path)) };
      if (!Number.isFinite(geometry.fps) || geometry.fps <= 0) throw refuse('Could not read the render frame rate for this photo sequence', 'MUSIC_VIDEO_PREVIOUS_CLIP_UNREADABLE', 422);
      fps = geometry.fps;
    }
  }
  const source = shotHandoffSource(project, previous, { fps });
  // A still shot hands over the picture the cut ends on, as it is: there is no clip on screen to read.
  if (source?.imageId) return startFromFrame(projectId, scene, source.imageId, { keepStillAsEnd,
    prompt: 'The picture the previous shot ends on', frame: { imageId: source.imageId, atSec: null, fromSceneId: previous.sceneId } });
  const entry = source?.clip ? await getHistoryItem(previous.videoHistoryId) : null;
  const videoPath = entry?.filename ? safeUnder(PATHS.videos, entry.filename) : null;
  if (!videoPath || !existsSync(videoPath)) {
    throw refuse('The previous shot has no selected clip or still to continue from', 'MUSIC_VIDEO_PREVIOUS_CLIP_MISSING');
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
  // One lease from the ffmpeg write through the owner stamp, so a backup snapshot never holds the frame without its sidecar.
  await withBackupAssetPublication(async () => {
    const extracting = !existsSync(outPath);
    if (extracting) {
      const result = await runFfmpegProcess({
        bin: ffmpeg,
        args: ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(atSec), '-i', videoPath, '-frames:v', '1', outPath],
      });
      if (!result.ok || !existsSync(outPath)) {
        throw refuse(`Could not extract the previous shot's out-frame: ${result.reason || 'ffmpeg failed'}`, 'MUSIC_VIDEO_HANDOFF_FRAME_FAILED', 500);
      }
    }
    // Name this machine as the frame's owner so deleting it reaches peers. A frame
    // re-extracted under a reused name replaces any stale sidecar with a new createdAt.
    await writeLocalImageSidecarIfMissing(imageId, { replace: extracting });
  });
  console.log(`🎞️ Handoff frame for ${sceneId}: ${previous.sceneId} clip at ${atSec}s of ${geometry.durationSec.toFixed(2)}s`);

  return startFromFrame(projectId, scene, imageId, { keepStillAsEnd,
    prompt: `Out-frame of the previous shot at ${atSec}s of its clip`, frame: { imageId, atSec, fromSceneId: previous.sceneId } });
}

// Select `imageId` as the scene's start frame; with `keepStillAsEnd`, its current start frame becomes its end frame.
async function startFromFrame(projectId, scene, imageId, { keepStillAsEnd, prompt, frame }) {
  const plannedStill = keepStillAsEnd && scene.referenceImageId && scene.referenceImageId !== imageId ? scene.referenceImageId : null;
  const { appended } = await appendSceneTakes(projectId, scene.sceneId, [
    { kind: 'image', assetId: imageId, source: 'generated', provider: 'portos', prompt },
    ...(plannedStill ? [{ kind: 'endImage', assetId: plannedStill, source: 'imported', provider: 'portos' }] : []),
  ]);
  let updated = await selectSceneTake(projectId, scene.sceneId, appended[0].takeId);
  if (plannedStill) updated = await selectSceneTake(projectId, scene.sceneId, appended[1].takeId);
  return { scene: updated, frame };
}
