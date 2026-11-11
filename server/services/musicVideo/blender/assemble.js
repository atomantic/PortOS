/**
 * Joins a Blender film's shot videos into one video with the master song
 * under it: a work-in-progress cut, the final render, or an excerpt window.
 *
 * Each segment is a span of frames: a whole shot video used as it is, a shot
 * video that has to be conformed first (another size or rate, or only part of
 * it), or black frames where a shot has no video yet. Conformed and black
 * segments are encoded with the shot recipe, so everything joins by stream
 * copy; the joined picture is re-encoded only when a finishing filter (the
 * grade or a scene's timed effects) has to be painted over it.
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
 * Assemble `segments` (`{ source, offsetFrames, frames, direct }`, in film
 * order; `source: null` is black) into `output` at `width`x`height`, `fps`,
 * with the song from `audio.startSec`. `scratch` is a folder this call owns
 * and removes. `onProgress(fraction)` reports coarse progress.
 */
export async function assembleBlenderVideo({ segments, width, height, fps, quality = 'final', filter = null, audio, output, scratch, signal, onProgress = () => {} }) {
  const ffmpeg = await requireFfmpeg();
  const tagFilter = await bt709TagFilter();
  const totalFrames = segments.reduce((sum, segment) => sum + segment.frames, 0);
  const durationSec = totalFrames / fps;
  const prepared = segments.filter((segment) => !segment.direct).length;
  const steps = prepared + 2 + (filter ? 1 : 0);
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
    if (filter) {
      picture = join(scratch, 'finished.mp4');
      // The grade works in RGB; return to the shot videos' own BT.709 before encoding.
      const chain = [filter, 'scale=out_color_matrix=bt709:out_range=tv', 'format=yuv420p', tagFilter].filter(Boolean).join(',');
      await run([...QUIET, '-i', joined, '-filter_complex', `[0:v]${chain}[v]`, '-map', '[v]',
        ...blenderVideoEncodeArgs({ fps, quality }), '-y', picture], 'Painting the grade and shot effects');
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
