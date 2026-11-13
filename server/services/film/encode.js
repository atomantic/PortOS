/**
 * ffmpeg encodes for a Blender film: one shot's frames into its `shot.mp4`,
 * and the video recipe every segment of a cut shares. All of them are H.264,
 * yuv420p, BT.709, constant frame rate with a keyframe at least every second
 * and no audio, so shot videos join by stream copy.
 */
import { copyFile, link, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BT709_CONTAINER_ARGS, H264_ENCODE_ARGS, bt709TagFilter, findFfmpeg, runFfmpegProcess } from '../../lib/ffmpeg.js';
import { blenderFrameName } from './renderIndex.js';
import { blenderRefusal } from './workspace.js';

const CRF = Object.freeze({ final: '18', preview: '21' });

/** ffmpeg, or a 503 naming what is missing. */
export async function requireFfmpeg() {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw blenderRefusal('ffmpeg is needed to turn rendered frames into video; install ffmpeg first', 'FFMPEG_MISSING', 503);
  return ffmpeg;
}

/** The shared video encoder arguments at `quality`'s rate factor. */
export function blenderVideoEncodeArgs({ fps, quality }) {
  const crfAt = H264_ENCODE_ARGS.indexOf('-crf') + 1;
  const codec = H264_ENCODE_ARGS.map((arg, index) => (index === crfAt ? CRF[quality] || CRF.final : arg));
  return ['-r', String(fps), '-g', String(fps), ...codec, ...BT709_CONTAINER_ARGS, '-an'];
}

/**
 * ffmpeg arguments that encode frames `[startFrame, startFrame + frameCount)`
 * of `pattern` (a `frame_%06d.jpg|png` path). Frames are full-range RGB (PNG)
 * or full-range JPEG; the video is limited-range BT.709. Pure.
 */
function blenderShotEncodeArgs({ pattern, startFrame, frameCount, fps, quality, tagFilter = null, output }) {
  return [
    '-hide_banner', '-loglevel', 'error',
    '-framerate', String(fps), '-start_number', String(startFrame), '-i', pattern,
    '-frames:v', String(frameCount),
    '-vf', ['scale=in_range=pc:out_range=tv:out_color_matrix=bt709', tagFilter].filter(Boolean).join(','),
    ...blenderVideoEncodeArgs({ fps, quality }),
    '-movflags', '+faststart', '-y', output,
  ];
}

/** Run one ffmpeg step; throws with ffmpeg's last lines when it fails. */
export async function runBlenderFfmpeg(ffmpeg, args, { signal, what }) {
  const result = await runFfmpegProcess({ bin: ffmpeg, args, signal });
  signal?.throwIfAborted();
  if (!result.ok) throw new Error(`${what} failed: ${result.reason}`);
}

/** Write a small JPEG of one rendered `frame` to `output`: the shot's picture in lists. */
export async function encodeBlenderPoster({ frame, output, signal }) {
  const ffmpeg = await requireFfmpeg();
  const partial = `${output}.part.jpg`;
  const args = ['-hide_banner', '-loglevel', 'error', '-i', frame, '-frames:v', '1',
    '-vf', 'scale=480:-2:flags=lanczos', '-q:v', '4', '-y', partial];
  await runBlenderFfmpeg(ffmpeg, args, { signal, what: 'Making the shot poster' }).catch(async (error) => {
    await rm(partial, { force: true });
    throw error;
  });
  await rename(partial, output);
}

// Hardlink across volumes, or a filesystem that has no links. Anything else is a real miss.
const LINK_REFUSED = new Set(['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);

async function placeLeadFrame(source, dest) {
  try {
    await link(source, dest);
  } catch (error) {
    if (!LINK_REFUSED.has(error?.code)) throw error;
    await copyFile(source, dest);
  }
}

/**
 * A lead-in body is entirely below frame 0, named `frame_mNNNNNN`, which image2
 * cannot read as a rising sequence. The concat demuxer is not a substitute: it
 * timestamps stills on a 25 fps grid, so 30 and 60 fps lead-ins drop and repeat
 * frames. Stage a 0-based sequence and encode it with the song shot's `-framerate`.
 * Links avoid copying up to 120 s of full-resolution frames.
 */
async function stageLeadFrames({ framesDir, startFrame, frameCount, quality, stageDir }) {
  if (!framesDir) throw new Error('A lead-in shot encode needs its frames directory');
  if (frameCount < 1) throw new Error('A lead-in shot encode needs at least one frame');
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });
  const ext = quality === 'preview' ? 'jpg' : 'png';
  for (let index = 0; index < frameCount; index += 1) {
    await placeLeadFrame(
      join(framesDir, blenderFrameName(startFrame + index, quality)),
      join(stageDir, `frame_${String(index).padStart(6, '0')}.${ext}`),
    );
  }
  return join(stageDir, `frame_%06d.${ext}`);
}

/** Tile `frames` into a JPEG contact sheet at `output` (`columns` wide). */
export async function encodeBlenderSheet({ frames, columns, listFile, output, signal }) {
  const ffmpeg = await requireFfmpeg();
  const rows = Math.ceil(frames.length / columns);
  const concatBody = `${frames.map((frame) => `file '${String(frame).replace(/'/g, "'\\''")}'`).join('\n')}\n`;
  await writeFile(listFile, concatBody);
  const partial = `${output}.part.jpg`;
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vf', `scale=320:-2:flags=lanczos,tile=${columns}x${rows}:margin=4:padding=4:color=black`,
    '-frames:v', '1', '-q:v', '3', '-y', partial,
  ];
  await runBlenderFfmpeg(ffmpeg, args, { signal, what: 'Tiling the contact sheet' }).catch(async (error) => {
    await rm(partial, { force: true });
    throw error;
  });
  await rename(partial, output);
}

/** Encode a shot's frames into `output`, replacing it only once the encode succeeded. */
export async function encodeBlenderShot({ pattern, startFrame, frameCount, fps, quality, output, signal, framesDir = null }) {
  const ffmpeg = await requireFfmpeg();
  const partial = `${output}.part.mp4`;
  const stageDir = startFrame < 0 ? `${partial}.frames` : null;
  const tagFilter = await bt709TagFilter();
  try {
    const args = startFrame < 0
      ? blenderShotEncodeArgs({
        pattern: await stageLeadFrames({ framesDir, startFrame, frameCount, quality, stageDir }),
        startFrame: 0, frameCount, fps, quality, tagFilter, output: partial,
      })
      : blenderShotEncodeArgs({ pattern, startFrame, frameCount, fps, quality, tagFilter, output: partial });
    await runBlenderFfmpeg(ffmpeg, args, { signal, what: 'Encoding the shot video' });
    await rename(partial, output);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  } finally {
    if (stageDir) await rm(stageDir, { recursive: true, force: true });
  }
}
