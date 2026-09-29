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
 * When the project carries a vocal stem (vocalStem.js) the window is cut from
 * the stem instead of the mix, at the same song times, after re-checking that
 * the stem still shares the master's timebase. The instruction records which
 * recording conditioned the take.
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
import { getFalVideoModel } from '../../lib/falVideoModels.js';
import {
  clipRelativeCues,
  isPerformanceScene,
  performanceBlockedReason,
  performanceCapability,
  planPerformanceWindow,
  selectedPerformanceInstruction,
} from '../../lib/musicVideoShotTiming.js';
import { getProject } from './projects.js';
import { assertVocalStemTimebase, resolveVocalStemPath } from './vocalStem.js';

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
 */
async function sliceAudioWindow(sourcePath, outPath, { startSec, endSec }) {
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

// Recorded vs current scene times agree within a millisecond.
const SAME_TIME_SEC = 0.001;

/**
 * Performance scenes whose SELECTED clip cannot be rendered as a lip-synced
 * shot: a take with no performance instruction (a cutaway render or an import
 * made before the scene became a performance), or one generated against a
 * different song interval (the scene was re-timed) or a different recording
 * (the song was replaced). Returns
 * `[{ sceneId, reason: 'not-lip-synced' | 'retimed' | 'audio-changed' }]`;
 * the master is hashed only when there is a performance take to check.
 */
export async function findStalePerformanceTakes(project, masterPath) {
  const stale = [];
  const selected = [];
  for (const scene of Array.isArray(project?.scenes) ? project.scenes : []) {
    if (!isPerformanceScene(scene) || !scene.videoHistoryId) continue;
    const instruction = selectedPerformanceInstruction(scene);
    if (instruction) selected.push({ scene, instruction });
    else stale.push({ sceneId: scene.sceneId, reason: 'not-lip-synced' });
  }
  if (selected.length === 0) return stale;
  const sha256 = await hashFile(masterPath);
  for (const { scene, instruction } of selected) {
    const interval = instruction.songInterval || {};
    if (instruction.audio?.sha256 !== sha256) stale.push({ sceneId: scene.sceneId, reason: 'audio-changed' });
    else if (!(Math.abs(interval.startSec - scene.startSec) <= SAME_TIME_SEC && Math.abs(interval.endSec - scene.endSec) <= SAME_TIME_SEC)) {
      stale.push({ sceneId: scene.sceneId, reason: 'retimed' });
    }
  }
  return stale;
}

/**
 * Prepare a Music Video scene render's performance inputs.
 *
 * Returns `null` for a cutaway scene (nothing to add), or
 * `{ audioFilePath, shotInstruction, modelId, resolution, enableTranscription }`
 * for a performance scene on a capable backend. `resolution` is the take's
 * output resolution: the request's own when the lip-sync route offers it, else
 * the project's `videoSettings.falLipSyncResolution`, else the capability
 * default (1080P). Throws a 4xx ServerError when the scene is a performance
 * shot the backend or its timing cannot deliver.
 */
export async function preparePerformanceShot({ musicVideo, backend, sourceImagePath, mode, resolution = null }) {
  if (!musicVideo?.projectId || !musicVideo?.sceneId) return null;
  const project = await getProject(musicVideo.projectId);
  const scene = project?.scenes?.find((s) => s.sceneId === musicVideo.sceneId);
  // An unknown project/scene is not a performance shot; the render proceeds as
  // before and the completion hook refuses to attach it to a deleted scene.
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
  const offered = getFalVideoModel(capability.modelId)?.resolution?.options || capability.resolutions || [];
  const pick = (value) => (typeof value === 'string' ? offered.find((o) => o.toLowerCase() === value.trim().toLowerCase()) : null);
  const takeResolution = pick(resolution) || pick(project.videoSettings?.falLipSyncResolution) || capability.defaultResolution;

  // An optional vocal stem conditions the provider in place of the mix. It
  // is re-checked here because the file could have been replaced on disk or
  // arrived from a peer since it was attached.
  const stemPath = resolveVocalStemPath(project);
  if (stemPath) assertVocalStemTimebase(await probeVideoDuration(stemPath), songDurationSec);

  const audioSha256 = await hashFile(masterPath);
  const conditioningSha256 = stemPath ? await hashFile(stemPath) : audioSha256;
  await ensureDir(PATHS.uploads);
  const audioFilePath = join(PATHS.uploads, `mv-performance-${randomUUID()}.wav`);
  await sliceAudioWindow(stemPath || masterPath, audioFilePath, { startSec: plan.windowStartSec, endSec: plan.windowEndSec });
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
      // What the provider heard: the master itself, or a vocal stem on the
      // master's timebase. `sha256` above stays the master's, so a take
      // is stale only when the song changes, not when a stem is swapped.
      conditioning: { source: stemPath ? 'vocal-stem' : 'master', sha256: conditioningSha256 },
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
      resolution: takeResolution,
    },
    // The provider's output length follows the submitted audio.
    generatedCoverageSec: plan.windowSec,
  };
  return {
    audioFilePath,
    shotInstruction,
    modelId: capability.modelId,
    resolution: takeResolution,
    enableTranscription: capability.transcription === true,
  };
}
