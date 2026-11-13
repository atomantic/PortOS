/**
 * ffmpeg encodes for a Blender film: one shot's frames into its `shot.mp4`,
 * and the video recipe every segment of a cut shares. All of them are H.264,
 * yuv420p, BT.709, constant frame rate with a keyframe at least every second
 * and no audio, so shot videos join by stream copy.
 */
import { rename, rm, writeFile } from 'node:fs/promises';
import { BT709_CONTAINER_ARGS, H264_ENCODE_ARGS, bt709TagFilter, findFfmpeg, runFfmpegProcess } from '../../lib/ffmpeg.js';
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

const RANGE = 'scale=in_range=pc:out_range=tv:out_color_matrix=bt709';
// ffmpeg's blend name for a film layer. `normal` is an overlay so the layer's alpha shows.
const LAYER_BLEND = Object.freeze({ normal: null, screen: 'screen', add: 'addition', multiply: 'multiply' });

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
    '-vf', [RANGE, tagFilter].filter(Boolean).join(','),
    ...blenderVideoEncodeArgs({ fps, quality }),
    '-movflags', '+faststart', '-y', output,
  ];
}

/**
 * Lay `top` on `bottom`. `normal` (no blend) is an alpha overlay. A blend mode
 * mixes the colors, then the result is overlaid with the layer's own alpha:
 * ffmpeg's blend filter does not treat alpha as coverage, so a transparent
 * pixel would otherwise recolor the plate. Labels may each be read once.
 */
const stackPair = (bottom, top, blend, out, serial) => {
  if (!blend) return `[${bottom}][${top}]overlay=format=auto:shortest=1[${out}]`;
  const base = `b${serial}`;
  const again = `d${serial}`;
  const color = `c${serial}`;
  const mask = `k${serial}`;
  return [
    `[${bottom}]split[${base}][${again}]`,
    `[${top}]split[${color}][${mask}]`,
    `[${mask}]alphaextract[${mask}a]`,
    `[${base}][${color}]blend=all_mode=${blend}:shortest=1[x${serial}]`,
    `[x${serial}][${mask}a]alphamerge[y${serial}]`,
    `[${again}][y${serial}]overlay=format=auto:shortest=1[${out}]`,
  ].join(';');
};

/**
 * filter_complex that paints `layers` ({ place, blend }, in declaration order,
 * inputs 1..n) onto the plate (input 0). Unders are the bottom plate, then the
 * shot, then overs. A Blender plate is opaque, so an `under` layer stays hidden
 * until the plate itself has alpha. Pure.
 */
function blenderLayerFilter(layers, tagFilter = null) {
  const parts = ['[0:v]format=rgba[in0]'];
  layers.forEach((_, index) => parts.push(`[${index + 1}:v]format=rgba[in${index + 1}]`));
  const unders = [];
  const overs = [];
  layers.forEach((layer, index) => (layer.place === 'under' ? unders : overs).push({ blend: LAYER_BLEND[layer.blend] ?? null, input: index + 1 }));
  let current = 'in0';
  let serial = 0;
  if (unders.length) {
    current = `in${unders[0].input}`;
    for (const layer of unders.slice(1)) {
      const out = `u${serial}`;
      serial += 1;
      parts.push(stackPair(current, `in${layer.input}`, layer.blend, out, serial));
      current = out;
    }
    const plate = `plate${serial}`;
    serial += 1;
    parts.push(stackPair(current, 'in0', null, plate, serial));
    current = plate;
  }
  for (const layer of overs) {
    const out = `o${serial}`;
    serial += 1;
    parts.push(stackPair(current, `in${layer.input}`, layer.blend, out, serial));
    current = out;
  }
  parts.push(`[${current}]${[RANGE, tagFilter].filter(Boolean).join(',')}[out]`);
  return parts.join(';');
}

function blenderLayeredEncodeArgs({ pattern, layers, startFrame, frameCount, fps, quality, tagFilter = null, output }) {
  const inputs = ['-framerate', String(fps), '-start_number', String(startFrame), '-i', pattern];
  for (const layer of layers) inputs.push('-framerate', String(fps), '-start_number', String(startFrame), '-i', layer.pattern);
  return [
    '-hide_banner', '-loglevel', 'error', ...inputs,
    '-filter_complex', blenderLayerFilter(layers, tagFilter),
    '-map', '[out]', '-frames:v', String(frameCount),
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
export async function encodeBlenderShot({ pattern, startFrame, frameCount, fps, quality, output, signal, layers = null }) {
  const ffmpeg = await requireFfmpeg();
  const partial = `${output}.part.mp4`;
  const tagFilter = await bt709TagFilter();
  const args = layers?.length
    ? blenderLayeredEncodeArgs({ pattern, layers, startFrame, frameCount, fps, quality, tagFilter, output: partial })
    : blenderShotEncodeArgs({ pattern, startFrame, frameCount, fps, quality, tagFilter, output: partial });
  const encoded = await runBlenderFfmpeg(ffmpeg, args, { signal, what: 'Encoding the shot video' }).then(() => true, async (error) => {
    await rm(partial, { force: true });
    throw error;
  });
  if (encoded) await rename(partial, output);
}
