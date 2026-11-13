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
import { copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AAC_ENCODE_ARGS, bt709TagFilter } from '../../lib/ffmpeg.js';
import { blenderVideoEncodeArgs, requireFfmpeg, runBlenderFfmpeg } from './encode.js';
import { blenderHandleFrameName } from './renderIndex.js';

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
    `fps=${fps}`, `trim=start_frame=${offsetFrames}:end_frame=${offsetFrames + frames}`, 'setpts=PTS-STARTPTS',
    `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`, 'setsar=1', `tpad=stop_mode=clone:stop=${frames}`, tagFilter,
  ].filter(Boolean).join(',');
  return [...QUIET, '-i', source, '-vf', chain, '-frames:v', String(frames), ...blenderVideoEncodeArgs({ fps, quality }), '-y', output];
}

/**
 * ffmpeg arguments that render a `dissolve` or `beat-toggle` transition
 * segment by blending outgoing and incoming shot/handle streams across the cut. Pure.
 */
function blenderTransitionSegmentArgs({ transition, width, height, fps, quality, tagFilter = null, output }) {
  const inputs = [];
  const graph = [];
  let nextInput = 0;
  const fit = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    'setsar=1',
    'scale=out_color_matrix=bt709:out_range=tv',
    'format=yuv420p',
  ].join(',');
  const buildSide = (side, sideLabel, videoFirst) => {
    const parts = [];
    const addVideo = (tag) => {
      if (!(side.videoFrames > 0)) return;
      const idx = nextInput++;
      inputs.push('-i', side.video);
      graph.push(`[${idx}:v]fps=${fps},trim=start_frame=${side.videoOffset}:end_frame=${side.videoOffset + side.videoFrames},setpts=PTS-STARTPTS,${fit},tpad=stop_mode=clone:stop=${side.videoFrames},trim=end_frame=${side.videoFrames}[${tag}]`);
      parts.push(tag);
    };
    const addHandle = (tag) => {
      if (!(side.handleFrames > 0)) return;
      const idx = nextInput++;
      inputs.push('-framerate', String(fps), '-start_number', String(side.handleStart), '-i', side.handlePattern);
      graph.push(`[${idx}:v]trim=start_frame=0:end_frame=${side.handleFrames},setpts=PTS-STARTPTS,${fit},fps=${fps}[${tag}]`);
      parts.push(tag);
    };
    if (videoFirst) { addVideo(`${sideLabel}0`); addHandle(`${sideLabel}1`); }
    else { addHandle(`${sideLabel}0`); addVideo(`${sideLabel}1`); }
    if (parts.length === 2) graph.push(`[${parts[0]}][${parts[1]}]concat=n=2:v=1:a=0[${sideLabel}]`);
    else if (parts.length === 1) graph.push(`[${parts[0]}]null[${sideLabel}]`);
  };
  buildSide(transition.outgoing, 'a', true);
  buildSide(transition.incoming, 'b', false);
  const segFrames = transition.segEndFrame - transition.segStartFrame;
  let expr;
  if (transition.style === 'dissolve') {
    const total = transition.windowEndFrame - transition.windowStartFrame;
    const offset = transition.segStartFrame - transition.windowStartFrame;
    expr = `A*(1-(N+1+${offset})/(${total}+1))+B*((N+1+${offset})/(${total}+1))`;
  } else {
    const cond = (transition.incomingSpans || []).map(([start, end]) => `between(N,${start},${end - 1})`).join('+') || '0';
    expr = `if(${cond},B,A)`;
  }
  graph.push(`[a][b]blend=all_expr='${expr}'${tagFilter ? `,${tagFilter}` : ''}[v]`);
  return [...QUIET, ...inputs, '-filter_complex', graph.join(';'), '-map', '[v]', '-frames:v', String(segFrames),
    ...blenderVideoEncodeArgs({ fps, quality }), '-y', output];
}

/** ffmpeg arguments that lay the song under `video`. A lead-in plays its own sound first, then the song. */
function blenderSongMuxArgs({ video, audioPath, startSec, durationSec, leadSec = 0, leadPath = null, output }) {
  const lead = Number(leadSec) > 0 ? Number(leadSec) : 0;
  if (!lead) {
    const song = `[1:a]atrim=start=${startSec}:end=${startSec + durationSec},asetpts=PTS-STARTPTS,aresample=48000,`
      + `aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${durationSec}[a]`;
    return [...QUIET, '-i', video, '-i', audioPath, '-filter_complex', song, '-map', '0:v:0', '-map', '[a]',
      '-c:v', 'copy', ...AAC_ENCODE_ARGS, '-t', String(durationSec), '-movflags', '+faststart', '-y', output];
  }
  const songDur = Math.max(0, durationSec - lead);
  const songTrim = `atrim=start=${startSec}:end=${startSec + songDur},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo`;
  if (leadPath) {
    const graph = `[1:a]atrim=end=${lead},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${lead}[lead];`
      + `[2:a]${songTrim}[song];[lead][song]concat=n=2:v=0:a=1,apad=whole_dur=${durationSec}[a]`;
    return [...QUIET, '-i', video, '-i', leadPath, '-i', audioPath, '-filter_complex', graph, '-map', '0:v:0', '-map', '[a]',
      '-c:v', 'copy', ...AAC_ENCODE_ARGS, '-t', String(durationSec), '-movflags', '+faststart', '-y', output];
  }
  // A film with no cold-open mix keeps the lead-in silent, then the timeline audio.
  const delay = Math.round(lead * 1000);
  const graph = `[1:a]${songTrim},adelay=${delay}|${delay},apad=whole_dur=${durationSec}[a]`;
  return [...QUIET, '-i', video, '-i', audioPath, '-filter_complex', graph, '-map', '0:v:0', '-map', '[a]',
    '-c:v', 'copy', ...AAC_ENCODE_ARGS, '-t', String(durationSec), '-movflags', '+faststart', '-y', output];
}

/**
 * image2 counts up from `-start_number`. A handle that begins below 0 (or crosses 0)
 * is staged as a 0-based sequence so the transition graph stays the one used for song handles.
 */
async function stagedHandleSide(side, kind, quality, scratch, tag) {
  if (!(side?.handleFrames > 0) || !side.handlePattern || !(side.handleStart < 0)) return side;
  const ext = quality === 'preview' ? 'jpg' : 'png';
  const dir = join(scratch, `handles-${tag}`);
  await mkdir(dir, { recursive: true });
  const sourceDir = dirname(side.handlePattern);
  for (let index = 0; index < side.handleFrames; index += 1) {
    const frame = side.handleStart + index;
    await copyFile(join(sourceDir, blenderHandleFrameName(kind, frame, quality)), join(dir, `frame_${String(index).padStart(6, '0')}.${ext}`));
  }
  return { ...side, handlePattern: join(dir, `frame_%06d.${ext}`), handleStart: 0 };
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
      if (segment.transition) {
        const path = join(scratch, `segment-${index}.mp4`);
        const transition = {
          ...segment.transition,
          outgoing: await stagedHandleSide(segment.transition.outgoing, 'out', quality, scratch, `${index}-out`),
          incoming: await stagedHandleSide(segment.transition.incoming, 'in', quality, scratch, `${index}-in`),
        };
        await run(blenderTransitionSegmentArgs({ ...target, transition, output: path }), 'Blending a transition between shots');
        parts.push(path);
      } else if (!segment.source) {
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
    await run(audio?.path
      ? blenderSongMuxArgs({
        video: picture, audioPath: audio.path, startSec: audio.startSec || 0, durationSec,
        leadSec: audio.leadSec, leadPath: audio.leadPath, output: partial,
      })
      : [...QUIET, '-i', picture, '-map', '0:v:0', '-c', 'copy', '-an', '-movflags', '+faststart', '-y', partial],
    audio?.path ? 'Laying the song under the picture' : 'Writing the silent cut')
      .catch(async (error) => { await rm(partial, { force: true }); throw error; });
    await rename(partial, output);
    step();
    return { durationSec, frames: totalFrames };
  };
  return assemble().finally(() => rm(scratch, { recursive: true, force: true }));
}
