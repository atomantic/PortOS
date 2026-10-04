/** Exact PCM conditioning windows. Paths stay local; only hashes and sample clocks travel. */
import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PATHS, ensureDir, sha256File } from '../../lib/fileUtils.js';
import { isPathInsideDir } from '../../lib/pathSafety.js';
import { ServerError } from '../../lib/errorHandler.js';

// A bounded parser, not an audio decoder. The one accepted transport is stereo
// 48 kHz signed 16-bit PCM; RIFF metadata chunks may occur before/after data.
export function pcmAudioInfo(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF'
    || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) return null;
  let format = false;
  let samples = null;
  for (let at = 12; at + 8 <= bytes.length;) {
    const kind = bytes.toString('ascii', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    const start = at + 8;
    if (start + size > bytes.length) return null;
    if (kind === 'fmt ') {
      if (format || size < 16 || bytes.readUInt16LE(start) !== 1
        || bytes.readUInt16LE(start + 2) !== 2 || bytes.readUInt32LE(start + 4) !== 48000
        || bytes.readUInt32LE(start + 8) !== 192000 || bytes.readUInt16LE(start + 12) !== 4
        || bytes.readUInt16LE(start + 14) !== 16) return null;
      format = true;
    }
    if (kind === 'data') {
      if (samples !== null || size === 0 || size % 4) return null;
      samples = size / 4;
    }
    at = start + size + (size % 2);
  }
  return format && samples > 0 && samples <= 48000 * 60
    ? { sampleRate: 48000, channels: 2, sampleCount: samples } : null;
}

export function resolveSourceAudioPath(path) {
  if (typeof path !== 'string' || !path.endsWith('.wav')) return null;
  const absolute = resolve(path);
  return isPathInsideDir(PATHS.uploads, absolute) ? absolute : null;
}

/** Slice a project recording to the model's exact frame span, on a 48 kHz clock. */
export async function prepareSourceAudioWindow({ project, scene, numFrames, fps }) {
  const startSample = Math.round(scene.startSec * 48000);
  const sampleCount = Math.round(((numFrames - 1) / fps) * 48000);
  if (!Number.isSafeInteger(startSample) || startSample < 0 || !Number.isSafeInteger(sampleCount)
    || sampleCount <= 0 || sampleCount > 48000 * 60) {
    throw new ServerError('Supply a timed scene and a video window of at most 60 seconds', { status: 400, code: 'MUSIC_VIDEO_AUDIO_WINDOW_INVALID' });
  }
  const [{ resolveMasterAudioPath }, { findFfmpeg, runFfmpegProcess }] = await Promise.all([
    import('../musicVideo/render.js'), import('../../lib/ffmpeg.js'),
  ]);
  const source = await resolveMasterAudioPath(project);
  const sourceSha256 = await sha256File(source);
  const bin = await findFfmpeg();
  if (!bin) throw new ServerError('ffmpeg is required for supplied audio', { status: 503, code: 'FFMPEG_MISSING' });
  await ensureDir(PATHS.uploads);
  const audioFilePath = join(PATHS.uploads, `mv-source-audio-${randomUUID()}.wav`);
  try {
    const endSample = startSample + sampleCount;
    const result = await runFfmpegProcess({ bin, args: ['-v', 'error', '-i', source, '-vn',
      '-af', `aresample=48000,atrim=start_sample=${startSample}:end_sample=${endSample},asetpts=PTS-STARTPTS`,
      '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', '-y', audioFilePath] });
    const info = result.ok ? pcmAudioInfo(await readFile(audioFilePath)) : null;
    if (info?.sampleCount !== sampleCount || await sha256File(source) !== sourceSha256) {
      throw new ServerError('The recording changed or cannot cover the exact requested audio window', { status: 409, code: 'MUSIC_VIDEO_AUDIO_WINDOW_INVALID' });
    }
    return { audioFilePath, audioConditioning: { sourceSha256, clipSha256: await sha256File(audioFilePath),
      ...info, startSample, endSample } };
  } catch (error) {
    await unlink(audioFilePath).catch(() => {});
    throw error;
  }
}
