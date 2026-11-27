/** Inspect media streams, timing, tags, fingerprints, and playability with FFprobe and FFmpeg. */

import { randomUUID } from 'crypto';
import { existsSync, statSync } from 'fs';
import { unlink, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { execFile } from '../childProcess.js';
import { safeChildProcessOptions } from '../processEnv.js';
import { findFfmpeg, findFfprobe } from './discovery.js';
import { FFMPEG_SCAN_TIMEOUT_MS, runFfmpegProcess } from './process.js';

const execFileAsync = promisify(execFile);

// Run ffprobe with the given args and return its trimmed stdout, or '' when
// ffprobe is unavailable or the call fails. Collapses the shared discover →
// spawn → catch-default → trim boilerplate so probes share the same
// env/timeout/error-handling contract.
const runFfprobe = async (args, timeout = 5000) => {
  const ffprobe = await findFfprobe();
  if (!ffprobe) return '';
  const { stdout } = await execFileAsync(ffprobe, args, safeChildProcessOptions({ timeout })).catch(() => ({ stdout: '' }));
  return (stdout || '').trim();
};

// Probe whether a media file carries at least one audio stream. Referencing
// `[0:a]` in a filter_complex graph against a silent video (AI-gen clips are
// silent today) aborts the whole ffmpeg run, so callers that want to preserve
// a clip's own soundtrack (e.g. LTX-2 audio-to-video) must gate the `[0:a]`
// input on this probe. Returns false when ffprobe is unavailable so callers
// default to the safe "no clip audio" path rather than emitting a graph that
// can't build.
export const hasAudioStream = async (videoPath, { signal, onLifecycle } = {}) => {
  if (typeof videoPath !== 'string' || !videoPath) return false;
  const args = [
    '-v', 'error',
    '-select_streams', 'a',
    '-show_entries', 'stream=index',
    '-of', 'default=nokey=1:noprint_wrappers=1',
    videoPath,
  ];
  if (!signal && !onLifecycle) return (await runFfprobe(args)).length > 0;
  const bin = await findFfprobe();
  if (!bin) return false;
  let hasOutput = false;
  const result = await runFfmpegProcess({ bin, args, signal, timeoutMs: 5000, onLifecycle,
    onStdout: chunk => { hasOutput ||= chunk.toString().trim().length > 0; } });
  return result.ok && hasOutput;
};

// Unlike the permissive helper above, distinguish a silent video from a
// failed probe when a caller must verify that a soundtrack was preserved.
export const probeVideoAudioPresence = async (videoPath) => {
  if (typeof videoPath !== 'string' || !videoPath) return null;
  const ffprobe = await findFfprobe();
  if (!ffprobe) return null;
  const result = await execFileAsync(ffprobe, [
    '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=index',
    '-of', 'default=nokey=1:noprint_wrappers=1', videoPath,
  ], safeChildProcessOptions({ timeout: 5000 })).catch(() => null);
  if (!result) return null;
  const output = (result.stdout || '').trim();
  return output === '' ? false : /^\d+$/.test(output) ? true : null;
};

/** Audio samples on the container timeline, excluding any AAC decoder padding. */
export async function probeVideoAudioSampleCount(videoPath) {
  const stdout = await runFfprobe([
    '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate,duration',
    '-of', 'default=noprint_wrappers=1', videoPath,
  ]);
  const rate = Number(stdout.match(/^sample_rate=(.+)$/m)?.[1]);
  const duration = Number(stdout.match(/^duration=(.+)$/m)?.[1]);
  const count = Math.round(rate * duration);
  return Number.isSafeInteger(count) && count > 0 ? count : null;
}

// Single-video thumbnail extraction. Seeks to mid-clip rather than frame 0
// because LTX-2 renders fade IN from black: the first ~0.5s is near-zero

// Probe a media file's duration in seconds via ffprobe. The implementation is
// container-level and works for audio-only files too. Returns null when ffprobe
// is unavailable or the file has no parseable duration — callers must treat null
// as "unknown" rather than 0. The historical `probeVideoDuration` export name is
// retained because cue placement already consumes it.
const probeDurationSeconds = async (videoPath) => {
  const stdout = await runFfprobe([
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=nokey=1:noprint_wrappers=1',
    videoPath,
  ]);
  const n = parseFloat(stdout);
  return Number.isFinite(n) && n > 0 ? n : null;
};
export const probeVideoDuration = probeDurationSeconds;

// Probe the video's total frame count. Tries the fast metadata path first
// (`stream=nb_frames`) and falls back to an actual frame count
// (`-count_frames stream=nb_read_frames`) for containers that don't expose
// nb_frames in their header. Returns null when both paths fail or the
// reported count is unusable.
export const probeFrameCount = async (videoPath) => {
  const run = async (countFrames) => {
    const stdout = await runFfprobe([
      '-v', 'error',
      ...(countFrames ? ['-count_frames'] : []),
      '-select_streams', 'v:0',
      '-show_entries', `stream=${countFrames ? 'nb_read_frames' : 'nb_frames'}`,
      '-of', 'default=nokey=1:noprint_wrappers=1',
      videoPath,
    ], 15000);
    const n = parseInt(stdout, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return (await run(false)) ?? (await run(true));
};

// Probe the video stream geometry in ONE ffprobe call: pixel dimensions, the
// average frame rate, and the header frame count. Callers that need a frame
// count they can trust on any container should still fall back to
// `probeFrameCount` (which pays for a decode pass when the header lacks
// nb_frames) — this returns `frameCount: null` rather than guessing.
//
// Every field is independently nullable: an unreadable axis is "unknown", never
// 0, so a caller cannot read a failed probe as a real measurement.
async function probeVideoFields(videoPath, includeDuration) {
  if (typeof videoPath !== 'string' || !videoPath) return new Map();
  // Keyed output (`nokey=0`), NOT positional: ffprobe prints requested entries in
  // its own internal field order rather than the order they were asked for, so
  // destructuring the lines would silently swap two fields the day that order
  // changes. Reading `key=value` costs nothing and cannot mis-bind.
  const stdout = await runFfprobe([
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', `stream=width,height,avg_frame_rate,nb_frames${includeDuration ? ':format=duration' : ''}`,
    '-of', 'default=noprint_wrappers=1',
    videoPath,
  ]);
  return new Map(stdout.split(/\r?\n/).map((line) => {
    const at = line.indexOf('=');
    return at === -1 ? null : [line.slice(0, at).trim(), line.slice(at + 1).trim()];
  }).filter(Boolean));
}

function videoStreamInfo(fields) {
  const width = fields.get('width');
  const height = fields.get('height');
  const frameRate = fields.get('avg_frame_rate');
  const frames = fields.get('nb_frames');
  const positiveInt = (value) => {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  // ffprobe reports avg_frame_rate as a rational ("24000/1001"), and "0/0" for
  // a stream it could not measure.
  const parseRate = (value) => {
    if (!value) return null;
    const [num, den] = value.split('/');
    const n = parseFloat(num);
    const d = den === undefined ? 1 : parseFloat(den);
    if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0 || n <= 0) return null;
    return n / d;
  };
  return {
    width: positiveInt(width),
    height: positiveInt(height),
    fps: parseRate(frameRate),
    frameCount: positiveInt(frames),
  };
}

export const probeVideoStreamInfo = async (videoPath) => videoStreamInfo(await probeVideoFields(videoPath, false));

// Pixel aspect is distinct from raster dimensions. Null means ffprobe could
// not establish it; callers that require exact display geometry can refuse.
export const probeVideoPixelAspect = async (videoPath) => {
  if (typeof videoPath !== 'string' || !videoPath) return null;
  const stdout = await runFfprobe(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=sample_aspect_ratio', '-of', 'default=nokey=1:noprint_wrappers=1', videoPath]);
  const match = /^\s*(\d+):(\d+)\s*$/.exec(stdout);
  if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) return null;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) return null;
  return { numerator, denominator };
};

export const probeSquareVideoPixels = async videoPath => {
  const aspect = await probeVideoPixelAspect(videoPath);
  return aspect ? aspect.numerator === aspect.denominator : null;
};

// What a stream copy needs two clips to share before their video can be joined
// without a decode: codec, profile/level, pixel format and the colour tags the
// decoder reads off the stream. Joined into one comparable string, or null when
// the probe could not read the stream. Equal strings are necessary, not
// sufficient — callers still verify the joined result.
export const probeVideoCodecSignature = async (videoPath) => {
  if (typeof videoPath !== 'string' || !videoPath) return null;
  const stdout = await runFfprobe([
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,profile,level,pix_fmt,color_range,color_space,color_transfer,color_primaries,field_order',
    '-of', 'default=noprint_wrappers=1',
    videoPath,
  ]);
  const lines = stdout.split(/\r?\n/).filter(Boolean).sort();
  return lines.some((line) => line.startsWith('codec_name=')) ? lines.join('|') : null;
};

// Per-frame MD5 of a clip's first video stream, in decode-output order — the
// ground truth for "these frames are bit-identical". Null when the clip cannot
// be fully decoded (any decode error fails the run), so a caller can never read
// a broken join as a matching one.
export const videoFrameHashes = async (videoPath) => {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg || typeof videoPath !== 'string' || !videoPath) return null;
  const hashPath = join(tmpdir(), `framemd5-${randomUUID()}.txt`);
  try {
    const run = await runFfmpegProcess({
      bin: ffmpeg,
      args: ['-v', 'error', '-xerror', '-i', videoPath, '-map', '0:v:0', '-f', 'framemd5', '-y', hashPath],
      timeoutMs: FFMPEG_SCAN_TIMEOUT_MS,
    });
    if (!run.ok) return null;
    const rows = (await readFile(hashPath, 'utf8')).split(/\r?\n/).filter((line) => line && !line.startsWith('#'));
    const hashes = rows.map((row) => row.split(',').pop().trim());
    return hashes.length ? hashes : null;
  } catch {
    return null;
  } finally {
    await unlink(hashPath).catch(() => {});
  }
};

// Identity of the soundtrack a clip plays: the MD5 of its decoded first audio
// stream. Decoded rather than hashed as packets so a lossless remux (faststart)
// keeps it, while any change to the samples — a replaced or re-muxed soundtrack,
// even at the same length — does not. Null when the clip has no readable audio.
export const audioFingerprint = async (mediaPath) => {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg || typeof mediaPath !== 'string' || !mediaPath) return null;
  const { stdout } = await execFileAsync(
    ffmpeg,
    ['-v', 'error', '-i', mediaPath, '-map', '0:a:0', '-vn', '-f', 'md5', '-'],
    safeChildProcessOptions({ timeout: 60000 }),
  ).catch(() => ({ stdout: '' }));
  return /^MD5=([0-9a-f]{32})/m.exec(stdout || '')?.[1] ?? null;
};

const MASTER_FINGERPRINT_TAG = 'portos_clip_audio_md5';

/** Copy a lossless audio master to `outPath`, stamping the clip-audio fingerprint it was mixed for. */
export const sealAudioMaster = async ({ inPath, outPath, fingerprint }) => {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return { ok: false, reason: 'ffmpeg not found' };
  return runFfmpegProcess({
    bin: ffmpeg,
    args: ['-i', inPath, '-map', '0:a:0', '-c:a', 'copy', '-metadata', `${MASTER_FINGERPRINT_TAG}=${fingerprint}`, '-y', outPath],
  });
};

/** The clip-audio fingerprint a master was sealed with, or null when absent or unreadable. */
export const readAudioMasterFingerprint = async (masterPath) => {
  const stdout = await runFfprobe(['-v', 'error', '-show_entries', 'format_tags', '-of', 'default=noprint_wrappers=1', masterPath]);
  const line = stdout.split(/\r?\n/).find((row) => row.toLowerCase().startsWith(`tag:${MASTER_FINGERPRINT_TAG}=`));
  return line ? line.slice(line.indexOf('=') + 1).trim() || null : null;
};

// The playable geometry of a finished clip — `{ width, height, fps, numFrames,
// durationSec }` — or null when any axis cannot be measured. For entries whose
// producer never recorded a frame count (hosted Grok/fal/reactor renders), so a
// consumer that trims by numFrames/fps measures the file instead of guessing.
export const probeVideoGeometry = async (videoPath) => {
  const fields = await probeVideoFields(videoPath, true);
  const stream = videoStreamInfo(fields);
  const durationSec = parseFloat(fields.get('duration'));
  if (!stream.width || !stream.height || !stream.fps || !Number.isFinite(durationSec) || durationSec <= 0) return null;
  return {
    width: stream.width,
    height: stream.height,
    fps: stream.fps,
    numFrames: stream.frameCount || Math.round(durationSec * stream.fps),
    durationSec,
  };
};

// Sanity-check that a rendered video file is actually playable: the file
// exists on disk, has non-zero bytes, and ffprobe can decode at least one
// video frame from it. Returns `{ ok: true }` on success and
// `{ ok: false, reason }` with a short human-readable cause on failure.
//
// Used by the `autoAcceptScenes` path in the Creative Director scene
// runner to avoid marking a black/zero-frame render as accepted just
// because the renderer process exited 0. Falls back to "ok" when ffprobe
// is unavailable so machines without ffmpeg installed still complete the
// auto-accept flow (the file-exists/size>0 checks still run).
export const verifyVideoPlayable = async (videoPath) => {
  if (typeof videoPath !== 'string' || !videoPath) {
    return { ok: false, reason: 'invalid video path' };
  }
  if (!existsSync(videoPath)) {
    return { ok: false, reason: `video file missing: ${videoPath}` };
  }
  // statSync is wrapped because the file can be unlinked or made
  // inaccessible between the existsSync check above and the stat call (a
  // TOCTOU race during cleanup or external file moves). We want a clean
  // structured `{ ok: false, reason }` instead of an unhandled throw that
  // would surface as a 500.
  let size = 0;
  try {
    size = statSync(videoPath).size;
  } catch (err) {
    return { ok: false, reason: `video file unreadable: ${err.message}` };
  }
  if (!size || size <= 0) {
    return { ok: false, reason: 'video file is empty (0 bytes)' };
  }
  const ffprobe = await findFfprobe();
  if (!ffprobe) return { ok: true };
  const frames = await probeFrameCount(videoPath);
  if (!frames || frames < 1) {
    return { ok: false, reason: 'ffprobe could not read any video frames' };
  }
  return { ok: true };
};

// null means inspection failed; {} means the file was inspected and had no tags.
export async function probeMediaTags(mediaPath) {
  const stdout = await runFfprobe([
    '-v', 'error', '-show_entries', 'format_tags:stream_tags', '-of', 'json', mediaPath,
  ]);
  if (!stdout) return null;
  try {
    const result = JSON.parse(stdout);
    return Object.assign({}, ...(result.streams || []).map(stream => stream.tags || {}), result.format?.tags || {});
  } catch {
    return null;
  }
}
