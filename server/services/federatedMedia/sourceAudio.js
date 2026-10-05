import { maintenance } from '../../lib/maintenanceAdmission.js';
/** Exact PCM conditioning windows. Paths stay local; only hashes and sample clocks travel. */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { PATHS, ensureDir, sha256File } from '../../lib/fileUtils.js';
import { isPathInsideDir } from '../../lib/pathSafety.js';
import { ServerError } from '../../lib/errorHandler.js';
import { isLtx2FamilyRuntime } from '../../lib/runners.js';
import { resolveVideoSupportedModes } from '../../lib/videoModeProfiles.js';

// This slice uses the LTX PCM input and --no-audio contract. Other A2V
// runtimes have different output/window controls and are not negotiated yet.
export const supportsSourceAudioWindow = (model) => isLtx2FamilyRuntime(model?.runtime)
  && resolveVideoSupportedModes(model).includes('a2v');

/** Only this feature's owned copies may be released, never a master recording. */
export async function discardSourceAudioWindow(path) {
  if (typeof path !== 'string' || dirname(resolve(path)) !== resolve(PATHS.uploads)
    || !/^(mv-source-audio|federated-audio)-[a-f\d-]{36}\.wav$/.test(basename(path))) return { ok: false };
  try { await unlink(path); return { ok: true }; }
  catch (error) {
    if (error.code === 'ENOENT') return { ok: true };
    maintenance.markCurrentUnsettled();
    throw error;
  }
}

// A bounded parser, not an audio decoder. The one accepted transport is stereo
// 48 kHz signed 16-bit PCM; RIFF metadata chunks may occur before/after data.
export function pcmAudioInfo(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF'
    || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) return null;
  let format = false;
  let samples = null;
  let at = 12;
  for (; at + 8 <= bytes.length;) {
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
  return at === bytes.length && format && samples > 0 && samples <= 48000 * 60
    ? { sampleRate: 48000, channels: 2, sampleCount: samples } : null;
}

export function resolveSourceAudioPath(path) {
  if (typeof path !== 'string' || !path.endsWith('.wav')) return null;
  const absolute = resolve(path);
  if (!isPathInsideDir(PATHS.uploads, absolute)) return null;
  try { return isPathInsideDir(realpathSync(PATHS.uploads), realpathSync(absolute)) ? absolute : null; }
  catch { return null; }
}

/** Choose a frame canvas covering the whole authored shot before cutting PCM. */
export function sourceAudioVideoRequest(scene, capability, request) {
  const fps = request.fps ?? capability.fpsOptions?.[0] ?? 24;
  const needed = Math.ceil((scene?.endSec - scene?.startSec) * fps) + 1;
  const stride = capability.frameStride || 1;
  const frames = request.numFrames ?? (capability.frameOptions?.length
    ? [...capability.frameOptions].sort((a, b) => a - b).find((n) => n >= needed)
    : Math.ceil((needed - 1) / stride) * stride + 1);
  if (!Number.isFinite(frames) || frames < needed || frames > (capability.maxNumFrames || 1441)) {
    throw new ServerError('This model cannot cover the scene with one supplied-audio clip; split the scene', { status: 400, code: 'MUSIC_VIDEO_AUDIO_WINDOW_INVALID' });
  }
  return { ...request, fps, numFrames: frames };
}

/** Slice a project recording to the model's exact frame span, on a 48 kHz clock. */
export const prepareSourceAudioWindow = (args) => maintenance.run('media-input', 'Source audio window', () => prepareWindow(args), { continuation: true });

/** A linked track can select another recording without changing project fields. */
export async function assertCurrentSourceAudioWindow(project, audioConditioning) {
  const { resolveMasterAudioPath } = await import('../musicVideo/render.js');
  if (await sha256File(await resolveMasterAudioPath(project)) !== audioConditioning.sourceSha256) {
    throw new ServerError('The selected recording changed while supplied audio was prepared', { status: 409, code: 'MUSIC_VIDEO_AUDIO_SOURCE_CHANGED' });
  }
}

async function prepareWindow({ project, scene, numFrames, fps }) {
  const startSample = Math.round(scene?.startSec * 48000);
  const sampleCount = Math.round(((numFrames - 1) / fps) * 48000);
  if (!Number.isSafeInteger(startSample) || startSample < 0 || !Number.isSafeInteger(sampleCount)
    || sampleCount <= 0 || sampleCount > 48000 * 60
    || (Number.isFinite(scene?.endSec) && sampleCount / 48000 + 1 / 48000 < scene.endSec - scene.startSec)) {
    throw new ServerError('Supply a timed scene and a video window of at most 60 seconds', { status: 400, code: 'MUSIC_VIDEO_AUDIO_WINDOW_INVALID' });
  }
  const [{ resolveMasterAudioPath }, { findFfmpeg, runFfmpegProcess }] = await Promise.all([
    import('../musicVideo/render.js'), import('../../lib/ffmpeg.js'),
  ]);
  const { captureMusicVideoEvidence } = await import('../../lib/musicVideoDependencies.js');
  const audioDependencies = captureMusicVideoEvidence(project, { sceneIds: [], composition: false });
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
    return { audioFilePath, audioDependencies, songInterval: { startSec: scene.startSec, endSec: scene.endSec }, audioConditioning: { sourceSha256, clipSha256: await sha256File(audioFilePath),
      ...info, startSample, endSample } };
  } catch (error) {
    await discardSourceAudioWindow(audioFilePath);
    throw error;
  }
}
