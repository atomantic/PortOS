import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { findFfmpeg, probeVideoDuration, runFfmpegProcess } from '../../lib/ffmpeg.js';
import { isPreMusicShot } from '../../lib/musicVideo/musicVideoColdOpen.js';
import { scenePlayableClipId } from '../../lib/musicVideo/musicVideoSourceTake.js';
import { assertSongAudioCurrent } from '../../lib/musicVideo/musicVideoSongAudio.js';
import { musicVideoAspect, musicVideoRenderCanvas } from '../../lib/musicVideo/musicVideoAspect.js';
import { shotDownloadBasis } from '../../lib/musicVideo/musicVideoShotDownloadBasis.js';
import { requireProject } from './requireProject.js';
import { buildMusicVideoFfmpegArgs, resolveMasterAudioPath, resolveSceneClips } from './render.js';
import { assertCurrentPerformanceTakes } from './performanceShot.js';

/** Render a temporary shot on its own clock with the corresponding song window. */
export async function renderShotDownload(projectId, sceneId, signal, expectedBasis = null) {
  const project = await requireProject(projectId);
  const scene = project.scenes?.find((item) => item.sceneId === sceneId);
  if (!scene) throw new ServerError('Shot not found', { status: 404, code: 'NOT_FOUND' });
  if (expectedBasis != null && expectedBasis !== shotDownloadBasis(project, scene)) throw new ServerError('Shot settings changed or were not saved. Save them and prepare the clip again.', { status: 409, code: 'SHOT_CHANGED' });
  if (isPreMusicShot(scene) || !Number.isFinite(scene.startSec) || scene.startSec < 0 || !Number.isFinite(scene.endSec) || scene.endSec <= scene.startSec) {
    throw new ServerError('Set a song start and end for this shot before downloading it', { status: 422, code: 'SHOT_UNTIMED' });
  }
  if (!scenePlayableClipId(scene, project.scenes)) throw new ServerError('Choose a clip for this shot first', { status: 422, code: 'NO_SCENE_CLIP' });
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new ServerError('ffmpeg not found on PATH', { status: 500, code: 'FFMPEG_MISSING' });
  const audioPath = await resolveMasterAudioPath(project);
  assertSongAudioCurrent(project, basename(audioPath));
  await assertCurrentPerformanceTakes({ ...project, scenes: [scene] }, audioPath);
  const [clip] = await resolveSceneClips(project, { sceneId });
  const span = scene.endSec - scene.startSec;
  const duration = clip.loop === false && !clip.holdLastFrame ? Math.min(span, clip.sourceSec) : span;
  if (!(duration > 0)) throw new ServerError('The selected clip has no playable footage at this offset', { status: 422, code: 'NO_PLAYABLE_CLIP' });
  const audioDuration = await probeVideoDuration(audioPath).catch(() => null);
  if (!audioDuration || audioDuration + 0.04 < scene.startSec + duration) {
    throw new ServerError('The song audio does not cover this shot', { status: 422, code: 'AUDIO_TOO_SHORT' });
  }
  const selected = { ...clip, outSec: clip.inSec + duration, duration };
  const dir = await mkdtemp(join(tmpdir(), 'portos-shot-download-'));
  const path = join(dir, 'shot.mp4');
  try {
    const size = musicVideoRenderCanvas(musicVideoAspect(project), selected);
    const canvas = { width: Math.max(2, Math.round(size.width / 2) * 2), height: Math.max(2, Math.round(size.height / 2) * 2), fps: selected.fps };
    const { args } = buildMusicVideoFfmpegArgs([selected], audioPath, path, { audioStartSec: scene.startSec, audioDurationSec: duration, canvas });
    const result = await runFfmpegProcess({ bin: ffmpeg, args, signal, timeoutMs: 600000 });
    if (!result.ok || signal?.aborted) throw new ServerError('Could not render the shot with its song audio', { status: 422, code: 'SHOT_RENDER_FAILED' });
    return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}
