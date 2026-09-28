/**
 * Music Video — render pipeline (#1760, Phase 2).
 *
 * Assembles a project's per-scene i2v clips (each a `videoHistoryId` entry the
 * scene-video hook filed) into a single MP4 laid under the project's source
 * track as the **master audio bed** — the music video's defining shape: one
 * music track under all clips, the per-clip generated audio dropped. Mirrors
 * videoTimeline's SSE render runner (job map, ffmpeg `-progress` parsing, the
 * shared sseUtils broadcast), but its ffmpeg graph concats video-only and maps
 * one external audio input as the sole output audio, ended on `-shortest` so the
 * render runs only as long as the shorter of (video, track).
 *
 * Beat-snap: when the project carries a cached beat analysis, each cut is
 * trimmed back to the nearest beat (never extended — a clip can't grow), so
 * cuts land on the music. With no analysis the clips render at their natural
 * length. A scene the director has explicitly arranged on the beat-quantized
 * timeline (#1854 — `startSec`/`endSec`/`beatAligned` saved via drag-snap in
 * the client) skips this live re-derivation entirely: its saved boundaries
 * are honored exactly, so the render matches what was shown on the timeline
 * rather than whatever the current beat grid would produce.
 */

import { spawn } from '../../lib/childProcess.js';
import { existsSync } from 'fs';
import { unlink } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay } from '../../lib/sseUtils.js';
import { findFfmpeg, safeUnder, generateThumbnail, probeVideoDuration } from '../../lib/ffmpeg.js';
import { safeChildProcessOptions } from '../../lib/processEnv.js';
import { killWithEscalation } from '../../lib/killWithEscalation.js';
import { attachFfmpegRenderGuard } from '../../lib/ffmpegRenderGuard.js';
import { loadHistory, mutateVideoHistory } from '../videoGen/local.js';
import { getTrack } from '../tracks/index.js';
import { getProject, listProjects, updateProject } from './projects.js';
import { sceneHasAuthoredSpan, sceneVisualLayer } from '../../lib/musicVideoLayers.js';
import { renderableCues } from './composition.js';
import { renderTypographyOverlays, removeCompositionScratch, sweepCompositionScratch } from './compositionRender.js';

// Per-project render mutex (keyed by projectId so two projects can render in
// parallel; same-project re-entry returns 409 with the live jobId for re-attach).
const jobs = new Map();
const projectRenders = new Map();
// Reserved synchronously the instant a render is accepted, BEFORE the async
// prep (ffmpeg/audio/clip resolution) — so a double-click or second client
// can't pass the 409 check during that await window and spawn a duplicate.
const PENDING = Symbol('mv-render-pending');

// Append a finalized render to the shared video-history file. The per-project
// mutex above deliberately lets two DIFFERENT projects render (and finalize) in
// parallel, and this renderer bypasses the mediaJobQueue GPU lane that serializes
// the normal video-gen pipeline — so its append MUST share the ONE per-file
// serialization tail (`mutateVideoHistory` in videoGen/history.js) with every
// other writer of data/video-history.json (the video-gen finalizer, full-video
// downloads, stitch/upscale, timeline saves). A private second tail here would
// re-open the race against those other writers and drop an entry, leaving a
// "View rendered music video" deep link pointing at a 404. mutateVideoHistory
// keeps the lane alive if one append throws.
const appendToVideoHistory = (meta) =>
  mutateVideoHistory((history) => { history.unshift(meta); return history; });

export const attachRenderSseClient = (jobId, res) => attachSse(jobs, jobId, res);

// #8964 loop semantics. A scene saved before shot planning existed has no
// `loop` key and keeps the legacy behavior — its clip repeats to fill the
// authored span — so existing projects render exactly as they did. A scene
// created since carries an explicit boolean, and only `loop: true` repeats.
const sceneLoops = (scene) => scene?.loop !== false;

const round3 = (n) => Math.round(n * 1000) / 1000;

// A non-looping shot may run this much past its source clip; the gap holds the
// final frame (tpad) rather than repeating footage. Longer shortfalls block the
// render until the director resolves them.
const COVERAGE_TOLERANCE_SEC = 0.25;
const COVERAGE_RESOLUTIONS = Object.freeze(['trim', 'continue', 'replace', 'loop']);

/**
 * Pure: the snapped clips whose authored span needs more footage than their
 * non-looping source clip provides. Returns
 * `[{ sceneId, spanSec, clipSec, shortBySec }]` (empty when every shot is covered).
 */
function findCoverageShortfalls(clips, { toleranceSec = COVERAGE_TOLERANCE_SEC } = {}) {
  const out = [];
  for (const clip of Array.isArray(clips) ? clips : []) {
    if (clip.layer || clip.loop !== false) continue;
    const spanSec = clip.outSec - clip.inSec;
    const clipSec = clip.sourceSec ?? clip.duration;
    if (spanSec - clipSec > toleranceSec) {
      const round = (n) => Math.round(n * 100) / 100;
      out.push({ sceneId: clip.sceneId, spanSec: round(spanSec), clipSec: round(clipSec), shortBySec: round(spanSec - clipSec) });
    }
  }
  return out;
}

export function getRenderJobStatus(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  return { status: job.status, error: job.lastError };
}

export function cancelRender(jobId) {
  const job = jobs.get(jobId);
  if (!job) return false;
  // A composed render spends its first phase capturing the typography overlay
  // (no ffmpeg yet); abort that capture instead.
  if (!job.process) {
    if (job.status !== 'running' || !job.overlayAbort || job.overlayAbort.signal.aborted) return false;
    job.overlayAbort.abort(new Error('Render cancelled'));
    return true;
  }
  const proc = job.process;
  killWithEscalation(proc, { label: 'music-video render', stillRunning: () => job.process === proc });
  return true;
}

// Resolve the project's source audio to a verified path under data/music/.
// Mirrors the route's resolveAudioPath (track or uploaded file, safe basename).
export async function resolveMasterAudioPath(project) {
  let filename = null;
  if (project.trackId) {
    const track = await getTrack(project.trackId);
    if (!track) throw new ServerError('Linked track not found', { status: 404, code: 'NOT_FOUND' });
    filename = track.audioFilename;
  } else if (project.uploadedAudioFilename) {
    filename = project.uploadedAudioFilename;
  }
  if (!filename) {
    throw new ServerError('Project has no audio — set a track or upload audio first', { status: 400, code: 'NO_AUDIO' });
  }
  const safe = safeUnder(PATHS.music, filename);
  if (!safe || !existsSync(safe)) {
    throw new ServerError('Project audio file is missing', { status: 404, code: 'AUDIO_MISSING' });
  }
  return safe;
}

// A still/card section has no source clip to measure, so its authored span IS
// its length. Null when the scene is not timed.
const authoredSpan = (scene) => (sceneHasAuthoredSpan(scene) ? round3(scene.endSec - scene.startSec) : null);

// Resolve every scene that has a generated i2v clip (`videoHistoryId`) to a
// verified on-disk path + dims, in scene order. Scenes without a clip yet are
// skipped (not an error — they're just not rendered). A scene whose clip id
// references a missing history entry/file IS an error (404, listed).
//
// `layered` (a composed render, #8985) also resolves still and card sections
// in scene order. Neither needs footage: a still needs its selected reference
// frame (404 MISSING_STILLS when it is gone), and both need an authored span
// (422 UNTIMED_SECTIONS), since there is no clip to take a length from.
export async function resolveSceneClips(project, { layered = false } = {}) {
  const scenes = (Array.isArray(project.scenes) ? project.scenes : [])
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .filter((s) => s && (s.videoHistoryId || sceneVisualLayer(s, { layered }) !== 'footage'));
  if (scenes.length === 0) {
    throw new ServerError('No scene videos to render — generate at least one scene clip first', {
      status: 400, code: 'NO_SCENE_CLIPS',
    });
  }
  const history = scenes.some((s) => sceneVisualLayer(s, { layered }) === 'footage') ? await loadHistory() : [];
  const historyMap = new Map((Array.isArray(history) ? history : []).map((h) => [h.id, h]));
  const missing = [];
  const missingStills = [];
  const untimed = [];
  const clips = [];
  for (const scene of scenes) {
    const layer = sceneVisualLayer(scene, { layered });
    if (layer !== 'footage') {
      const spanSec = authoredSpan(scene);
      if (spanSec == null) { untimed.push(scene.sceneId); continue; }
      const section = { sceneId: scene.sceneId, layer, inSec: 0, outSec: spanSec, duration: spanSec, sourceSec: spanSec };
      if (layer === 'card') {
        clips.push({ ...section, cardText: typeof scene.cardText === 'string' ? scene.cardText.trim() : '', cardColor: /^#[0-9a-f]{6}$/i.test(scene.cardColor || '') ? scene.cardColor : '#000000' });
        continue;
      }
      const imagePath = scene.referenceImageId ? safeUnder(PATHS.images, scene.referenceImageId) : null;
      if (!imagePath || !existsSync(imagePath)) { missingStills.push(scene.sceneId); continue; }
      clips.push({ ...section, imagePath, move: scene.stillMove || 'hold' });
      continue;
    }
    const entry = historyMap.get(scene.videoHistoryId);
    const videoPath = entry && entry.filename ? safeUnder(PATHS.videos, entry.filename) : null;
    if (!entry || !videoPath || !existsSync(videoPath)) { missing.push(scene.videoHistoryId); continue; }
    const duration = entry.numFrames && entry.fps ? entry.numFrames / entry.fps : null;
    if (!duration || duration <= 0) { missing.push(scene.videoHistoryId); continue; }
    // A dimensionless history entry would make buildMusicVideoFfmpegArgs emit
    // `scale=undefined:undefined` (opaque ffmpeg failure); treat it as a missing
    // clip so the caller gets the clean MISSING_CLIPS 4xx, matching the duration guard.
    if (!entry.width || entry.width <= 0 || !entry.height || entry.height <= 0) { missing.push(scene.videoHistoryId); continue; }
    clips.push({
      sceneId: scene.sceneId,
      videoPath,
      width: entry.width,
      height: entry.height,
      fps: entry.fps || 24,
      duration,
      // The native source length survives the snap below (which rewrites
      // `duration` to the rendered span) so coverage can be judged against it.
      sourceSec: duration,
      loop: sceneLoops(scene),
      inSec: 0,
      outSec: duration,
    });
  }
  if (missing.length > 0) {
    throw new ServerError(`Missing source clips for ${missing.length} scene(s)`, {
      status: 404, code: 'MISSING_CLIPS', context: { missingClipIds: missing },
    });
  }
  if (missingStills.length > 0) {
    throw new ServerError(`${missingStills.length} still section(s) have no reference frame — generate or pick one first`, {
      status: 404, code: 'MISSING_STILLS', context: { sceneIds: missingStills },
    });
  }
  if (untimed.length > 0) {
    throw new ServerError(`${untimed.length} still or card section(s) need a start and end time`, {
      status: 422, code: 'UNTIMED_SECTIONS', context: { sceneIds: untimed },
    });
  }
  return clips;
}

// Pure: trim each clip's out-point so its cumulative cut lands on the nearest
// analyzed beat, when one is within `toleranceSec` and the trim keeps the clip
// at least `minClipSec` long. This derived, non-authored snap only SHORTENS a
// source clip. A director-authored beatAligned span is handled separately
// below and may exceed the native clip: a looping scene fills it by repeating
// the clip, a non-looping one is caught by findCoverageShortfalls (#8964).
// Returns a NEW clips array with adjusted `outSec`/`duration`.
// With no beats (no analysis) and no persisted scene arrangement, clips are
// returned unchanged.
//
// `scenes` (optional) is the project's scene list — when a clip's matching
// scene has `beatAligned: true` and a valid `startSec`/`endSec` (persisted by
// the BeatTimeline drag-snap arranger, #1854), that scene's saved duration is
// honored EXACTLY instead of being re-derived from the live beat grid: the
// director already snapped and saved it, so the render shouldn't silently
// recompute a different cut from whatever the grid says today. The ffmpeg
// builder loops finite source clips, so a saved music-video span may exceed a
// clip's native duration; it is still floored to `minClipSec`. The running
// cursor advances by the honored duration so any later, non-aligned clips keep
// snapping against the correct cumulative position.
export function beatSnapClips(clips, beats, { toleranceSec = 0.12, minClipSec = 0.4, scenes = null } = {}) {
  const grid = Array.isArray(beats) ? beats.filter((b) => typeof b === 'number' && b >= 0).sort((a, b) => a - b) : [];
  const scenesById = Array.isArray(scenes) ? new Map(scenes.map((s) => [s.sceneId, s])) : null;
  if (grid.length === 0 && !scenesById) return clips.map((c) => ({ ...c }));
  let running = 0;
  return clips.map((clip) => {
    // A still/card section (#8985) is exactly its authored span.
    if (clip.layer) {
      running += clip.duration;
      return { ...clip };
    }
    const scene = scenesById?.get(clip.sceneId);
    if (scene?.beatAligned && typeof scene.startSec === 'number' && typeof scene.endSec === 'number' && scene.endSec > scene.startSec) {
      // inSec stays 0 here deliberately: this only ever trims how much of the
      // clip plays, never which frames — there is no in-point/out-point
      // distinction. A legacy planned scene commonly spans much longer than
      // one generated 6–10s source clip; buildMusicVideoFfmpegArgs loops a
      // looping input, so the authored timeline duration is allowed to exceed
      // the source duration instead of silently truncating the final song. A
      // non-looping shot that does so is refused before render (#8964).
      const outSec = Math.max(minClipSec, scene.endSec - scene.startSec);
      running += outSec;
      return { ...clip, inSec: 0, outSec, duration: outSec };
    }
    if (grid.length === 0) {
      running += clip.duration;
      return { ...clip };
    }
    const naturalEnd = running + clip.duration;
    // Nearest beat at or before the natural end (snap trims, never extends).
    let best = null;
    for (const beat of grid) {
      if (beat > naturalEnd) break;
      best = beat;
    }
    let outSec = clip.outSec;
    if (best != null
      && (naturalEnd - best) <= toleranceSec
      && (best - running) >= minClipSec) {
      outSec = best - running; // trim relative to the clip's own start (inSec=0)
      running = best;
    } else {
      running = naturalEnd;
    }
    return { ...clip, inSec: 0, outSec, duration: outSec };
  });
}

// The frame for a composed render with no footage to take dimensions from.
const DEFAULT_CANVAS = Object.freeze({ width: 1280, height: 720, fps: 24 });
// A still's push-in ends this much closer; a pan crosses this much extra width.
const STILL_PUSH_ZOOM = 0.12;
const STILL_PAN_TRAVEL = 0.15;
const evenPx = (n) => Math.max(2, Math.round(n / 2) * 2);

// One section's video chain (without its output label). A footage clip is
// fitted, letterboxed and trimmed; a still (#8985) is cover-cropped and moved
// deterministically (every frame is a pure function of its frame number); a
// card is a solid colour the typography layer writes its text over. On the
// frame grid every section is cut to an exact frame count.
function sectionChain(c, input, { canonW, canonH, fps, frames, frameGrid }) {
  const trim = frameGrid ? `trim=end_frame=${frames}` : `trim=start=${c.inSec}:end=${c.outSec}`;
  if (c.layer === 'card') {
    return `color=c=0x${c.cardColor.slice(1)}:s=${canonW}x${canonH}:r=${fps},setsar=1,format=yuv420p,${trim},setpts=PTS-STARTPTS`;
  }
  if (c.layer === 'still') {
    const scale = c.move === 'push' ? 2 : c.move === 'pan' ? 1 + STILL_PAN_TRAVEL : 1;
    const coverW = evenPx(canonW * scale);
    const coverH = evenPx(canonH * scale);
    const move = c.move === 'push'
      // Rendered from a 2x cover so the slow zoom does not step pixel by pixel.
      ? `zoompan=z='1+${STILL_PUSH_ZOOM}*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${canonW}x${canonH}:fps=${fps},setsar=1,`
      : c.move === 'pan' ? `crop=${canonW}:${canonH}:x='(iw-ow)*n/${Math.max(1, frames - 1)}':y='(ih-oh)/2',` : '';
    return `[${input}:v]fps=${fps},scale=${coverW}:${coverH}:force_original_aspect_ratio=increase,crop=${coverW}:${coverH},setsar=1,`
      + `${move}format=yuv420p,${trim},setpts=PTS-STARTPTS`;
  }
  // A non-looping shot a hair longer than its source holds the last frame for
  // the remainder instead of ending early and drifting every later cut. On the
  // frame grid it also pads the rounding frame, so it always fills its count.
  const holdSec = c.loop === false ? (c.outSec - c.inSec) - (c.sourceSec ?? c.duration) : 0;
  const padSec = c.loop === false && frameGrid ? Math.max(0, holdSec) + 2 / fps : holdSec;
  const hold = padSec > 0 ? `tpad=stop_mode=clone:stop_duration=${round3(padSec)},` : '';
  return `[${input}:v]scale=${canonW}:${canonH}:force_original_aspect_ratio=decrease,`
    + `pad=${canonW}:${canonH}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},`
    + `${hold}${trim},setpts=PTS-STARTPTS`;
}

// Pure: build the ffmpeg args for the master-bed render. Concats the clips
// video-only (each scaled/padded to the canonical dims + fps and trimmed to its
// snapped out-point) and maps ONE external audio input as the sole output audio.
// `-shortest` ends the output at the shorter of (concatenated video, track).
// `overlays` (a composed render, #8984) are transparent typography clips, each
// offset to its song time and laid over the cut footage — the footage passes
// through untouched outside them, and the master audio is never re-cut.
//
// `frameGrid` (a composed render, #8985 — implied by any still/card section)
// cuts every section to a whole number of frames derived from its cumulative
// song-time boundary, so the edit never drifts more than half a frame from the
// authored timeline however many sections it has. Returns `sections`, each
// section's `[startSec, endSec)` on the output timebase.
export function buildMusicVideoFfmpegArgs(clips, audioPath, outputPath, { audioDurationSec = null, overlays = [], frameGrid: gridOption = false } = {}) {
  if (!Array.isArray(clips) || clips.length === 0) throw new Error('buildMusicVideoFfmpegArgs: empty clips');
  const frameGrid = gridOption || clips.some((c) => c.layer);
  // Stills and cards have no dimensions of their own: the first footage clip
  // sets the frame, or a default one when the render has no footage at all.
  const lead = clips.find((c) => !c.layer) || DEFAULT_CANVAS;
  const canonW = lead.width;
  const canonH = lead.height;
  const fps = lead.fps || 24;

  let cursorSec = 0;
  let cursorFrame = 0;
  const plan = [];
  for (const c of clips) {
    const startSec = cursorSec;
    cursorSec += c.outSec - c.inSec;
    const endFrame = Math.round(cursorSec * fps);
    const frames = endFrame - cursorFrame;
    const section = frameGrid
      ? { c, frames, startSec: cursorFrame / fps, endSec: endFrame / fps }
      : { c, frames, startSec, endSec: cursorSec };
    cursorFrame = endFrame;
    // A section shorter than half a frame has no frame of its own on the grid.
    if (!frameGrid || frames > 0) plan.push(section);
  }
  if (plan.length === 0) throw new Error('buildMusicVideoFfmpegArgs: no section spans a frame');

  const inputs = [];
  const inputOf = [];
  // A generated scene clip is a reusable shot source, while the director's
  // timeline owns how long that shot appears in the music video. A LOOPING
  // clip input repeats so a 6–10s Grok/local result can fill a longer verse or
  // chorus span; the per-input trim below still makes every loop finite. A
  // non-looping clip (#8964, `loop: false`) is read once — the render preflight
  // guarantees its span fits, within COVERAGE_TOLERANCE_SEC. A still loops its
  // single image; a card needs no input (its colour is a filter source).
  let nextInput = 0;
  for (const { c } of plan) {
    if (c.layer === 'card') { inputOf.push(null); continue; }
    inputOf.push(nextInput++);
    if (c.layer === 'still') inputs.push('-loop', '1', '-framerate', String(fps), '-i', c.imagePath);
    else {
      if (c.loop !== false) inputs.push('-stream_loop', '-1');
      inputs.push('-i', c.videoPath);
    }
  }
  const audioIdx = nextInput; // master audio follows the section inputs
  inputs.push('-i', audioPath);
  for (const overlay of overlays) inputs.push('-itsoffset', String(overlay.startSec), '-i', overlay.path);

  const filters = plan.map(({ c, frames }, i) => `${sectionChain(c, inputOf[i], { canonW, canonH, fps, frames, frameGrid })}[v${i}]`);
  const cutLabel = overlays.length > 0 ? 'cut0' : 'outv';
  filters.push(`${plan.map((_, i) => `[v${i}]`).join('')}concat=n=${plan.length}:v=1:a=0[${cutLabel}]`);
  overlays.forEach((_, k) => {
    const out = k === overlays.length - 1 ? 'outv' : `cut${k + 1}`;
    filters.push(`[cut${k}][${audioIdx + 1 + k}:v]overlay=eof_action=pass:format=auto[${out}]`);
  });

  const videoTotal = plan[plan.length - 1].endSec;
  const totalDuration = audioDurationSec != null ? Math.min(videoTotal, audioDurationSec) : videoTotal;
  const sections = plan.map(({ c, startSec, endSec }) => ({ sceneId: c.sceneId, layer: c.layer || 'footage', startSec, endSec }));

  const args = [
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[outv]',
    '-map', `${audioIdx}:a`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    '-movflags', '+faststart',
    '-progress', 'pipe:2',
    '-y',
    outputPath,
  ];
  return { args, totalDuration, canonW, canonH, fps, sections };
}

// A title card's text (#8985) is drawn by the typography layer for exactly
// its section on the output timebase, clipped to the rendered video.
export function sectionCardCues(clips, sections, durationSec) {
  const textBySceneId = new Map(clips.filter((c) => c.layer === 'card' && c.cardText).map((c) => [c.sceneId, c.cardText]));
  return sections
    .filter((section) => textBySceneId.has(section.sceneId) && section.startSec < durationSec)
    .map((section) => ({
      id: `card-${section.sceneId}`, text: textBySceneId.get(section.sceneId),
      startSec: section.startSec, endSec: Math.min(section.endSec, durationSec),
      template: 'fade', placement: 'center', emphasis: 'hero',
    }));
}

export async function renderMusicVideo(projectId) {
  const project = await getProject(projectId);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });

  const existingJob = projectRenders.get(projectId);
  if (existingJob && (existingJob === PENDING || jobs.has(existingJob))) {
    throw new ServerError('Render already in progress for this project', {
      status: 409, code: 'RENDER_IN_PROGRESS', context: { jobId: existingJob === PENDING ? null : existingJob },
    });
  }
  // Reserve the slot SYNCHRONOUSLY (no await between the check above and here)
  // so a concurrent same-project start can't slip through during prep. Released
  // in the `finally` below if prep throws or we never reach the spawn handoff.
  projectRenders.set(projectId, PENDING);

  let handedOff = false;
  try {
    const ffmpeg = await findFfmpeg();
    if (!ffmpeg) throw new ServerError('ffmpeg not found on PATH', { status: 500, code: 'FFMPEG_MISSING' });

    const audioPath = await resolveMasterAudioPath(project);
    // #8985: a composed render cuts still and card sections into the same
    // timebase as the footage; plain concat renders footage only, as before.
    const composed = project.composition?.mode === 'composed';
    const rawClips = await resolveSceneClips(project, { layered: composed });
    const audioDurationSec = await probeVideoDuration(audioPath).catch(() => null);
    const beats = project.audioAnalysis?.beats;
    const clips = beatSnapClips(rawClips, beats, { scenes: project.scenes });
    // #8964: a new (non-looping) shot must never silently repeat footage to
    // fill its span. Refuse the render and name the shots that need a trim,
    // a continuation, a replacement clip, or an explicit loop.
    const shortfalls = findCoverageShortfalls(clips);
    if (shortfalls.length > 0) {
      throw new ServerError(
        `${shortfalls.length} shot${shortfalls.length === 1 ? ' is' : 's are'} longer than ${shortfalls.length === 1 ? 'its' : 'their'} source clip — trim, continue, replace, or loop ${shortfalls.length === 1 ? 'it' : 'them'} before rendering`,
        { status: 422, code: 'INSUFFICIENT_CLIP_COVERAGE', context: { shortfalls, resolutions: COVERAGE_RESOLUTIONS } },
      );
    }
    await ensureDir(PATHS.videos);
    await ensureDir(PATHS.videoThumbnails);

    const jobId = randomUUID();
    const filename = `music-video-${projectId.slice(0, 8)}-${Date.now()}.mp4`;
    const outputPath = join(PATHS.videos, filename);
    const { args, totalDuration, canonW, canonH, fps, sections } = buildMusicVideoFfmpegArgs(clips, audioPath, outputPath, { audioDurationSec, frameGrid: composed });
    // #8984: a composed project lays its timed text cues over the cut, and a
    // title card's text (#8985) joins them over its own section. No renderable
    // cue (plain mode, or nothing timed) skips the overlay capture entirely.
    const cues = [...renderableCues(project.composition, totalDuration), ...sectionCardCues(clips, sections, totalDuration)]
      .sort((a, b) => a.startSec - b.startSec);
    const composition = cues.length > 0 ? project.composition : null;

    const job = { id: jobId, projectId, status: 'running', clients: [], process: null, totalDuration };
    jobs.set(jobId, job);
    projectRenders.set(projectId, jobId);
    handedOff = true; // the job lifecycle now owns the projectRenders entry

    // Capture the pre-render status so a cancel restores it rather than blindly
    // downgrading a previously-'complete' project to 'ready'. Fall back to 'ready'
    // if it was somehow already 'rendering'.
    const priorStatus = project.status && project.status !== 'rendering' ? project.status : 'ready';
    // Mark the project rendering so the board reflects an in-flight render even
    // on a client that didn't initiate it (federates via emitRecordUpdated).
    await updateProject(projectId, { status: 'rendering' }).catch((err) => {
      console.error(`❌ Music-video render [${jobId.slice(0, 8)}] project ${projectId.slice(0, 8)} status→rendering write failed: ${err.message}`);
    });

    console.log(`🎬 Rendering music video [${jobId.slice(0, 8)}]: project=${projectId.slice(0, 8)} clips=${clips.length} cues=${cues.length} duration=${totalDuration.toFixed(2)}s`);

    const releaseScratch = () => (composition ? removeCompositionScratch(jobId).catch((err) => {
      console.warn(`⚠️ Music-video render [${jobId.slice(0, 8)}] could not remove its overlay scratch: ${err.message}`);
    }) : null);

    // A composed render first captures its overlay (progress 0–50%), then
    // encodes (50–100%); a plain render encodes across the whole bar.
    const startEncode = (encodeArgs, progressBase = 0) => {
      const encodeProgress = (fraction) => progressBase + (1 - progressBase) * fraction;
      const proc = spawn(ffmpeg, encodeArgs, safeChildProcessOptions({ stdio: ['ignore', 'ignore', 'pipe'] }));
      job.process = proc;

      let stderrBuf = '';
      proc.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString();
        const lines = stderrBuf.split('\n');
        stderrBuf = lines.pop();
        for (const raw of lines) {
          const line = raw.trim();
          const eq = line.indexOf('=');
          if (eq <= 0) continue;
          const key = line.slice(0, eq);
          const val = line.slice(eq + 1);
          if (key === 'out_time_us') {
            const us = parseInt(val, 10);
            if (Number.isFinite(us) && totalDuration > 0) {
              broadcastSse(job, { type: 'progress', progress: encodeProgress(Math.min(1, (us / 1_000_000) / totalDuration)) });
            }
          } else if (key === 'progress' && val === 'end') {
            broadcastSse(job, { type: 'progress', progress: 1 });
          }
        }
      });

      // Spawn-state tracking + exactly-once terminal guard + pre-vs-post-spawn
      // dispatch live in the shared helper; only the finalize bodies below are
      // service-specific (music-video mutates the project's render status).
      attachFfmpegRenderGuard(proc, {
        label: `Music-video render [${jobId.slice(0, 8)}]`,
        onProcessError: (err) => {
          // Post-spawn error (e.g. a failed kill during cancel). The ffmpeg is
          // still live — do NOT release the project mutex or null job.process
          // here, or a replacement render could spawn and overlap it. Record
          // the reason; the pending 'close' runs the sole terminal finalization.
          job.lastError = `ffmpeg process error: ${err.message}`;
          console.log(`⚠️ Music-video render post-spawn error [${jobId.slice(0, 8)}]: ${err.message}`);
        },
        onSpawnError: async (err) => {
          // Pre-spawn failure: the child never started, so 'close' won't follow.
          job.process = null;
          job.status = 'error';
          const reason = `Failed to spawn ffmpeg: ${err.message}`;
          job.lastError = reason;
          console.error(`❌ Music-video render spawn error [${jobId.slice(0, 8)}]: ${reason}`);
          broadcastSse(job, { type: 'error', error: reason });
          projectRenders.delete(projectId);
          await updateProject(projectId, { status: 'failed' }).catch((updateErr) => {
            console.error(`❌ Music-video render [${jobId.slice(0, 8)}] project ${projectId.slice(0, 8)} status→failed write failed: ${updateErr.message}`);
          });
          await releaseScratch();
          closeJobAfterDelay(jobs, jobId);
        },
        onClose: async (code, signal) => {
          job.process = null;
          if (code !== 0) {
            const canceled = signal === 'SIGTERM' || signal === 'SIGKILL';
            job.status = canceled ? 'canceled' : 'error';
            const reason = canceled ? 'Render cancelled' : signal ? `Killed by signal ${signal}` : `ffmpeg exit ${code}`;
            job.lastError = reason;
            // A cancel is a user action (stdout); a non-zero exit is a failure (#7945).
            const logClose = canceled ? console.log : console.error;
            logClose(`${canceled ? '🛑' : '❌'} Music-video render ${canceled ? 'cancelled' : 'failed'} [${jobId.slice(0, 8)}]: ${reason}`);
            await unlink(outputPath).catch(() => {});
            broadcastSse(job, { type: canceled ? 'canceled' : 'error', error: reason });
            projectRenders.delete(projectId);
            // A cancel restores the pre-render status (so a cancelled re-render of a
            // 'complete' project stays 'complete'); a real failure marks it 'failed'.
            const targetStatus = canceled ? priorStatus : 'failed';
            await updateProject(projectId, { status: targetStatus }).catch((updateErr) => {
              console.error(`❌ Music-video render [${jobId.slice(0, 8)}] project ${projectId.slice(0, 8)} status→${targetStatus} write failed: ${updateErr.message}`);
            });
            await releaseScratch();
            closeJobAfterDelay(jobs, jobId);
            return;
          }
          // Success finalization runs in an event callback (no request to bubble
          // to) — a throw in thumbnailing/history I/O would otherwise leave the
          // project stuck 'rendering' and projectRenders un-cleared (every later
          // render 409s). Wrap it so any failure still emits a terminal frame and
          // releases the slot.
          try {
            job.status = 'complete';
            const section = (project.audioAnalysis?.sections || [])
              .filter(section => Number.isFinite(section.energy) && section.startSec >= 0 && section.endSec > section.startSec && section.startSec < totalDuration)
              .sort((a, b) => b.energy - a.energy || a.startSec - b.startSec)[0];
            // An explicitly chosen poster frame (#8984) wins over the loudest-section guess.
            const posterSec = project.composition?.posterSec;
            const atSec = typeof posterSec === 'number' && posterSec < totalDuration ? posterSec
              : section ? (section.startSec + Math.min(section.endSec, totalDuration)) / 2 : undefined;
            const thumb = await generateThumbnail(outputPath, jobId, { atSec });
            const meta = {
              id: jobId,
              prompt: `Music Video: ${project.name}`,
              modelId: 'music-video',
              seed: 0,
              width: canonW,
              height: canonH,
              numFrames: Math.round(totalDuration * (fps || 24)),
              fps: fps || 24,
              filename,
              thumbnail: thumb,
              createdAt: new Date().toISOString(),
              musicVideoProjectId: projectId,
            };
            await appendToVideoHistory(meta);
            await updateProject(projectId, { renderHistoryId: jobId, status: 'complete' }).catch((updateErr) => {
              console.error(`❌ Music-video render [${jobId.slice(0, 8)}] project ${projectId.slice(0, 8)} status→complete write failed: ${updateErr.message}`);
            });
            console.log(`✅ Music video rendered [${jobId.slice(0, 8)}]: ${filename}`);
            broadcastSse(job, { type: 'complete', result: { id: jobId, filename, thumbnail: thumb, path: `/data/videos/${filename}` } });
          } catch (err) {
            job.status = 'error';
            job.lastError = `Finalize failed: ${err.message}`;
            console.error(`❌ Music-video render finalize failed [${jobId.slice(0, 8)}]: ${err.message}`);
            broadcastSse(job, { type: 'error', error: 'Render finalize failed' });
            await updateProject(projectId, { status: 'failed' }).catch((updateErr) => {
              console.error(`❌ Music-video render [${jobId.slice(0, 8)}] project ${projectId.slice(0, 8)} status→failed write failed: ${updateErr.message}`);
            });
          } finally {
            projectRenders.delete(projectId);
            await releaseScratch();
            closeJobAfterDelay(jobs, jobId);
          }
        },
      });
    };

    if (!composition) {
      startEncode(args);
      return { jobId };
    }

    // Composed: capture the overlay in the background (the route returns the
    // jobId at once; progress/cancel flow through the job like the encode's).
    // A capture failure or cancel is terminal here, since no ffmpeg exists yet
    // for the render guard to finalize.
    job.overlayAbort = new AbortController();
    const { signal } = job.overlayAbort;
    renderTypographyOverlays({
      jobId, cues, style: composition.style, width: canonW, height: canonH, fps, durationSec: totalDuration, signal,
      onProgress: (fraction) => broadcastSse(job, { type: 'progress', progress: 0.5 * fraction }),
    }).then((overlays) => {
      signal.throwIfAborted();
      // Capture is over: from here a cancel kills the encode (job.process).
      job.overlayAbort = null;
      const layered = buildMusicVideoFfmpegArgs(clips, audioPath, outputPath, { audioDurationSec, overlays, frameGrid: true });
      startEncode(layered.args, 0.5);
    }).catch(async (err) => {
      const canceled = signal.aborted;
      job.status = canceled ? 'canceled' : 'error';
      const reason = canceled ? 'Render cancelled' : `Typography overlay failed: ${err.message}`;
      job.lastError = reason;
      const log = canceled ? console.log : console.error;
      log(`${canceled ? '🛑' : '❌'} Music-video render ${canceled ? 'cancelled' : 'failed'} [${jobId.slice(0, 8)}]: ${reason}`);
      broadcastSse(job, { type: canceled ? 'canceled' : 'error', error: reason });
      projectRenders.delete(projectId);
      const targetStatus = canceled ? priorStatus : 'failed';
      await updateProject(projectId, { status: targetStatus }).catch((updateErr) => {
        console.error(`❌ Music-video render [${jobId.slice(0, 8)}] project ${projectId.slice(0, 8)} status→${targetStatus} write failed: ${updateErr.message}`);
      });
      await releaseScratch();
      closeJobAfterDelay(jobs, jobId);
    });

    return { jobId };
  } finally {
    // Prep threw (or we never handed off to the job lifecycle) — release the
    // reserved slot so a stale PENDING can't 409 every future render.
    if (!handedOff) projectRenders.delete(projectId);
  }
}

// Boot recovery: a render job cannot survive a restart, so a persisted
// 'rendering' status with no live job is stale. Demote it to 'complete' when a
// finished render is already recorded, otherwise to 'ready'. A list failure
// propagates to the bootstrap caller's logBootstrapFailure rather than
// reporting zero recovered.
export async function recoverStuckMusicVideoRenders() {
  // No overlay capture survives a restart either; drop any scratch it left.
  await sweepCompositionScratch().catch((err) => {
    console.warn(`⚠️ Music Video recovery: could not remove stale overlay scratch: ${err.message}`);
  });
  const stuck = (await listProjects()).filter((p) => p?.status === 'rendering' && !projectRenders.has(p.id));
  let recovered = 0;
  for (const project of stuck) {
    const targetStatus = project.renderHistoryId ? 'complete' : 'ready';
    const ok = await updateProject(project.id, { status: targetStatus }).then(() => true, (err) => {
      console.error(`❌ Music Video recovery: project ${project.id.slice(0, 8)} status→${targetStatus} write failed: ${err.message}`);
      return false;
    });
    if (ok) recovered++;
  }
  if (stuck.length > 0) console.log(`🎬 Music Video boot recovery: demoted ${recovered}/${stuck.length} stuck render(s)`);
}
