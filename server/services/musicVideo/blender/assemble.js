/**
 * Joins a Blender film's shot videos into one video with the master song
 * under it: a work-in-progress cut, the final render, or an excerpt window.
 *
 * Each segment is a span of frames: a whole shot video used as it is, a shot
 * video that has to be conformed first (another size or rate, or only part of
 * it), or black frames where a shot has no video yet. Conformed and black
 * segments are encoded with the shot recipe, so everything joins by stream
 * copy; the joined picture is re-encoded only when something has to be painted
 * over it: a finishing filter (the grade or a scene's timed effects) or overlay
 * clips (the title card).
 */
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AAC_ENCODE_ARGS, bt709TagFilter } from '../../../lib/ffmpeg.js';
import { blenderVideoEncodeArgs, requireFfmpeg, runBlenderFfmpeg } from './encode.js';

const QUIET = ['-hide_banner', '-loglevel', 'error'];

/** ffmpeg arguments for `frames` black frames. Pure. */
function blenderBlackSegmentArgs({ frames, width, height, fps, quality, tagFilter = null, output }) {
  return [...QUIET, '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=${fps}`, '-frames:v', String(frames),
    ...(tagFilter ? ['-vf', tagFilter] : []), ...blenderVideoEncodeArgs({ fps, quality }), '-y', output];
}

/**
 * ffmpeg arguments that cut `frames` frames from `offsetFrames` of `source`
 * and fit them to the target frame (letterboxed, never stretched), holding the
 * last frame when the source runs short. Pure.
 */
function blenderConformSegmentArgs({ source, offsetFrames, frames, width, height, fps, quality, tagFilter = null, output }) {
  const chain = [
    `trim=start_frame=${offsetFrames}:end_frame=${offsetFrames + frames}`, 'setpts=PTS-STARTPTS',
    `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`, 'setsar=1', `fps=${fps}`, `tpad=stop_mode=clone:stop=${frames}`, tagFilter,
  ].filter(Boolean).join(',');
  return [...QUIET, '-i', source, '-vf', chain, '-frames:v', String(frames), ...blenderVideoEncodeArgs({ fps, quality }), '-y', output];
}

/** ffmpeg arguments that lay `durationSec` of the song from `startSec` under `video`. Pure. */
function blenderSongMuxArgs({ video, audioPath, startSec, durationSec, output }) {
  const song = `[1:a]atrim=start=${startSec}:end=${startSec + durationSec},asetpts=PTS-STARTPTS,aresample=48000,`
    + `aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${durationSec}[a]`;
  return [...QUIET, '-i', video, '-i', audioPath, '-filter_complex', song, '-map', '0:v:0', '-map', '[a]',
    '-c:v', 'copy', ...AAC_ENCODE_ARGS, '-t', String(durationSec), '-movflags', '+faststart', '-y', output];
}

/**
 * ffmpeg arguments that paint `filter` over `joined` and lay each of `overlays`
 * (`{ path, startSec }` alpha clips, seconds from the first frame) on top, in
 * the shot videos' own BT.709. Pure.
 */
function blenderFinishArgs({ joined, filter = null, overlays = [], fps, quality, tagFilter = null, output }) {
  const steps = [];
  // The grade works in RGB; return to the shot videos' own BT.709 before anything is laid over it.
  if (filter) steps.push({ inputs: [], chain: `${filter},scale=out_color_matrix=bt709:out_range=tv,format=yuv420p` });
  overlays.forEach((_, index) => steps.push({
    // Converted with the picture's matrix, so the card's colors do not drift on the way in.
    prepare: `[${index + 1}:v]scale=out_color_matrix=bt709:out_range=tv,format=yuva420p[c${index}]`,
    inputs: [`c${index}`], chain: 'overlay=eof_action=pass:format=yuv420',
  }));
  const graph = [];
  let picture = '0:v';
  steps.forEach((step, index) => {
    const last = index === steps.length - 1;
    const out = last ? 'v' : `p${index}`;
    if (step.prepare) graph.push(step.prepare);
    graph.push(`${[picture, ...step.inputs].map((label) => `[${label}]`).join('')}${[step.chain, last ? tagFilter : null].filter(Boolean).join(',')}[${out}]`);
    picture = out;
  });
  return [...QUIET, '-i', joined, ...overlays.flatMap((overlay) => ['-itsoffset', String(Number(overlay.startSec.toFixed(6))), '-i', overlay.path]),
    '-filter_complex', graph.join(';'), '-map', '[v]', ...blenderVideoEncodeArgs({ fps, quality }), '-y', output];
}

/**
 * Assemble `segments` (`{ source, offsetFrames, frames, direct }`, in film
 * order; `source: null` is black) into `output` at `width`x`height`, `fps`,
 * with the song from `audio.startSec`. `filter` and `overlays` are painted
 * over the joined picture (blenderFinishArgs). `scratch` is a folder this call
 * owns and removes. `onProgress(fraction)` reports coarse progress.
 */
export async function assembleBlenderVideo({ segments, width, height, fps, quality = 'final', filter = null, overlays = [], audio, output, scratch, signal, onProgress = () => {} }) {
  const ffmpeg = await requireFfmpeg();
  const tagFilter = await bt709TagFilter();
  const totalFrames = segments.reduce((sum, segment) => sum + segment.frames, 0);
  const durationSec = totalFrames / fps;
  const prepared = segments.filter((segment) => !segment.direct).length;
  const painted = Boolean(filter) || overlays.length > 0;
  const steps = prepared + 2 + (painted ? 1 : 0);
  let done = 0;
  const step = () => onProgress(Math.min(1, (done += 1) / steps));
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });
  const run = (args, what) => runBlenderFfmpeg(ffmpeg, args, { signal, what });
  const assemble = async () => {
    const black = new Map();
    const parts = [];
    for (const [index, segment] of segments.entries()) {
      if (segment.direct) { parts.push(segment.source); continue; }
      const target = { frames: segment.frames, width, height, fps, quality, tagFilter };
      if (!segment.source) {
        // Black is the same for every shot of one length: encode it once.
        if (!black.has(segment.frames)) {
          const path = join(scratch, `black-${segment.frames}.mp4`);
          await run(blenderBlackSegmentArgs({ ...target, output: path }), 'Making black frames for a shot without video');
          black.set(segment.frames, path);
        }
        parts.push(black.get(segment.frames));
      } else {
        const path = join(scratch, `segment-${index}.mp4`);
        await run(blenderConformSegmentArgs({ ...target, source: segment.source, offsetFrames: segment.offsetFrames || 0, output: path }), 'Fitting a shot video to the cut');
        parts.push(path);
      }
      step();
    }
    const list = join(scratch, 'segments.txt');
    await writeFile(list, parts.map((path) => `file '${path.replaceAll("'", "'\\''")}'`).join('\n'));
    const joined = join(scratch, 'joined.mp4');
    await run([...QUIET, '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-y', joined], 'Joining the shot videos');
    step();
    let picture = joined;
    if (painted) {
      picture = join(scratch, 'finished.mp4');
      await run(blenderFinishArgs({ joined, filter, overlays, fps, quality, tagFilter, output: picture }), 'Painting the grade, shot effects and title card');
      step();
    }
    const partial = `${output}.part.mp4`;
    await run(blenderSongMuxArgs({ video: picture, audioPath: audio.path, startSec: audio.startSec || 0, durationSec, output: partial }), 'Laying the song under the picture')
      .catch(async (error) => { await rm(partial, { force: true }); throw error; });
    await rename(partial, output);
    step();
    return { durationSec, frames: totalFrames };
  };
  return assemble().finally(() => rm(scratch, { recursive: true, force: true }));
}
