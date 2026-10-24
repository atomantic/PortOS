import { constants } from 'node:fs';
import { open, readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { execFile } from '../../lib/childProcess.js';
import { safeChildProcessOptions } from '../../lib/processEnv.js';
import { findFfmpeg, findFfprobe, runFfmpegProcess } from '../../lib/ffmpeg.js';
import { atomicWrite } from '../../lib/fileCore.js';
import { isPathInsideDir } from '../../lib/pathSafety.js';
import { FABLELOOM_EXPORT_LIMITS } from '../../lib/fableLoomExport.js';
import { FABLELOOM_MEDIA_PROFILES } from '../../lib/fableLoomMediaProfiles.js';
import { ServerError } from '../../lib/errorHandler.js';

const execFileAsync = promisify(execFile);
const refusal = (code, message) => new ServerError(message, { status: 422, code });

/** Snapshot bounded bytes from a regular file in one approved media root. */
export async function readFableLoomExportSource(root, filename) {
  if (typeof filename !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.(png|jpg|jpeg|webp|mp4)$/i.test(filename)) {
    throw refusal('EXPORT_MEDIA_PATH', 'Media must be a local gallery or video basename.');
  }
  const base = await realpath(root);
  const path = await realpath(join(base, filename));
  if (!isPathInsideDir(base, path)) throw refusal('EXPORT_MEDIA_PATH', 'Media resolves outside its approved root.');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > FABLELOOM_EXPORT_LIMITS.maxAssetBytes) {
      throw refusal('EXPORT_MEDIA_SIZE', 'Media is empty, not a regular file, or exceeds the 64 MiB asset limit.');
    }
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== before.size || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw refusal('EXPORT_MEDIA_CHANGED', 'Media changed while taking the export snapshot. Start a new export.');
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

export function checkExportCancelled(signal) {
  if (signal?.aborted) throw refusal('EXPORT_CANCELLED', 'Export cancelled. Start a new export when ready.');
}

async function probe(path, format = 'mov') {
  const bin = await findFfprobe();
  if (!bin) throw refusal('EXPORT_FFMPEG_REQUIRED', 'Install ffmpeg and ffprobe before exporting video.');
  const { stdout } = await execFileAsync(bin, [
    '-v', 'error', '-protocol_whitelist', 'file', '-f', format, '-i', path,
    '-show_entries', 'stream=codec_type,codec_name,pix_fmt,width,height,start_time,duration:format=duration', '-of', 'json',
  ], safeChildProcessOptions({ timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 }));
  const result = JSON.parse(stdout);
  const video = result.streams?.filter(s => s.codec_type === 'video') || [];
  const audio = result.streams?.filter(s => s.codec_type === 'audio') || [];
  if (video.length !== 1 || audio.length > 1
    || !Number.isSafeInteger(video[0].width * video[0].height) || video[0].width * video[0].height > 16 * 1024 * 1024) {
    throw refusal('EXPORT_MEDIA_INVALID', 'Video must have one bounded picture stream, optional audio and a valid duration.');
  }
  // MP4 container duration can include discarded subtitles/data. Only retained
  // picture/audio timelines determine clip length. WebM output has no extra tracks
  // but may omit stream durations, so its own container is a safe fallback.
  for (const stream of [...video, ...audio]) {
    const seconds = stream.duration === undefined && format === 'matroska'
      ? Number(result.format?.duration) : Number(stream.duration);
    stream.durationMs = Math.round((seconds + Math.max(0, Number(stream.start_time) || 0)) * 1000);
    if (!Number.isSafeInteger(stream.durationMs) || stream.durationMs <= 0) {
      throw refusal('EXPORT_MEDIA_INVALID', 'Retained video/audio duration could not be verified.');
    }
  }
  return { video: video[0], audio: audio[0], durationMs: Math.max(...[...video, ...audio].map(s => s.durationMs)) };
}

export async function fableLoomExportEncoder(kind) {
  const image = { sharp: sharp.versions.sharp, vips: sharp.versions.vips,
    imageBuildHash: createHash('sha256').update(JSON.stringify(sharp.versions)).digest('hex') };
  if (kind === 'image') return image;
  const bin = await findFfmpeg();
  if (!bin) throw refusal('EXPORT_FFMPEG_REQUIRED', 'Install ffmpeg and ffprobe before exporting video.');
  const { stdout } = await execFileAsync(bin, ['-version'], safeChildProcessOptions({ timeout: 10_000, maxBuffer: 64 * 1024 }));
  return { ffmpeg: stdout.match(/^ffmpeg version ([A-Za-z0-9._-]+)/)?.[1] || 'unknown',
    buildHash: createHash('sha256').update(stdout).digest('hex'), ...image };
}

async function encode(bin, args, signal, capture = false) {
  checkExportCancelled(signal);
  const result = await runFfmpegProcess({ bin, args: ['-nostdin', '-y', ...args], signal,
    timeoutMs: 120_000, returnStderr: capture, stderrTailBytes: capture ? 8192 : 2000 });
  checkExportCancelled(signal);
  if (!result.ok) throw refusal('EXPORT_TRANSCODE_FAILED', 'Media encoding failed or timed out. Check the source clip and ffmpeg support.');
  return result.stderr;
}

const loudness = profile => `loudnorm=I=${profile.integratedLufs}:TP=${profile.truePeakDb}:LRA=${profile.loudnessRange}`;
async function audioFilter(bin, inputArgs, profile, signal) {
  const stderr = await encode(bin, ['-v', 'info', ...inputArgs, '-vn', '-af', `${loudness(profile)}:print_format=json`, '-f', 'null', '-'], signal, true);
  const measurement = JSON.parse(stderr.slice(stderr.lastIndexOf('{'), stderr.lastIndexOf('}') + 1));
  // Applying loudnorm to digital silence can emit non-finite samples into AAC.
  if (measurement.input_i === '-inf' && measurement.input_tp === '-inf') return null;
  // Short SFX may never fill loudnorm's 400 ms window. Peak normalization
  // preserves their samples/timing without padding them to invent a LUFS value.
  if (measurement.input_i === '-inf' && Number.isFinite(Number(measurement.input_tp))) {
    return `volume=${profile.truePeakDb - Number(measurement.input_tp)}dB`;
  }
  const values = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'].map(k => Number(measurement[k]));
  if (!values.every(Number.isFinite)) throw refusal('EXPORT_MEDIA_INVALID', 'Audio loudness could not be measured.');
  return `${loudness(profile)}:measured_I=${values[0]}:measured_TP=${values[1]}:measured_LRA=${values[2]}:measured_thresh=${values[3]}:offset=${values[4]}:linear=true`;
}

/** Only prepared files use this extension set; authored video remains local MP4. */
async function outputBytes(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0 || info.size >= FABLELOOM_EXPORT_LIMITS.maxAssetBytes) {
    throw refusal('EXPORT_MEDIA_SIZE', 'Prepared media reached the 64 MiB asset limit. Use a smaller profile or clip.');
  }
  return readFile(path);
}

/** Transcode existing authored media only; never calls a generation provider. */
export async function prepareFableLoomExportMedia(bytes, kind, directory, options = {}) {
  const profile = FABLELOOM_MEDIA_PROFILES[options.mediaProfile ?? 'source'];
  const { signal } = options;
  if (!profile || (profile.id === 'source' && options.includeWebm)) {
    throw refusal('EXPORT_OPTION_UNSUPPORTED', 'Choose a web profile to include WebM.');
  }
  checkExportCancelled(signal);
  if (kind === 'image') {
    const image = sharp(bytes, { limitInputPixels: 16 * 1024 * 1024 });
    const metadata = await image.metadata();
    if (!['png', 'jpeg', 'webp'].includes(metadata.format) || (metadata.pages || 1) !== 1) {
      throw refusal('EXPORT_ENCODING_UNSUPPORTED', 'Stills must be non-animated PNG, JPEG or WebP images.');
    }
    image.rotate();
    if (profile.width) image.resize({ width: profile.width, height: profile.height, fit: 'inside', withoutEnlargement: true });
    const output = await image.png({ compressionLevel: 9 }).toBuffer();
    checkExportCancelled(signal);
    return { bytes: output, extension: 'png', durationMs: 0 };
  }
  const input = join(directory, 'input.mp4');
  const output = join(directory, 'clean.mp4');
  await atomicWrite(input, bytes);
  const source = await probe(input);
  const bin = await findFfmpeg();
  if (!bin) throw refusal('EXPORT_FFMPEG_REQUIRED', 'Install ffmpeg and ffprobe before exporting video.');
  const inputArgs = ['-protocol_whitelist', 'file', '-f', 'mov', '-i', input];
  const metadataArgs = ['-map_metadata', '-1', '-map_metadata:s', '-1', '-map_chapters', '-1'];
  const common = ['-v', 'error', ...inputArgs, '-map', '0:v:0', '-map', '0:a:0?', ...metadataArgs];
  let encoding;
  let filter;
  if (profile.id === 'source') {
    if (source.video.codec_name !== 'h264' || source.video.pix_fmt !== 'yuv420p' || (source.audio && source.audio.codec_name !== 'aac')) {
      throw refusal('EXPORT_ENCODING_UNSUPPORTED', 'Source profile requires H.264 yuv420p with optional AAC. Choose a web profile to transcode.');
    }
    encoding = ['-c', 'copy'];
  } else {
    filter = source.audio ? await audioFilter(bin, inputArgs, profile, signal) : null;
    const scale = `scale=w='min(iw,${profile.width})':h='min(ih,${profile.height})':force_original_aspect_ratio=decrease:force_divisible_by=2`;
    encoding = ['-vf', scale, '-fpsmax', String(profile.fps), '-c:v', 'libx264', '-preset', 'medium',
      '-pix_fmt', 'yuv420p', '-b:v', `${profile.videoKbps}k`, '-maxrate', `${profile.videoKbps}k`, '-bufsize', `${profile.videoKbps * 2}k`,
      '-threads', '1', '-c:a', 'aac', '-b:a', `${profile.audioKbps}k`, '-ar', '48000',
      ...(filter ? ['-af', filter] : []), '-t', String(source.durationMs / 1000)];
  }
  await encode(bin, [...common, ...encoding, '-bsf:v', 'filter_units=remove_types=6',
    '-fflags', '+bitexact', '-movflags', '+faststart', '-fs', String(FABLELOOM_EXPORT_LIMITS.maxAssetBytes), output], signal);
  const encoded = await probe(output);
  if (['video', 'audio'].some(kind => source[kind] && (!encoded[kind] || encoded[kind].durationMs < source[kind].durationMs - 1))) throw refusal('EXPORT_MEDIA_SIZE', 'Encoding truncated the clip. Use a smaller profile or shorter clip.');
  const result = { bytes: await outputBytes(output), extension: 'mp4', durationMs: encoded.durationMs };
  if (profile.id !== 'source') {
    const poster = join(directory, 'poster.png');
    await encode(bin, ['-v', 'error', '-protocol_whitelist', 'file', '-i', output,
      '-frames:v', '1', ...metadataArgs, '-threads', '1', poster], signal);
    result.poster = { bytes: await outputBytes(poster), extension: 'png', durationMs: 0 };
    if (options.includeWebm) {
      const webm = join(directory, 'clean.webm');
      // Encode from the prepared MP4 so audio and picture timing share the primary representation.
      await encode(bin, ['-v', 'error', '-protocol_whitelist', 'file', '-i', output,
        '-map', '0:v:0', '-map', '0:a:0?', ...metadataArgs, '-c:v', 'libvpx-vp9', '-threads', '1',
        '-b:v', `${profile.videoKbps}k`, '-maxrate', `${profile.videoKbps}k`, '-bufsize', `${profile.videoKbps * 2}k`,
        '-c:a', 'libopus', '-b:a', `${profile.audioKbps}k`, '-fflags', '+bitexact',
        '-fs', String(FABLELOOM_EXPORT_LIMITS.maxAssetBytes), webm], signal);
      const alternate = await probe(webm, 'matroska');
      if (alternate.durationMs < source.durationMs - 1) throw refusal('EXPORT_MEDIA_SIZE', 'WebM encoding truncated the clip.');
      result.webm = { bytes: await outputBytes(webm), extension: 'webm', durationMs: alternate.durationMs };
    }
  }
  checkExportCancelled(signal);
  return result;
}
