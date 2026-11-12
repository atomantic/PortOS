/**
 * ffmpeg encodes for a Blender film: one shot's frames into its `shot.mp4`,
 * and the video recipe every segment of a cut shares. All of them are H.264,
 * yuv420p, BT.709, constant frame rate with a keyframe at least every second
 * and no audio, so shot videos join by stream copy.
 */
import { rename, rm, writeFile } from 'node:fs/promises';
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

const quotedConcatPath = (file) => `file '${file.replaceAll("'", "'\\''")}'`;

/**
 * A lead-in body is entirely below frame 0. ffmpeg's image2 demuxer cannot read
 * the `m` prefix, and the absolute frame numbers count down as time moves forward,
 * so the frames are listed in play order instead of copied.
 */
async function leadShotEncodeArgs({ framesDir, startFrame, frameCount, fps, quality, tagFilter, list, output }) {
  if (!framesDir) throw new Error('A lead-in shot encode needs its frames directory');
  const duration = (1 / fps).toFixed(6);
  const lines = ['ffconcat version 1.0'];
  let last = null;
  for (let frame = startFrame; frame < startFrame + frameCount; frame += 1) {
    last = join(framesDir, blenderFrameName(frame, quality));
    lines.push(quotedConcatPath(last), `duration ${duration}`);
  }
  if (!last) throw new Error('A lead-in shot encode needs at least one frame');
  lines.push(quotedConcatPath(last));
  await writeFile(list, `${lines.join('\n')}\n`);
  return [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', list,
    '-frames:v', String(frameCount),
    '-vf', ['scale=in_range=pc:out_range=tv:out_color_matrix=bt709', tagFilter].filter(Boolean).join(','),
    ...blenderVideoEncodeArgs({ fps, quality }),
    '-movflags', '+faststart', '-y', output,
  ];
}

/** Encode a shot's frames into `output`, replacing it only once the encode succeeded. */
export async function encodeBlenderShot({ pattern, startFrame, frameCount, fps, quality, output, signal, framesDir = null }) {
  const ffmpeg = await requireFfmpeg();
  const partial = `${output}.part.mp4`;
  const list = startFrame < 0 ? `${partial}.frames.txt` : null;
  const tagFilter = await bt709TagFilter();
  const args = startFrame < 0
    ? await leadShotEncodeArgs({ framesDir, startFrame, frameCount, fps, quality, tagFilter, list, output: partial })
    : blenderShotEncodeArgs({ pattern, startFrame, frameCount, fps, quality, tagFilter, output: partial });
  try {
    await runBlenderFfmpeg(ffmpeg, args, { signal, what: 'Encoding the shot video' });
    await rename(partial, output);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  } finally {
    if (list) await rm(list, { force: true });
  }
}
