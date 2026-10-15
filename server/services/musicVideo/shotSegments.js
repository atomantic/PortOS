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
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from 'fs/promises';
import { availableParallelism, tmpdir } from 'os';
import { join } from 'path';
import { PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { AAC_ENCODE_ARGS, runFfmpegProcess, supportsSetparamsFilter } from '../../lib/ffmpeg.js';
import { filterGraphViaFile } from '../../lib/ffmpegFilterGraph.js';
import { isFilmLookNeutral, normalizeFilmLook } from '../../lib/filmLook.js';
import { normalizeStatsOutro } from '../../lib/musicVideoStatsOutro.js';
import { AUDIO_NORM, buildAudioBedMix } from '../videoTimeline/audioBedMix.js';
import { buildMusicVideoFfmpegArgs, planMusicVideoRender } from './render.js';
import { composedLyricWindows, projectTypographyPlan } from './composition.js';
import { removeCompositionScratch, renderTypographyOverlays, typographyOverlayWindows } from './compositionRender.js';
import { lyricOverlayDocumentData } from './lyricPlaythrough.js';
import { applyFilmLookFinish } from './filmLookFinish.js';
import { getMusicVideoOutroStats, renderStatsOutroClip } from './statsOutro.js';
import { nameShots } from './productionReview.js';
import { getProject } from './projects.js';
import { musicVideoEvents } from './events.js';
import { maintenance } from '../../lib/maintenanceAdmission.js';

export const SHOT_SEGMENT_DIR = 'music-video-segments';
// Bump when a segment's encode changes in a way its key cannot see.
export const SHOT_SEGMENT_VERSION = 1;
// Timed text this far outside a segment is left out of its key: a lyric line
// or cue edit elsewhere in the song does not re-render it.
const KEY_MARGIN_SEC = 5;
const SEGMENT_TAG = 'setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
const safeProjectId = (projectId) => {
  if (typeof projectId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) throw new ServerError('Invalid project id', { status: 400, code: 'VALIDATION_ERROR' });
  return projectId;
};
export const shotSegmentDir = (projectId) => join(PATHS.data, SHOT_SEGMENT_DIR, safeProjectId(projectId));

/** A shot's own pinned look, else the video's; null when the shot plays clean. Pure. */
function shotFilmLook(project, scene) {
  const own = scene?.filmLook && typeof scene.filmLook === 'object' ? scene.filmLook : null;
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
 */
export async function planShotSegments(project) {
  if (project?.composition?.mode !== 'composed') {
    throw new ServerError('Shot renders need the composed render style', { status: 409, code: 'SHOT_RENDER_NEEDS_COMPOSED' });
  }
  const { ffmpeg, audioPath, clips, audioDurationSec, soundBed, aspect } = await planMusicVideoRender(project);
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
    const look = shotFilmLook(project, scenes.get(built.sceneId));
    const lookKey = look ? hash({ v: SHOT_SEGMENT_VERSION, baseKey, look, startSec: built.startSec, fps }) : null;
    segments.push({
      index, sceneId: built.sceneId, layer: built.layer, startSec: built.startSec, endSec: built.endSec,
      startFrame, frames: built.frames, window, segment, look, baseKey, lookKey,
      basePath: join(dir, `${baseKey}.mp4`),
      path: join(dir, lookKey ? `${baseKey}-${lookKey}.mp4` : `${baseKey}.mp4`),
    });
  }
  if (!segments.length) throw new ServerError('Nothing to render — no shot spans a frame of the song', { status: 422, code: 'NO_SCENE_CLIPS' });
  const songFrames = segments.reduce((sum, s) => sum + s.frames, 0);
  const songSec = songFrames / fps;
  const outro = await planOutroSegment(project, { dir, width, height, fps, offsetSec: songSec });
  return {
    project, ffmpeg, audioPath, soundBed, clips, common, cues, style, lyricWindows,
    width, height, fps, totalDuration, songSec, segments, outro, dir,
  };
}

async function planOutroSegment(project, { dir, width, height, fps, offsetSec }) {
  const outro = normalizeStatsOutro(project?.statsOutro);
  if (!outro?.enabled) return null;
  const stats = await getMusicVideoOutroStats(project);
  const baseKey = hash({ v: SHOT_SEGMENT_VERSION, outro, stats, width, height, fps });
  const look = shotFilmLook(project, null);
  const lookKey = look ? hash({ v: SHOT_SEGMENT_VERSION, baseKey, look, startSec: offsetSec, fps }) : null;
  return {
    outro: true, stats, startSec: offsetSec, durationSec: outro.durationSec, frames: Math.round(outro.durationSec * fps), look, baseKey, lookKey,
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
  if (!entry) {
    const controller = new AbortController();
    entry = { controller, waiters: 0, listeners: new Set() };
    entry.promise = renderSegmentFiles(plan, segment, { signal: controller.signal, onProgress: (f) => entry.listeners.forEach((fn) => fn(f)) })
      .finally(() => inFlight.delete(segment.path));
    inFlight.set(segment.path, entry);
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
    } catch (err) {
      await rm(partial, { force: true }).catch(() => {});
      if (signal.aborted) throw Object.assign(new Error('Render cancelled'), { code: 'CANCELED' });
      throw new ServerError(`${label(plan, segment)}: film look failed: ${err.message}`, { status: err.status || 500, code: err.code || 'SHOT_LOOK_FAILED' });
    }
  }
  onProgress?.(1);
  return segment.path;
}

async function renderShotBase(plan, segment, outputPath, { jobId, signal, onProgress }) {
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

/** How many segments render at once: each may hold a browser and an encoder. */
export const segmentConcurrency = ({ cores = availableParallelism() } = {}) => Math.max(1, Math.min(3, Math.floor(cores / 4)));

/**
 * Render every missing segment of `plan` (`concurrency` at a time). `onProgress`
 * reports the share of frames ready, counting cached ones as done.
 */
export async function renderMissingSegments(plan, { signal, onProgress, concurrency = segmentConcurrency() } = {}) {
  const all = [...plan.segments, ...(plan.outro ? [plan.outro] : [])];
  const total = all.reduce((sum, s) => sum + s.frames, 0) || 1;
  const done = new Map(all.map((s) => [s, existsSync(s.path) ? 1 : 0]));
  const report = () => onProgress?.([...done].reduce((sum, [s, f]) => sum + s.frames * f, 0) / total);
  report();
  const queue = all.filter((s) => done.get(s) < 1);
  const failures = [];
  const worker = async () => {
    while (queue.length && !signal?.aborted) {
      const segment = queue.shift();
      try {
        await renderSegment(plan, segment, { signal, onProgress: (f) => { done.set(segment, f); report(); } });
        done.set(segment, 1);
        report();
      } catch (err) {
        if (signal?.aborted || err.code === 'CANCELED') throw err;
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
 * `{ durationSec, songSec }`.
 */
export async function stitchSegments(plan, outputPath, { signal } = {}) {
  const parts = [...plan.segments, ...(plan.outro ? [plan.outro] : [])].map((s) => s.path);
  const missing = parts.filter((p) => !existsSync(p));
  if (missing.length) throw new ServerError('A shot segment went missing before stitching — render again', { status: 409, code: 'SHOT_SEGMENT_MISSING' });
  const listPath = `${outputPath}.segments.txt`;
  const silent = `${outputPath}.silent.mp4`;
  const songSec = plan.songSec;
  const durationSec = songSec + (plan.outro ? plan.outro.frames / plan.fps : 0);
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
    filters.push(`${master}atrim=end=${songSec},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${durationSec}[a]`);
    const muxed = await runFfmpegProcess({ bin: plan.ffmpeg, signal, args: ['-hide_banner', '-loglevel', 'error', ...inputs,
      '-filter_complex', filters.join(';'), '-map', '0:v', '-map', '[a]', '-c:v', 'copy', ...AAC_ENCODE_ARGS,
      '-t', String(durationSec), '-movflags', '+faststart', '-y', outputPath] });
    signal?.throwIfAborted();
    if (!muxed.ok) throw new ServerError(`Laying the song under the shots failed: ${muxed.reason}`, { status: 500, code: 'SHOT_SEGMENT_MUX' });
    return { durationSec, songSec };
  } finally {
    await rm(listPath, { force: true }).catch(() => {});
    await rm(silent, { force: true }).catch(() => {});
  }
}

/** Remove cached files the current plan no longer uses (older takes of each shot and look). */
export async function pruneSegments(plan) {
  const keep = new Set([...plan.segments, ...(plan.outro ? [plan.outro] : [])].flatMap((s) => [s.path, s.basePath]));
  const names = await readdir(plan.dir).catch(() => []);
  let removed = 0;
  for (const name of names) {
    const path = join(plan.dir, name);
    if (keep.has(path) || [...inFlight.keys()].some((p) => path.startsWith(p))) continue;
    if (name.endsWith('.partial.mp4')) continue;
    await rm(path, { force: true }).then(() => { removed += 1; }, () => {});
  }
  return removed;
}

/** Remove a project's whole segment cache (the project was deleted). */
export const removeProjectSegments = (projectId) => rm(shotSegmentDir(projectId), { recursive: true, force: true });

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
const shotJobs = new Map();
const shotJobKey = (projectId, sceneId) => `${projectId}:${sceneId}`;

const emitShotRender = (payload) => musicVideoEvents.emit('shot-render', payload);

async function loadProjectScene(projectId, sceneId) {
  const project = await getProject(projectId);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  if (!(project.scenes || []).some((scene) => scene.sceneId === sceneId)) throw new ServerError('Shot not found', { status: 404, code: 'NOT_FOUND' });
  return project;
}

/**
 * The shot panel's render state for every shot of a project. A project the
 * final render would refuse reports that refusal (it names the shots and the
 * fix) instead of shot states, since no segment can be placed until it plans.
 */
export async function getShotRenderStatus(projectId) {
  const project = await getProject(projectId);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  if (project.composition?.mode !== 'composed') return { available: false, shots: [], outro: null, ready: 0, total: 0 };
  const plan = await planShotSegments(project).catch((err) => {
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
      if (segments.every(segmentRendered)) return { sceneId, state: 'rendered' };
      if (shotJobs.has(key)) return { sceneId, state: 'rendering' };
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
      Promise.resolve().then(async () => {
        let before = 0;
        for (const segment of segments) {
          await renderSegment(plan, segment, { signal: controller.signal, onProgress: (f) => report((before + segment.frames * f) / total) });
          before += segment.frames;
        }
      }).then(() => {
        console.log(`🎬 Music-video ${nameShots(project, [sceneId])} rendered [${projectId.slice(0, 8)}] in ${((Date.now() - started) / 1000).toFixed(1)}s`);
        emitShotRender({ projectId, sceneId, state: 'rendered', progress: 1 });
      }, (err) => {
        const canceled = controller.signal.aborted || err?.code === 'CANCELED';
        const log = canceled ? console.log : console.error;
        log(`${canceled ? '🛑' : '❌'} Music-video shot render ${canceled ? 'cancelled' : 'failed'} [${projectId.slice(0, 8)}]: ${err.message}`);
        emitShotRender({ projectId, sceneId, state: canceled ? 'canceled' : 'failed', error: canceled ? null : err.message });
      }).finally(() => {
        shotJobs.delete(key);
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
  if (typeof name !== 'string' || !/^(outro-)?[0-9a-f]{32}(-[0-9a-f]{32})?\.mp4$/.test(name)) return null;
  const path = join(shotSegmentDir(projectId), name);
  return existsSync(path) ? path : null;
}
