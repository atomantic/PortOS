/**
 * Music Video — per-shot render segments for composed footage renders.
 *
 * A composed final render used to be one ffmpeg graph over every shot, one
 * overlay capture over the whole song and one film look pass over the whole
 * cut, so tuning one shot re-drew the full film. Here each section of the cut
 * is its own cached segment, in two stages:
 *
 *   base  the section's frames from buildMusicVideoFfmpegArgs' segment mode
 *         (the same chain the whole-film graph draws there: cut effects from
 *         the next shot, fades, grade, glitches and the typography over it),
 *         keyed on everything that reaches those pixels.
 *   look  the base re-captured through the shot's film look (its own pinned
 *         look, else the video's) on song time, keyed on the base and the look.
 *
 * A look change redoes only the look stage, a shot change only that shot.
 * The final render renders what is missing, joins the segments by stream copy
 * and lays the song under them once. Segments live under data/ per project
 * and are machine-local (excluded from backups, regenerable).
 */

import { createHash, randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { availableParallelism, tmpdir, totalmem } from 'os';
import { join, sep } from 'path';
import { PATHS, safeJSONParse, atomicWrite, readJSONFile } from '../../lib/fileUtils.js';
import { createKeyCachedQueue } from '../../lib/createKeyCachedQueue.js';
import { ServerError } from '../../lib/errorHandler.js';
import { AAC_ENCODE_ARGS, runFfmpegProcess, supportsSetparamsFilter } from '../../lib/ffmpeg.js';
import { filterGraphViaFile } from '../../lib/ffmpegFilterGraph.js';
import { isFilmLookNeutral, normalizeFilmLook } from '../../lib/filmLook.js';
import { endingParts } from '../../lib/musicVideoEnding.js';
import { AUDIO_NORM, buildAudioBedMix } from '../videoTimeline/audioBedMix.js';
import { buildMusicVideoFfmpegArgs, planMusicVideoRender } from './render.js';
import { composedLyricWindows, projectTypographyPlan } from './composition.js';
import { removeCompositionScratch, renderTypographyOverlays, typographyOverlayWindows } from './compositionRender.js';
import { lyricOverlayDocumentData } from './lyricPlaythrough.js';
import { applyFilmLookFinish } from './filmLookFinish.js';
import { getMusicVideoOutroStats, renderStatsOutroClip } from './statsOutro.js';
import { nameShots } from './productionReview.js';
import { coldOpenAudioShots, ensureColdOpenAudio } from './coldOpen.js';
import { SHOT_SEGMENT_DIR, shotSegmentDir } from './shotSegmentPaths.js';
import { requireProject } from './requireProject.js';
import { assertRenderCleanupIdle, withRenderCleanupReservation } from './renderCleanupActivity.js';
import { musicVideoEvents } from './events.js';
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { trackedRenderMap } from '../renderActivity.js';

export { SHOT_SEGMENT_DIR, shotSegmentDir };
// Bump when a segment's encode changes in a way its key cannot see.
export const SHOT_SEGMENT_VERSION = 1;
const segmentOwnerWrites = createKeyCachedQueue();
const pendingShotCleanup = new Map();
const shotCleanupWrites = createKeyCachedQueue();
const segmentOwnersFile = dir => join(dir, 'segments.json');

async function rememberSegmentOwner(plan, segment) {
  if (!segment.baseKey) return;
  await segmentOwnerWrites(plan.dir, async () => {
    const owners = await readJSONFile(segmentOwnersFile(plan.dir), {}, { strict: true });
    if (owners[segment.baseKey]?.sceneId === segment.sceneId) return;
    owners[segment.baseKey] = { sceneId: segment.sceneId || null };
    await atomicWrite(segmentOwnersFile(plan.dir), owners);
  });
}
// Timed text this far outside a segment is left out of its key: a lyric line
// or cue edit elsewhere in the song does not re-render it.
const KEY_MARGIN_SEC = 5;
const SEGMENT_TAG = 'setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
// A segment's film-look file is keyed by its base file, its place in the song
// and the (normalized) look, so any look's files can be found again from the plan.
const segmentLookKey = ({ baseKey, startSec }, look, fps) => hash({ v: SHOT_SEGMENT_VERSION, baseKey, look, startSec, fps });
const segmentLookPath = (plan, segment, look) => join(plan.dir, `${segment.outro ? 'outro-' : ''}${segment.baseKey}-${segmentLookKey(segment, look, plan.fps)}.mp4`);

const hasOwnLook = (scene) => !!(scene?.filmLook && typeof scene.filmLook === 'object');

/** A shot's own pinned look, else the video's; null when the shot plays clean. Pure. */
function shotFilmLook(project, scene) {
  const own = hasOwnLook(scene) ? scene.filmLook : null;
  const look = normalizeFilmLook(own || project?.filmLook);
  return look && !isFilmLookNeutral(look) ? look : null;
}

/**
 * `value` with every timed entry (an object carrying a finite `startSec`) that
 * lies wholly outside `[lo, hi]` removed, at any depth — the part of a page's
 * data a segment's frames can depend on, for its key. Pure.
 */
function windowedKeyData(value, lo, hi) {
  const outside = (v) => v && typeof v === 'object' && Number.isFinite(v.startSec)
    && (v.startSec > hi || (Number.isFinite(v.endSec) ? v.endSec : v.startSec) < lo);
  if (Array.isArray(value)) return value.filter((v) => !outside(v)).map((v) => windowedKeyData(v, lo, hi));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, windowedKeyData(v, lo, hi)]));
  return value;
}

// Each input file stands in the key as its size and modification time, so a
// replaced clip or still re-renders while an unchanged one keeps its segment.
async function fingerprintArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (args[i - 1] === '-i' && !value.startsWith('@')) {
      const info = await stat(value).catch(() => null);
      out.push(info ? `${value}|${info.size}|${Math.round(info.mtimeMs)}` : `${value}|missing`);
    } else out.push(value);
  }
  return out;
}

/**
 * Plan a composed project's segments: the same preflight and clip plan as the
 * final render, then each section's keys and cache paths. Throws the render's
 * own refusals (each names its shots and the fix). Reads files, writes nothing.
 * `options.decode: false` skips the performance-take review's ffmpeg decode.
 */
export async function planShotSegments(project, options) {
  if (project?.composition?.mode !== 'composed') {
    throw new ServerError('Shot renders need the composed render style', { status: 409, code: 'SHOT_RENDER_NEEDS_COMPOSED' });
  }
  const { ffmpeg, audioPath, clips, coldOpen, audioDurationSec, soundBed, aspect } = await planMusicVideoRender(project, options);
  const grade = project.composition?.grade;
  const beats = project.audioAnalysis?.beats;
  const common = { audioDurationSec, frameGrid: true, grade, beats, aspect };
  const full = buildMusicVideoFfmpegArgs(clips, audioPath, join(tmpdir(), 'portos-segment-plan.mp4'), common);
  const { sections, totalDuration, canonW: width, canonH: height, fps } = full;
  const { cues, style } = projectTypographyPlan(project, clips, sections, totalDuration);
  const lyricWindows = composedLyricWindows(project, totalDuration);
  const lyricData = lyricWindows.length ? lyricOverlayDocumentData(project, { width, height, fps, durationSec: totalDuration }) : null;
  const tagFilter = await supportsSetparamsFilter() ? SEGMENT_TAG : null;
  const lastFrame = Math.round(totalDuration * fps);
  const dir = shotSegmentDir(project.id);
  const scenes = new Map((project.scenes || []).map((scene) => [scene.sceneId, scene]));
  const segments = [];
  for (const [index, section] of sections.entries()) {
    const startFrame = Math.round(section.startSec * fps);
    if (startFrame >= lastFrame) break;
    const window = { startFrame, endFrame: Math.min(Math.round(section.endSec * fps), lastFrame) };
    const overlayPages = typographyOverlayWindows({ cues, lyricWindows, fps, durationSec: totalDuration, window });
    const placeholders = overlayPages.flatMap(({ name, windows }) => windows.map((w, k) => ({ path: `@overlay/${name}/${k}`, startSec: w.startSec })));
    const segment = { index, maxFrames: window.endFrame - startFrame, tagFilter };
    const built = buildMusicVideoFfmpegArgs(clips, audioPath, '@out', { ...common, overlays: placeholders, segment });
    const lo = built.startSec - KEY_MARGIN_SEC;
    const hi = built.endSec + KEY_MARGIN_SEC;
    const nearEnd = hi >= totalDuration;
    const overlayKey = {
      ...(overlayPages.some((p) => p.name === 'doc') ? { doc: { cues: windowedKeyData(cues, lo, hi), style, ...(nearEnd ? { totalDuration } : {}) } } : {}),
      ...(overlayPages.some((p) => p.name === 'lyrics') ? { lyrics: windowedKeyData({ ...lyricData, render: nearEnd ? lyricData.render : null }, lo, hi) } : {}),
    };
    const baseKey = hash({ v: SHOT_SEGMENT_VERSION, args: await fingerprintArgs(built.args), overlays: overlayKey, width, height, fps });
    // Each segment belongs to the shot whose span it plays in, so a shot's
    // render, look and cached files cover exactly its own time on the song.
    const scene = scenes.get(built.shotId);
    const look = shotFilmLook(project, scene);
    const lookKey = look ? segmentLookKey({ baseKey, startSec: built.startSec }, look, fps) : null;
    segments.push({
      index, sceneId: built.shotId, layer: built.layer, startSec: built.startSec, endSec: built.endSec,
      startFrame, frames: built.frames, window, segment, look, baseKey, lookKey, ownLook: hasOwnLook(scene),
      basePath: join(dir, `${baseKey}.mp4`),
      path: join(dir, lookKey ? `${baseKey}-${lookKey}.mp4` : `${baseKey}.mp4`),
    });
  }
  if (!segments.length) throw new ServerError('Nothing to render — no shot spans a frame of the song', { status: 422, code: 'NO_SCENE_CLIPS' });
  const songFrames = segments.reduce((sum, s) => sum + s.frames, 0);
  const songSec = songFrames / fps;
  const outro = await planOutroSegment(project, { dir, width, height, fps, offsetSec: songSec });
  const opening = coldOpen ? await planColdOpenSegments(project, coldOpen, { dir, width, height, fps, grade, aspect, tagFilter }) : null;
  return {
    project, ffmpeg, audioPath, soundBed, clips, common, cues, style, lyricWindows,
    width, height, fps, totalDuration, songSec, outro, dir,
    // The song's shot spans (sceneId = the clip's own shot, partners included), for the stepped hold.
    sections,
    // The cold open's shots lead the cut, on song time before 0.
    segments: opening ? [...opening.segments, ...segments] : segments,
    coldOpen: opening,
  };
}

/**
 * The cold open's sections (shots marked before the song) as segments of the
 * song's frame, ahead of the first note: each on song time before 0, so a
 * look's grain runs on into the song, with no typography over it. `audio` is
 * what each shot sounds like (coldOpen.js), mixed when the cut is stitched.
 */
async function planColdOpenSegments(project, coldOpen, { dir, width, height, fps, grade, aspect, tagFilter }) {
  const common = { frameGrid: true, grade, aspect, canvas: { width, height, fps } };
  const full = buildMusicVideoFfmpegArgs(coldOpen.clips, null, join(tmpdir(), 'portos-cold-open-plan.mp4'), common);
  const leadSec = full.sections.reduce((end, section) => Math.max(end, section.endSec), 0);
  const scenes = new Map((project.scenes || []).map((scene) => [scene.sceneId, scene]));
  const segments = [];
  for (const [index] of full.sections.entries()) {
    const segment = { index, tagFilter };
    const built = buildMusicVideoFfmpegArgs(coldOpen.clips, null, '@out', { ...common, segment });
    const baseKey = hash({ v: SHOT_SEGMENT_VERSION, coldOpen: true, args: await fingerprintArgs(built.args), width, height, fps });
    const scene = scenes.get(built.shotId);
    const look = shotFilmLook(project, scene);
    const startSec = built.startSec - leadSec;
    const lookKey = look ? segmentLookKey({ baseKey, startSec }, look, fps) : null;
    segments.push({
      index, coldOpen: true, sceneId: built.shotId, layer: built.layer, startSec, endSec: built.endSec - leadSec,
      startFrame: Math.round(startSec * fps), frames: built.frames, segment, look, baseKey, lookKey, ownLook: hasOwnLook(scene),
      basePath: join(dir, `${baseKey}.mp4`),
      path: join(dir, lookKey ? `${baseKey}-${lookKey}.mp4` : `${baseKey}.mp4`),
    });
  }
  const audio = await coldOpenAudioShots(project, segments.map((segment) => ({ sceneId: segment.sceneId,
    clip: coldOpen.clips.find((clip) => clip.sceneId === segment.sceneId) || null, durationSec: segment.frames / fps })));
  return { clips: coldOpen.clips, common, segments, audio, durationSec: segments.reduce((sum, segment) => sum + segment.frames, 0) / fps };
}

async function planOutroSegment(project, { dir, width, height, fps, offsetSec }) {
  const parts = endingParts(project);
  if (!parts.length) return null;
  const durationSec = parts.reduce((sum, part) => sum + part.durationSec, 0);
  const stats = parts.some((part) => part.kind === 'floor') ? await getMusicVideoOutroStats(project) : null;
  // A floor-only ending keeps the key it had before credits existed, so its cached file still serves.
  const outro = parts.length === 1 && parts[0].kind === 'floor' ? parts[0].outro : parts;
  const baseKey = hash({ v: SHOT_SEGMENT_VERSION, outro, stats, width, height, fps });
  const look = shotFilmLook(project, null);
  const lookKey = look ? segmentLookKey({ baseKey, startSec: offsetSec }, look, fps) : null;
  return {
    outro: true, stats, startSec: offsetSec, durationSec, frames: Math.round(durationSec * fps), look, baseKey, lookKey,
    basePath: join(dir, `outro-${baseKey}.mp4`),
    path: join(dir, lookKey ? `outro-${baseKey}-${lookKey}.mp4` : `outro-${baseKey}.mp4`),
  };
}

/** Each planned segment's state: `rendered` when its final file is cached. */
export const segmentRendered = (segment) => existsSync(segment.path);

// One render per cache file at a time: a shot render and a final render that
// both need it share the one in flight.
const inFlight = new Map();

/** Whether a segment's file is being rendered now. */
export const segmentRendering = (segment) => inFlight.has(segment.path);

/**
 * Render one planned segment (a shot section or the outro) into the cache,
 * skipping whatever stage is already cached. `onProgress(0..1)`; `signal`
 * cancels (the shared render keeps going while another caller still waits).
 */
export function renderSegment(plan, segment, { signal, onProgress } = {}) {
  if (existsSync(segment.path)) return Promise.resolve(segment.path);
  let entry = inFlight.get(segment.path);
  // An aborted entry is still tearing down (ffmpeg/browser) and can only reject
  // with the abort, so a new caller replaces it rather than joining it.
  if (!entry || entry.controller.signal.aborted) {
    const controller = new AbortController();
    const fresh = { controller, waiters: 0, listeners: new Set() };
    fresh.promise = renderSegmentFiles(plan, segment, { signal: controller.signal, onProgress: (f) => fresh.listeners.forEach((fn) => fn(f)) })
      .finally(() => {
        if (inFlight.get(segment.path) === fresh) inFlight.delete(segment.path);
        // Cancellation releases its caller before the encoder/browser settles.
        cleanupAfterShot(plan.project.id).catch(err => console.warn(`⚠️ Music-video shot cache cleanup failed: ${err.message}`));
      });
    inFlight.set(segment.path, fresh);
    entry = fresh;
  }
  entry.waiters += 1;
  if (onProgress) entry.listeners.add(onProgress);
  let left = false;
  const leave = () => {
    if (left) return false;
    left = true;
    entry.waiters -= 1;
    if (onProgress) entry.listeners.delete(onProgress);
    return true;
  };
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      // The last caller to give up stops the render; another still waiting keeps it.
      if (leave() && entry.waiters <= 0) entry.controller.abort(new Error('Render cancelled'));
      reject(Object.assign(new Error('Render cancelled'), { code: 'CANCELED' }));
    };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    entry.promise.then((path) => {
      signal?.removeEventListener('abort', onAbort);
      if (leave()) resolve(path);
    }, (err) => {
      signal?.removeEventListener('abort', onAbort);
      if (leave()) reject(err);
    });
  });
}

const label = (plan, segment) => (segment.outro ? 'the ending card' : nameShots(plan.project, [segment.sceneId]));

async function renderSegmentFiles(plan, segment, { signal, onProgress }) {
  await mkdir(plan.dir, { recursive: true });
  const jobId = randomUUID();
  const lookShare = segment.look ? 0.5 : 0;
  if (!existsSync(segment.basePath)) {
    const partial = `${segment.basePath}.${jobId}.partial.mp4`;
    try {
      if (segment.outro) {
        await renderStatsOutroClip({ project: plan.project, outputPath: partial, width: plan.width, height: plan.height, fps: plan.fps, jobId,
          stats: segment.stats, signal, onProgress: (f) => onProgress?.(f * (1 - lookShare)) });
      } else {
        await renderShotBase(plan, segment, partial, { jobId, signal, onProgress: (f) => onProgress?.(f * (1 - lookShare)) });
      }
      await rename(partial, segment.basePath);
    } catch (err) {
      await rm(partial, { force: true }).catch(() => {});
      if (signal.aborted) throw Object.assign(new Error('Render cancelled'), { code: 'CANCELED' });
      throw new ServerError(`${label(plan, segment)}: ${err.message}`, { status: err.status || 500, code: err.code || 'SHOT_RENDER_FAILED' });
    }
  }
  if (segment.look && !existsSync(segment.path)) {
    const partial = `${segment.path}.${jobId}.partial.mp4`;
    try {
      await copyFile(segment.basePath, partial);
      await applyFilmLookFinish({ project: plan.project, look: segment.look, path: partial, jobId, signal, offsetSec: segment.startSec, workers: 1,
        label: `Music-video film look ${segment.outro ? 'ending card' : `shot ${segment.sceneId.slice(0, 8)}`}`,
        onProgress: (f) => onProgress?.(1 - lookShare + f * lookShare) });
      await rename(partial, segment.path);
      // A shot rendered from its card lists its look too, so it can be deleted later.
      if (!segment.ownLook) await rememberFilmLook(plan.dir, segment.look);
    } catch (err) {
      await rm(partial, { force: true }).catch(() => {});
      if (signal.aborted) throw Object.assign(new Error('Render cancelled'), { code: 'CANCELED' });
      throw new ServerError(`${label(plan, segment)}: film look failed: ${err.message}`, { status: err.status || 500, code: err.code || 'SHOT_LOOK_FAILED' });
    }
  }
  await rememberSegmentOwner(plan, segment);
  onProgress?.(1);
  return segment.path;
}

async function renderShotBase(plan, segment, outputPath, { jobId, signal, onProgress }) {
  if (segment.coldOpen) return renderColdOpenBase(plan, segment, outputPath, { jobId, signal, onProgress });
  const needsOverlay = typographyOverlayWindows({ cues: plan.cues, lyricWindows: plan.lyricWindows, fps: plan.fps, durationSec: plan.totalDuration, window: segment.window }).length > 0;
  const graphPath = join(tmpdir(), `portos-music-video-segment-${jobId}.filtergraph`);
  try {
    const overlays = needsOverlay ? await renderTypographyOverlays({
      jobId, cues: plan.cues, style: plan.style, width: plan.width, height: plan.height, fps: plan.fps, durationSec: plan.totalDuration,
      lyrics: plan.lyricWindows.length ? { project: plan.project, windows: plan.lyricWindows } : null, window: segment.window, signal,
      onProgress: (f) => onProgress?.(f * 0.5),
    }) : [];
    signal?.throwIfAborted();
    const built = buildMusicVideoFfmpegArgs(plan.clips, plan.audioPath, outputPath, { ...plan.common, overlays, segment: segment.segment });
    const encode = await filterGraphViaFile(plan.ffmpeg, ['-hide_banner', '-loglevel', 'error', ...built.args], graphPath);
    const result = await runFfmpegProcess({ bin: plan.ffmpeg, args: encode.args, signal });
    signal?.throwIfAborted();
    if (!result.ok) throw new Error(`ffmpeg failed: ${result.reason}`);
    onProgress?.(1);
  } finally {
    await rm(graphPath, { force: true }).catch(() => {});
    await removeCompositionScratch(jobId).catch(() => {});
  }
}

// A cold-open section: its shot on the song's frame, nothing drawn over it.
async function renderColdOpenBase(plan, segment, outputPath, { jobId, signal, onProgress }) {
  const graphPath = join(tmpdir(), `portos-music-video-segment-${jobId}.filtergraph`);
  try {
    const built = buildMusicVideoFfmpegArgs(plan.coldOpen.clips, null, outputPath, { ...plan.coldOpen.common, segment: segment.segment });
    const encode = await filterGraphViaFile(plan.ffmpeg, ['-hide_banner', '-loglevel', 'error', ...built.args], graphPath);
    const result = await runFfmpegProcess({ bin: plan.ffmpeg, args: encode.args, signal });
    signal?.throwIfAborted();
    if (!result.ok) throw new Error(`ffmpeg failed: ${result.reason}`);
    onProgress?.(1);
  } finally {
    await rm(graphPath, { force: true }).catch(() => {});
  }
}

// Each segment in flight may hold a film-look browser and an encoder. Browsers
// seeking video in parallel contend for the same decoder and compositor, so
// past a few they slow each other down instead of adding throughput: twelve
// on an 18-core Mac finished fewer shots than three and timed out seeks. The
// memory term keeps a small machine from running out of RAM with a browser per
// shot. PORTOS_MUSIC_VIDEO_SEGMENT_WORKERS overrides the count.
const SEGMENT_MAX_CONCURRENCY = 4;
const SEGMENT_BYTES_EACH = 3 * 1024 ** 3;

/** How many segments render at once: each may hold a browser and an encoder. */
export const segmentConcurrency = ({ cores = availableParallelism(), memoryBytes = totalmem(), override = process.env.PORTOS_MUSIC_VIDEO_SEGMENT_WORKERS } = {}) => {
  const forced = Number.parseInt(override, 10);
  if (Number.isInteger(forced) && forced > 0) return Math.min(forced, 32);
  return Math.max(1, Math.min(SEGMENT_MAX_CONCURRENCY, Math.floor((cores * 2) / 3), Math.floor(memoryBytes / SEGMENT_BYTES_EACH)));
};

// A shot whose render fails (a stalled browser, an overloaded host) is tried
// again after the rest of the queue before the whole render fails.
const SEGMENT_ATTEMPTS = 2;

/**
 * Render every missing segment of `plan` (`concurrency` at a time). `onProgress`
 * reports the share of frames ready, counting cached ones as done.
 */
export async function renderMissingSegments(plan, { signal, onProgress, concurrency = segmentConcurrency() } = {}) {
  // The video's look is listed even when every one of its shots was cached already.
  const videoLook = videoLookSegments(plan).find((s) => s.look)?.look;
  if (videoLook) await rememberFilmLook(plan.dir, videoLook);
  const all = [...plan.segments, ...(plan.outro ? [plan.outro] : [])];
  const total = all.reduce((sum, s) => sum + s.frames, 0) || 1;
  const done = new Map(all.map((s) => [s, existsSync(s.path) ? 1 : 0]));
  const report = () => onProgress?.([...done].reduce((sum, [s, f]) => sum + s.frames * f, 0) / total);
  report();
  const queue = all.filter((s) => done.get(s) < 1);
  const failures = [];
  const attempts = new Map();
  const worker = async () => {
    while (queue.length && !signal?.aborted) {
      const segment = queue.shift();
      attempts.set(segment, (attempts.get(segment) || 0) + 1);
      try {
        await renderSegment(plan, segment, { signal, onProgress: (f) => { done.set(segment, f); report(); } });
        done.set(segment, 1);
        report();
        // An open shot card flips to Rendered (and can play it) mid-render.
        if (segment.sceneId) emitShotRender({ projectId: plan.project?.id, sceneId: segment.sceneId, state: 'rendered', progress: 1 });
      } catch (err) {
        if (signal?.aborted || err.code === 'CANCELED') throw err;
        done.set(segment, 0);
        report();
        // Once a shot has failed for good the render has failed: no more retries.
        if (!failures.length && attempts.get(segment) < SEGMENT_ATTEMPTS) {
          console.warn(`⚠️ ${err.message}; trying it again after the other shots`);
          queue.push(segment);
          continue;
        }
        failures.push(err);
        queue.length = 0;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  signal?.throwIfAborted();
  if (failures.length) throw failures[0];
  return queue.length;
}

/**
 * Join the cached segments by stream copy and lay the song (with any sound
 * bed) under them once, silence under the outro, into `outputPath`. Resolves
 * `{ durationSec, songSec }`. `segments` (default: all, in order) joins a
 * leading run of them instead, with the song under just that part.
 */
export async function stitchSegments(plan, outputPath, { signal, segments = [...plan.segments, ...(plan.outro ? [plan.outro] : [])] } = {}) {
  const parts = segments.map((s) => s.path);
  const missing = parts.filter((p) => !existsSync(p));
  if (missing.length) throw new ServerError('A shot segment went missing before stitching — render again', { status: 409, code: 'SHOT_SEGMENT_MISSING' });
  const listPath = `${outputPath}.segments.txt`;
  const silent = `${outputPath}.silent.mp4`;
  const seconds = (list) => list.reduce((sum, s) => sum + s.frames, 0) / plan.fps;
  const leadSec = seconds(segments.filter((s) => s.coldOpen));
  const songSec = seconds(segments.filter((s) => !s.outro && !s.coldOpen));
  const durationSec = leadSec + songSec + seconds(segments.filter((s) => s.outro));
  try {
    await writeFile(listPath, parts.map((p) => `file '${p.replaceAll("'", "'\\''")}'`).join('\n'));
    const joined = await runFfmpegProcess({ bin: plan.ffmpeg, signal, args: ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-c', 'copy', '-y', silent] });
    signal?.throwIfAborted();
    if (!joined.ok) throw new ServerError(`Joining shot segments failed: ${joined.reason}`, { status: 500, code: 'SHOT_SEGMENT_JOIN' });
    const filters = [];
    const inputs = ['-i', silent, '-i', plan.audioPath];
    let master = '[1:a]';
    if (plan.soundBed?.path) {
      filters.push(`[1:a]${AUDIO_NORM}[master]`);
      const bed = buildAudioBedMix({
        beds: [{ assetPath: plan.soundBed.path, offsetSec: 0, durationSec: songSec, volume: plan.soundBed.volume }],
        firstInputIdx: 2, mainLabel: '[master]', outLabel: '[mixa]', limitPeak: true,
      });
      inputs.push(...bed.inputs);
      filters.push(...bed.filters);
      master = '[mixa]';
    }
    const songAudio = `${master}atrim=end=${songSec},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo`;
    if (leadSec > 0) {
      // The cold open's own sound plays first, then the song from its first note.
      const coldIdx = inputs.filter((arg) => arg === '-i').length;
      inputs.push('-i', await ensureColdOpenAudio(plan.coldOpen.audio, plan.dir, { ffmpeg: plan.ffmpeg, signal }));
      filters.push(`[${coldIdx}:a]atrim=end=${leadSec},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${leadSec}[cold]`);
      filters.push(`${songAudio}[song]`, `[cold][song]concat=n=2:v=0:a=1,apad=whole_dur=${durationSec}[a]`);
    } else {
      filters.push(`${songAudio},apad=whole_dur=${durationSec}[a]`);
    }
    const muxed = await runFfmpegProcess({ bin: plan.ffmpeg, signal, args: ['-hide_banner', '-loglevel', 'error', ...inputs,
      '-filter_complex', filters.join(';'), '-map', '0:v', '-map', '[a]', '-c:v', 'copy', ...AAC_ENCODE_ARGS,
      '-t', String(durationSec), '-movflags', '+faststart', '-y', outputPath] });
    signal?.throwIfAborted();
    if (!muxed.ok) throw new ServerError(`Laying the song under the shots failed: ${muxed.reason}`, { status: 500, code: 'SHOT_SEGMENT_MUX' });
    return { durationSec, songSec, leadSec };
  } finally {
    await rm(listPath, { force: true }).catch(() => {});
    await rm(silent, { force: true }).catch(() => {});
  }
}

/** Keep current bases and film-look comparisons; retire stale derived MP4s only.
 * A final render's time floor preserves files created after its snapshot.
 * Shot replacement uses the cache's owner journal to leave other shots alone;
 * legacy caches without that journal are handled by full/explicit cleanup.
 */
async function staleSegmentFiles(plan, { startedAtMs = Infinity, unusedLooks = false, previews = false, sceneId = null } = {}) {
  const keep = new Set([...plan.segments, ...(plan.outro ? [plan.outro] : [])].flatMap((s) => [s.path, s.basePath]));
  const owners = sceneId ? await readJSONFile(segmentOwnersFile(plan.dir), {}, { strict: true }) : null;
  const names = await readdir(plan.dir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const stale = [];
  for (const name of names) {
    const path = join(plan.dir, name);
    if (owners && owners[name.replace(/^outro-/, '').slice(0, 32)]?.sceneId !== sceneId) continue;
    // A shot-pinned look is also a useful comparison over this exact base.
    const comparison = !unusedLooks && [...plan.segments, ...(plan.outro ? [plan.outro] : [])]
      .some(segment => name.startsWith(`${segment.outro ? 'outro-' : ''}${segment.baseKey}-`));
    if (comparison || keep.has(path) || [...inFlight.keys()].some((p) => path.startsWith(p))) continue;
    if (!name.endsWith('.mp4') || name.endsWith('.partial.mp4') || (!previews && name.startsWith('preview-'))) continue;
    const info = await stat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info || !info.isFile() || info.mtimeMs >= startedAtMs) continue;
    stale.push({ name, bytes: info.size });
  }
  return stale;
}

export async function pruneSegments(plan, { reserved = false, current = false, ...options } = {}) {
  if (current) {
    const { withProjectMediaMutation } = await import('./projects.js');
    return withProjectMediaMutation(async () => {
      const { plan: latest } = await planForLooks(plan.project.id);
      return latest && !latest.error ? pruneSegments(latest, { reserved, ...options }) : 0;
    });
  }
  const prune = async () => {
    assertSegmentCleanupIdle(plan.project.id);
    const stale = await staleSegmentFiles(plan, options);
    for (const file of stale) await rm(join(plan.dir, file.name), { force: true });
    if (stale.length) await segmentOwnerWrites(plan.dir, async () => {
      const owners = await readJSONFile(segmentOwnersFile(plan.dir), {}, { strict: true });
      const present = new Set((await readdir(plan.dir)).filter(name => name.endsWith('.mp4')).map(name => name.replace(/^outro-/, '').slice(0, 32)));
      const kept = Object.fromEntries(Object.entries(owners).filter(([key]) => present.has(key)));
      if (Object.keys(kept).length !== Object.keys(owners).length) await atomicWrite(segmentOwnersFile(plan.dir), kept);
    });
    if (stale.length) musicVideoEvents.emit('render-cleanup', { projectId: plan.project.id });
    return stale.length;
  };
  return reserved ? prune() : withRenderCleanupReservation(plan.project.id, prune);
}

function segmentCleanupBusy(projectId) {
  const dir = shotSegmentDir(projectId);
  return [...inFlight.keys(), ...previewBuilds.keys()].some(path => path.startsWith(`${dir}${sep}`))
    || [...shotJobs.keys()].some(key => key.startsWith(`${projectId}:`));
}

export function assertSegmentCleanupIdle(projectId) {
  if (segmentCleanupBusy(projectId)) {
    throw new ServerError('Wait for shot renders and preview builds to finish before cleanup.', { status: 409, code: 'SHOT_RENDER_ACTIVE' });
  }
}

export async function getSegmentCleanup(projectId, options) {
  const { project, plan: planned } = await planForLooks(projectId, options);
  const plan = planned || { project, dir: shotSegmentDir(projectId), segments: [], outro: null };
  if (plan.error) return { available: true, error: plan.error, stale: [], unusedLooks: [] };
  const stale = await staleSegmentFiles(plan, { previews: true });
  const staleNames = new Set(stale.map(file => file.name));
  const variants = (await staleSegmentFiles(plan, { previews: true, unusedLooks: true })).filter(file => !staleNames.has(file.name));
  return { available: true, error: null, stale, unusedLooks: variants };
}

export async function cleanupShotSegments(projectId, { unusedLooks = false, reserved = false } = {}) {
  const { withProjectMediaMutation } = await import('./projects.js');
  const cleanup = () => withProjectMediaMutation(async () => {
    assertSegmentCleanupIdle(projectId);
    const { project, plan: planned } = await planForLooks(projectId);
    const plan = planned || { project, dir: shotSegmentDir(projectId), segments: [], outro: null };
    if (plan.error) return;
    await pruneSegments(plan, { unusedLooks, previews: true, reserved: true });
    if (unusedLooks && existsSync(plan.dir)) {
      const current = normalizeFilmLook(project.filmLook);
      const currentId = current && !isFilmLookNeutral(current) ? filmLookId(current) : null;
      await updateFilmLooks(plan.dir, looks => {
        for (const id of Object.keys(looks)) if (id !== currentId) delete looks[id];
      });
    }
  });
  return reserved ? cleanup() : withRenderCleanupReservation(projectId, cleanup);
}

/** Remove a project's whole segment cache (the project was deleted). */
export const removeProjectSegments = (projectId) => {
  pendingShotCleanup.delete(projectId);
  return rm(shotSegmentDir(projectId), { recursive: true, force: true });
};

/** Boot sweep: partial files from renders a restart interrupted. */
export async function sweepPartialSegments() {
  const root = join(PATHS.data, SHOT_SEGMENT_DIR);
  for (const project of await readdir(root).catch(() => [])) {
    for (const name of await readdir(join(root, project)).catch(() => [])) {
      if (name.endsWith('.partial.mp4')) await rm(join(root, project, name), { force: true }).catch(() => {});
    }
  }
}

/**
 * The shot panel's view of the cache: per shot, whether every section it plays
 * is rendered and whether one is rendering now, plus the playable files.
 */
function segmentStatus(plan) {
  const byShot = new Map();
  for (const segment of plan.segments) {
    const entry = byShot.get(segment.sceneId) || { sceneId: segment.sceneId, sections: 0, rendered: 0, rendering: false, startSec: segment.startSec, endSec: segment.endSec, files: [] };
    entry.sections += 1;
    if (segmentRendered(segment)) { entry.rendered += 1; entry.files.push(segment.path.slice(plan.dir.length + 1)); }
    if (segmentRendering(segment)) entry.rendering = true;
    entry.endSec = Math.max(entry.endSec, segment.endSec);
    entry.look = !!segment.look;
    byShot.set(segment.sceneId, entry);
  }
  const shots = [...byShot.values()].map(({ rendered, sections, ...rest }) => ({ ...rest, state: rendered === sections ? 'rendered' : 'stale' }));
  const all = [...plan.segments, ...(plan.outro ? [plan.outro] : [])];
  return {
    shots,
    outro: plan.outro ? { state: segmentRendered(plan.outro) ? 'rendered' : 'stale', rendering: segmentRendering(plan.outro) } : null,
    ready: all.filter(segmentRendered).length,
    total: all.length,
  };
}

// One shot render per shot at a time: `${projectId}:${sceneId}` → { controller }.
const shotJobs = trackedRenderMap('music-video-shot', {
  noun: 'music video shot render',
  link: (key) => { const [projectId, sceneId] = key.split(':'); return `/music-video/${encodeURIComponent(projectId)}/scene/${encodeURIComponent(sceneId)}`; },
});
const shotJobKey = (projectId, sceneId) => `${projectId}:${sceneId}`;

const emitShotRender = (payload) => musicVideoEvents.emit('shot-render', payload);

async function loadProjectScene(projectId, sceneId) {
  const project = await requireProject(projectId);
  if (!(project.scenes || []).some((scene) => scene.sceneId === sceneId)) throw new ServerError('Shot not found', { status: 404, code: 'NOT_FOUND' });
  return project;
}

/**
 * The shot panel's render state for every shot of a project. A project the
 * final render would refuse reports that refusal (it names the shots and the
 * fix) instead of shot states, since no segment can be placed until it plans.
 */
export async function getShotRenderStatus(projectId, options) {
  const project = await requireProject(projectId);
  if (project.composition?.mode !== 'composed') return { available: false, shots: [], outro: null, ready: 0, total: 0 };
  const plan = await planShotSegments(project, options).catch((err) => {
    if (!err?.status || err.status >= 500) throw err;
    return { error: { message: err.message, code: err.code || null } };
  });
  if (plan.error) return { available: true, error: plan.error, shots: [], outro: null, ready: 0, total: 0 };
  const status = segmentStatus(plan);
  const running = new Set([...shotJobs.keys()].filter((key) => key.startsWith(`${projectId}:`)).map((key) => key.slice(projectId.length + 1)));
  return { available: true, ...status, shots: status.shots.map((shot) => (running.has(shot.sceneId) ? { ...shot, rendering: true } : shot)) };
}

/**
 * Render one shot's segments (every section of the cut it plays, base and
 * film look) into the cache in the background. Resolves at once with the
 * shot's state; progress and the outcome arrive as `shot-render` events.
 */
export async function startShotRender(projectId, sceneId) {
  const permit = maintenance.admit('music-video', projectId, { continuation: true, parentKinds: ['media'] });
  let handedOff = false;
  try {
    return await permit.run(async () => {
      const key = shotJobKey(projectId, sceneId);
      if (shotJobs.has(key)) return { sceneId, state: 'rendering' };
      const project = await loadProjectScene(projectId, sceneId);
      const plan = await planShotSegments(project);
      const segments = plan.segments.filter((segment) => segment.sceneId === sceneId);
      if (!segments.length) {
        throw new ServerError(`${nameShots(project, [sceneId])}: not in the cut yet. Give it a clip, or a still with a start and end time`, { status: 422, code: 'SHOT_NOT_IN_CUT' });
      }
      if (segments.every(segmentRendered)) {
        await cleanupAfterShot(projectId, sceneId).catch(err => console.warn(`⚠️ Music-video shot cache cleanup failed: ${err.message}`));
        return { sceneId, state: 'rendered' };
      }
      if (shotJobs.has(key)) return { sceneId, state: 'rendering' };
      assertRenderCleanupIdle(projectId);
      const controller = new AbortController();
      shotJobs.set(key, { controller });
      handedOff = true;
      const total = segments.reduce((sum, s) => sum + s.frames, 0) || 1;
      let reported = -1;
      const report = (fraction) => {
        const pct = Math.floor(fraction * 20) * 5;
        if (pct === reported) return;
        reported = pct;
        emitShotRender({ projectId, sceneId, state: 'rendering', progress: pct / 100 });
      };
      report(0);
      const started = Date.now();
      let rendered = false;
      Promise.resolve().then(async () => {
        let before = 0;
        for (const segment of segments) {
          await renderSegment(plan, segment, { signal: controller.signal, onProgress: (f) => report((before + segment.frames * f) / total) });
          before += segment.frames;
        }
      }).then(() => {
        rendered = true;
        console.log(`🎬 Music-video ${nameShots(project, [sceneId])} rendered [${projectId.slice(0, 8)}] in ${((Date.now() - started) / 1000).toFixed(1)}s`);
        emitShotRender({ projectId, sceneId, state: 'rendered', progress: 1 });
      }, (err) => {
        const canceled = controller.signal.aborted || err?.code === 'CANCELED';
        const log = canceled ? console.log : console.error;
        log(`${canceled ? '🛑' : '❌'} Music-video shot render ${canceled ? 'cancelled' : 'failed'} [${projectId.slice(0, 8)}]: ${err.message}`);
        emitShotRender({ projectId, sceneId, state: canceled ? 'canceled' : 'failed', error: canceled ? null : err.message });
      }).finally(async () => {
        shotJobs.delete(key);
        await cleanupAfterShot(projectId, rendered ? sceneId : null).catch(err => console.warn(`⚠️ Music-video shot cache cleanup failed: ${err.message}`));
        permit.finish();
      });
      return { sceneId, state: 'rendering' };
    });
  } finally {
    if (!handedOff) permit.finish();
  }
}

/** Stop a shot render; resolves whether one was running. */
export function cancelShotRender(projectId, sceneId) {
  const job = shotJobs.get(shotJobKey(projectId, sceneId));
  if (!job) return false;
  job.controller.abort(new Error('Render cancelled'));
  return true;
}

/** A cached segment file of `projectId` by name, or null when the name is not one or it is gone. */
export function shotSegmentFile(projectId, name) {
  if (typeof name !== 'string' || !/^(?:(outro-)?[0-9a-f]{32}(-[0-9a-f]{32})?|preview-[0-9a-f]{32}(-light)?)\.mp4$/.test(name)) return null;
  const path = join(shotSegmentDir(projectId), name);
  return existsSync(path) ? path : null;
}

// ── Film looks kept side by side ────────────────────────────────────────────
// Every video-wide look rendered over the current takes stays cached until it
// is deleted, so switching back to one only stitches. `looks.json` remembers
// each look's settings (its files are found again from the plan).
const LOOKS_FILE = 'looks.json';
const filmLookId = (look) => hash({ look });
const lookWrites = new Map();

async function readFilmLooks(dir) {
  const raw = await readFile(join(dir, LOOKS_FILE), 'utf8').catch(() => null);
  const parsed = raw ? safeJSONParse(raw, null, { allowArray: false }) : null;
  return parsed?.looks && typeof parsed.looks === 'object' ? parsed.looks : {};
}

// One read-modify-write at a time per project: shots finish in parallel.
function updateFilmLooks(dir, change) {
  const run = (lookWrites.get(dir) || Promise.resolve()).then(async () => {
    const looks = await readFilmLooks(dir);
    if (change(looks) === false) return;
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `${LOOKS_FILE}.${randomUUID()}.tmp`);
    await writeFile(tmp, JSON.stringify({ looks }, null, 2));
    await rename(tmp, join(dir, LOOKS_FILE));
  });
  const settled = run.catch((err) => console.warn(`⚠️ Music-video film look list not saved: ${err.message}`));
  lookWrites.set(dir, settled);
  return settled;
}

const rememberFilmLook = (dir, look) => updateFilmLooks(dir, (looks) => {
  const id = filmLookId(look);
  if (looks[id]) return false;
  looks[id] = { look, savedAt: new Date().toISOString() };
  return true;
});

const videoLookSegments = (plan) => [...plan.segments.filter((s) => !s.ownLook), ...(plan.outro ? [plan.outro] : [])];

async function planForLooks(projectId, options) {
  const project = await requireProject(projectId);
  if (project.composition?.mode !== 'composed') return { project, plan: null };
  const plan = await planShotSegments(project, options).catch((err) => {
    if (!err?.status || err.status >= 500) throw err;
    return { error: { message: err.message, code: err.code || null } };
  });
  return { project, plan };
}

/**
 * The video-wide film looks cached over the current takes: each one's
 * settings, how many of the shots that use the video's look have it rendered,
 * and the disk it holds. The look in use comes first.
 */
export async function listFilmLooks(projectId, options) {
  const { project, plan } = await planForLooks(projectId, options);
  if (!plan) return { available: false, looks: [], total: 0 };
  if (plan.error) return { available: true, error: plan.error, looks: [], total: 0 };
  const stored = await readFilmLooks(plan.dir);
  const current = normalizeFilmLook(project.filmLook);
  const currentId = current && !isFilmLookNeutral(current) ? filmLookId(current) : null;
  if (currentId && !stored[currentId]) {
    await rememberFilmLook(plan.dir, current);
    stored[currentId] = { look: current, savedAt: new Date().toISOString() };
  }
  const segments = videoLookSegments(plan);
  const looks = [];
  for (const [id, entry] of Object.entries(stored)) {
    const look = normalizeFilmLook(entry?.look);
    if (!look || isFilmLookNeutral(look)) continue;
    let rendered = 0;
    let bytes = 0;
    for (const segment of segments) {
      const info = await stat(segmentLookPath(plan, segment, look)).catch(() => null);
      if (info) { rendered += 1; bytes += info.size; }
    }
    if (!rendered && id !== currentId) continue;
    looks.push({ id, look, current: id === currentId, rendered, bytes, savedAt: entry.savedAt || null });
  }
  looks.sort((a, b) => Number(b.current) - Number(a.current) || String(b.savedAt).localeCompare(String(a.savedAt)));
  return { available: true, looks, total: segments.length };
}

/** Delete one cached look's files over the current takes, and forget it. */
export async function deleteFilmLook(projectId, lookId) {
  return withRenderCleanupReservation(projectId, async () => {
    const { isProjectRenderActive } = await import('./render.js');
    if (isProjectRenderActive(projectId)) throw new ServerError('Wait for the final render to finish before deleting a look.', { status: 409, code: 'RENDER_IN_PROGRESS' });
    assertSegmentCleanupIdle(projectId);
    return deleteFilmLookFiles(projectId, lookId);
  });
}

async function deleteFilmLookFiles(projectId, lookId) {
  if (typeof lookId !== 'string' || !/^[0-9a-f]{32}$/.test(lookId)) throw new ServerError('Invalid film look id', { status: 400, code: 'VALIDATION_ERROR' });
  const { project, plan } = await planForLooks(projectId);
  if (!plan || plan.error) throw new ServerError('This video has no shot renders to delete', { status: 409, code: 'NO_SHOT_RENDERS' });
  if ([...inFlight.keys()].some((path) => path.startsWith(plan.dir))) {
    throw new ServerError('Shots of this video are rendering. Delete the look after they finish, or stop the render', { status: 409, code: 'SHOT_RENDER_ACTIVE' });
  }
  const entry = (await readFilmLooks(plan.dir))[lookId];
  const current = normalizeFilmLook(project.filmLook);
  const look = normalizeFilmLook(entry?.look) || (current && filmLookId(current) === lookId ? current : null);
  let removed = 0;
  if (look) {
    for (const segment of videoLookSegments(plan)) {
      await rm(segmentLookPath(plan, segment, look)).then(() => { removed += 1; }, () => {});
    }
  }
  await updateFilmLooks(plan.dir, (looks) => {
    if (!looks[lookId]) return false;
    delete looks[lookId];
    return true;
  });
  if (removed) console.log(`🗑️ Music-video film look [${projectId.slice(0, 8)}] deleted: ${removed} shot files`);
  return listFilmLooks(projectId);
}

// ── Rendered so far ────────────────────────────────────────────────────────
// The shots finished so far, stitched in order up to the first one still
// missing, with the song under them: a seam check while the rest renders.
// `light` adds a lighter encode for a phone (grain makes the master heavy).
const previewBuilds = new Map();
const LIGHT_ENCODE_ARGS = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-maxrate', '5M', '-bufsize', '10M', '-pix_fmt', 'yuv420p'];

export async function buildRenderPreview(projectId, { light = false } = {}) {
  const { plan } = await planForLooks(projectId);
  if (!plan) throw new ServerError('Rendered-so-far playback needs the composed render style', { status: 409, code: 'SHOT_RENDER_NEEDS_COMPOSED' });
  if (plan.error) throw new ServerError(plan.error.message, { status: 409, code: plan.error.code || 'SHOT_RENDER_REFUSED' });
  const lead = [];
  for (const segment of plan.segments) {
    if (!segmentRendered(segment)) break;
    lead.push(segment);
  }
  if (lead.length === plan.segments.length && plan.outro && segmentRendered(plan.outro)) lead.push(plan.outro);
  if (!lead.length) throw new ServerError('No shot is rendered yet: the first shot plays here once it is done', { status: 409, code: 'NO_SHOTS_RENDERED' });
  const key = hash({ parts: lead.map((s) => s.path), audio: plan.audioPath, bed: plan.soundBed || null });
  const name = `preview-${key}${light ? '-light' : ''}.mp4`;
  const path = join(plan.dir, name);
  const shots = new Set(lead.filter((s) => !s.outro).map((s) => s.sceneId)).size;
  const result = {
    name, light,
    durationSec: lead.reduce((sum, s) => sum + s.frames, 0) / plan.fps,
    shots, totalShots: new Set(plan.segments.map((s) => s.sceneId)).size,
    complete: lead.length === plan.segments.length + (plan.outro ? 1 : 0),
  };
  assertRenderCleanupIdle(projectId);
  if (existsSync(path)) return result;
  let build = previewBuilds.get(path);
  if (!build) {
    build = writePreview(plan, lead, path, { light }).finally(async () => {
      previewBuilds.delete(path);
      await cleanupAfterShot(projectId).catch(err => console.warn(`⚠️ Music-video shot cache cleanup failed: ${err.message}`));
    });
    previewBuilds.set(path, build);
  }
  await build;
  return result;
}

async function writePreview(plan, lead, path, { light }) {
  const jobId = randomUUID();
  const full = `${path}.${jobId}.full.mp4`;
  const partial = `${path}.${jobId}.partial.mp4`;
  try {
    await stitchSegments(plan, light ? full : partial, { segments: lead });
    if (light) {
      const encoded = await runFfmpegProcess({ bin: plan.ffmpeg, args: ['-hide_banner', '-loglevel', 'error', '-i', full,
        '-vf', "scale=-2:'min(720,ih)'", ...LIGHT_ENCODE_ARGS, '-c:a', 'copy', '-movflags', '+faststart', '-y', partial] });
      if (!encoded.ok) throw new ServerError(`The phone copy failed: ${encoded.reason}`, { status: 500, code: 'SHOT_PREVIEW_ENCODE' });
    }
    // Only the newest preview of each kind is kept.
    const variant = light ? /^preview-[0-9a-f]{32}-light\.mp4$/ : /^preview-[0-9a-f]{32}\.mp4$/;
    for (const old of await readdir(plan.dir).catch(() => [])) {
      if (variant.test(old)) await rm(join(plan.dir, old), { force: true }).catch(() => {});
    }
    await rename(partial, path);
  } finally {
    await rm(full, { force: true }).catch(() => {});
    await rm(partial, { force: true }).catch(() => {});
  }
}

async function cleanupAfterShot(projectId, sceneId = null) {
  if (sceneId) {
    const pending = pendingShotCleanup.get(projectId) || new Set();
    pending.add(sceneId);
    pendingShotCleanup.set(projectId, pending);
  }
  if (!pendingShotCleanup.get(projectId)?.size) return;
  return shotCleanupWrites(projectId, async () => {
    const pending = pendingShotCleanup.get(projectId);
    if (!pending?.size) return;
    const { isProjectRenderActive } = await import('./render.js');
    if (isProjectRenderActive(projectId) || segmentCleanupBusy(projectId)) return;
    const { withProjectMediaMutation } = await import('./projects.js');
    await withProjectMediaMutation(async () => {
      if (isProjectRenderActive(projectId) || segmentCleanupBusy(projectId)) return;
      await withRenderCleanupReservation(projectId, async () => {
        const { plan } = await planForLooks(projectId);
        if (!plan || plan.error) return;
        for (const id of [...pending]) {
          const current = plan.segments.filter(segment => segment.sceneId === id);
          // A later edit supersedes the completed render: wait for its new success.
          if (current.length && current.every(segmentRendered)) await pruneSegments(plan, { sceneId: id, reserved: true });
          pending.delete(id);
        }
        if (!pending.size) pendingShotCleanup.delete(projectId);
      }, { notify: false });
    });
  });
}

// A deferred batch also resumes after preview/full-render readers or another
// cleanup release their ownership. Never poll or drop another completed shot.
const resumeShotCleanup = ({ projectId }) => {
  cleanupAfterShot(projectId).catch(err => console.warn(`⚠️ Music-video shot cache cleanup failed: ${err.message}`));
};
musicVideoEvents.on('render', resumeShotCleanup);
musicVideoEvents.on('render-cleanup-idle', resumeShotCleanup);
