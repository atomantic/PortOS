/**
 * Music Video performance shots (#8977) — the submission-boundary half.
 *
 * A performance scene (`scene.shotMode === 'performance'`) is a visible singer
 * that must follow the MASTER recording. At the moment a scene render is
 * submitted this module:
 *
 *   1. refuses the render unless the resolved backend has a verified
 *      source-audio lip-sync capability (lib/musicVideoShotTiming.js) — Grok and
 *      local lanes are cutaway-only, and nothing silently falls back to a lane
 *      that would invent an unrelated voice or ignore the song;
 *   2. plans the provider-bounded audio window (a short shot is padded to a
 *      supported contextual window with an explicit edit in-point; an over-long
 *      shot is refused so it is split rather than truncated by the provider);
 *   3. slices exactly that window out of the master with ffmpeg — decoded from
 *      the start and cut with `atrim` on sample timestamps, written as PCM WAV
 *      (no encoder priming delay), so the clip's audio timebase IS the song's;
 *   4. builds the immutable shot instruction record the finished take carries:
 *      the audio revision (content hash), absolute song interval, window, edit
 *      in/out points, clip-relative lyric cues, reference frame, intended
 *      performance, capability snapshot, target edit duration and the coverage
 *      the provider will generate.
 *
 * The sliced WAV is staged under data/uploads so the media-job queue owns and
 * deletes it on every terminal path (completion, failure, cancel, restart).
 * The master stays untouched and remains the only audio in the final render.
 */

import { createHash, randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import { unlink } from 'fs/promises';
import { basename, join } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { findFfmpeg, probeVideoDuration, runFfmpegProcess } from '../../lib/ffmpeg.js';
import {
  clipRelativeCues,
  isPerformanceScene,
  performanceBlockedReason,
  performanceCapability,
  planPerformanceWindow,
} from '../../lib/musicVideoShotTiming.js';
import { getProject } from './projects.js';

export const SHOT_INSTRUCTION_VERSION = 1;

const hashFile = (path) => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  createReadStream(path)
    .on('data', (chunk) => hash.update(chunk))
    .on('error', reject)
    .on('end', () => resolve(hash.digest('hex')));
});

/**
 * Cut `[startSec, endSec]` of `sourcePath` into a new PCM WAV at `outPath`.
 * Exported for the synthetic-audio contract test; production callers go
 * through `preparePerformanceShot`.
 */
export async function sliceAudioWindow(sourcePath, outPath, { startSec, endSec }) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new ServerError('ffmpeg is required to slice the song for a performance shot', { status: 500, code: 'FFMPEG_MISSING' });
  const result = await runFfmpegProcess({
    bin: ffmpeg,
    args: [
      '-v', 'error',
      '-i', sourcePath,
      '-vn',
      '-af', `atrim=start=${startSec}:end=${endSec},asetpts=PTS-STARTPTS`,
      '-c:a', 'pcm_s16le',
      '-y', outPath,
    ],
  });
  if (!result.ok) {
    await unlink(outPath).catch(() => {});
    throw new ServerError(`Failed to slice the song for a performance shot: ${result.reason}`, { status: 500, code: 'MUSIC_VIDEO_AUDIO_SLICE_FAILED' });
  }
  return outPath;
}

const refuse = (message, code, status = 400) => new ServerError(message, { status, code });

/**
 * Prepare a Music Video scene render's performance inputs.
 *
 * Returns `null` for a cutaway scene (nothing to add), or
 * `{ audioFilePath, shotInstruction, modelId, enableTranscription }` for a
 * performance scene on a capable backend. Throws a 4xx ServerError when the
 * scene is a performance shot the backend or its timing cannot deliver.
 */
export async function preparePerformanceShot({ musicVideo, backend, sourceImagePath, mode }) {
  if (!musicVideo?.projectId || !musicVideo?.sceneId) return null;
  const project = await getProject(musicVideo.projectId);
  const scene = project?.scenes?.find((s) => s.sceneId === musicVideo.sceneId);
  if (!project || !scene) throw refuse('Music-video project or scene not found', 'NOT_FOUND', 404);
  if (!isPerformanceScene(scene)) return null;

  const capability = performanceCapability(backend);
  if (!capability) throw refuse(performanceBlockedReason(backend), 'MUSIC_VIDEO_PERFORMANCE_UNSUPPORTED');
  // The lip-sync route is image + source audio; any other semantic mode would
  // ask it for something it does not do.
  if (mode && mode !== 'image') {
    throw refuse(`A performance shot renders from its reference frame and the song — mode '${mode}' is not supported.`, 'MUSIC_VIDEO_PERFORMANCE_MODE_UNSUPPORTED');
  }

  // Lazy: render.js pulls the whole render pipeline, which a cutaway
  // submission (the common case) never needs.
  const { resolveMasterAudioPath } = await import('./render.js');
  const masterPath = await resolveMasterAudioPath(project);
  const songDurationSec = await probeVideoDuration(masterPath);
  if (songDurationSec == null) throw refuse('Could not read the song duration for this performance shot', 'MUSIC_VIDEO_AUDIO_UNREADABLE');
  const plan = planPerformanceWindow({ startSec: scene.startSec, endSec: scene.endSec, songDurationSec, capability });
  if (!plan.ok) throw refuse(plan.message, plan.code);

  const audioSha256 = await hashFile(masterPath);
  await ensureDir(PATHS.uploads);
  const audioFilePath = join(PATHS.uploads, `mv-performance-${randomUUID()}.wav`);
  await sliceAudioWindow(masterPath, audioFilePath, { startSec: plan.windowStartSec, endSec: plan.windowEndSec });
  // Verify the cut before anything is paid for: the provider rejects short
  // audio and silently clips long audio, and both would break the edit points.
  const slicedSec = await probeVideoDuration(audioFilePath);
  if (slicedSec == null || slicedSec < capability.minAudioSec || slicedSec > capability.maxAudioSec) {
    await unlink(audioFilePath).catch(() => {});
    throw refuse(
      `The sliced performance audio is ${slicedSec == null ? 'unreadable' : `${slicedSec.toFixed(3)}s`} — outside ${capability.label}'s ${capability.minAudioSec}–${capability.maxAudioSec}s window.`,
      'MUSIC_VIDEO_PERFORMANCE_AUDIO_INVALID',
      500,
    );
  }

  const shotInstruction = {
    version: SHOT_INSTRUCTION_VERSION,
    shotMode: 'performance',
    createdAt: new Date().toISOString(),
    audio: {
      source: project.trackId ? 'track' : 'upload',
      sha256: audioSha256,
      songDurationSec,
    },
    songInterval: { startSec: scene.startSec, endSec: scene.endSec },
    audioWindow: { startSec: plan.windowStartSec, endSec: plan.windowEndSec, durationSec: plan.windowSec },
    edit: { inSec: plan.editInSec, outSec: plan.editOutSec, targetSec: plan.spanSec },
    cues: clipRelativeCues(project.lyricCues, plan.windowStartSec, plan.windowEndSec),
    referenceImageId: typeof sourceImagePath === 'string' ? basename(sourceImagePath) : null,
    performance: (scene.visualIntent || scene.prompt || '').slice(0, 2000),
    capability: {
      provider: capability.provider,
      modelId: capability.modelId,
      minAudioSec: capability.minAudioSec,
      maxAudioSec: capability.maxAudioSec,
      transcription: capability.transcription,
    },
    // The provider's output length follows the submitted audio.
    generatedCoverageSec: plan.windowSec,
  };
  return {
    audioFilePath,
    shotInstruction,
    modelId: capability.modelId,
    enableTranscription: capability.transcription === true,
  };
}
