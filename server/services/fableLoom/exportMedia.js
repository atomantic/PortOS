import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { execFile } from '../../lib/childProcess.js';
import { safeChildProcessOptions } from '../../lib/processEnv.js';
import { findFfmpeg, findFfprobe, runFfmpegProcess } from '../../lib/ffmpeg.js';
import { atomicWrite } from '../../lib/fileCore.js';
import { isPathInsideDir } from '../../lib/pathSafety.js';
import { FABLELOOM_EXPORT_LIMITS } from '../../lib/fableLoomExport.js';
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
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
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

async function probe(path) {
  const bin = await findFfprobe();
  if (!bin) throw refusal('EXPORT_FFMPEG_REQUIRED', 'Install ffmpeg and ffprobe before exporting video.');
  const { stdout } = await execFileAsync(bin, [
    '-v', 'error', '-protocol_whitelist', 'file', '-f', 'mov', '-i', path,
    '-show_entries', 'stream=codec_type,codec_name,pix_fmt:format=duration', '-of', 'json',
  ], safeChildProcessOptions({ timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 }));
  const result = JSON.parse(stdout);
  const video = result.streams?.filter(s => s.codec_type === 'video') || [];
  const audio = result.streams?.filter(s => s.codec_type === 'audio') || [];
  if (video.length !== 1 || video[0].codec_name !== 'h264' || video[0].pix_fmt !== 'yuv420p'
    || audio.length > 1 || audio.some(s => s.codec_name !== 'aac')) {
    throw refusal('EXPORT_ENCODING_UNSUPPORTED', 'Source profile requires one H.264 yuv420p video stream and optional AAC audio. Transcode profiles are not available yet.');
  }
  const durationMs = Math.round(Number(result.format?.duration) * 1000);
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw refusal('EXPORT_MEDIA_INVALID', 'Video duration could not be verified.');
  }
  return durationMs;
}

/** Remove metadata without generating media or changing video/audio encodes. */
export async function prepareFableLoomExportMedia(bytes, kind, directory) {
  if (kind === 'image') {
    const image = sharp(bytes, { limitInputPixels: 16 * 1024 * 1024 });
    const metadata = await image.metadata();
    if (!['png', 'jpeg', 'webp'].includes(metadata.format) || (metadata.pages || 1) !== 1) {
      throw refusal('EXPORT_ENCODING_UNSUPPORTED', 'Stills must be non-animated PNG, JPEG or WebP images.');
    }
    return { bytes: await image.rotate().png({ compressionLevel: 9 }).toBuffer(), extension: 'png', durationMs: 0 };
  }
  const input = join(directory, 'input.mp4');
  const output = join(directory, 'clean.mp4');
  await atomicWrite(input, bytes);
  await probe(input);
  const bin = await findFfmpeg();
  if (!bin) throw refusal('EXPORT_FFMPEG_REQUIRED', 'Install ffmpeg and ffprobe before exporting video.');
  const result = await runFfmpegProcess({ bin, timeoutMs: 60_000, args: [
    '-nostdin', '-y', '-v', 'error', '-protocol_whitelist', 'file', '-f', 'mov', '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1', '-map_metadata:s', '-1',
    '-map_chapters', '-1', '-c', 'copy', '-bsf:v', 'filter_units=remove_types=6',
    '-fflags', '+bitexact', '-movflags', '+faststart', output,
  ] });
  if (!result.ok) throw refusal('EXPORT_MEDIA_INVALID', 'Video metadata removal failed. Check the source clip and try again.');
  const outputInfo = await stat(output);
  if (outputInfo.size > FABLELOOM_EXPORT_LIMITS.maxAssetBytes) {
    throw refusal('EXPORT_MEDIA_SIZE', 'Prepared media exceeds the 64 MiB asset limit.');
  }
  return { bytes: await readFableLoomExportSource(directory, 'clean.mp4'), extension: 'mp4', durationMs: await probe(output) };
}
