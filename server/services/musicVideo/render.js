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

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { unlink } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay } from '../../lib/sseUtils.js';
import { findFfmpeg, safeUnder, generateThumbnail, probeVideoDuration } from '../../lib/ffmpeg.js';
import { safeChildProcessEnv } from '../../lib/processEnv.js';
import { loadHistory, mutateVideoHistory } from '../videoGen/local.js';
import { getTrack } from '../tracks/index.js';
import { getProject, updateProject } from './projects.js';

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

export function getRenderJobStatus(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  return { status: job.status, error: job.lastError };
}

export function cancelRender(jobId) {
  const job = jobs.get(jobId);
  if (!job || !job.process) return false;
  const proc = job.process;
  proc.kill('SIGTERM');
  setTimeout(() => {
    if (job.process === proc && proc.exitCode === null && proc.signalCode === null) {
      console.log(`⚠️ music-video render didn't exit on SIGTERM — escalating to SIGKILL`);
      proc.kill('SIGKILL');
    }
  }, 8000);
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

// Resolve every scene that has a generated i2v clip (`videoHistoryId`) to a
// verified on-disk path + dims, in scene order. Scenes without a clip yet are
// skipped (not an error — they're just not rendered). A scene whose clip id
// references a missing history entry/file IS an error (404, listed).
export async function resolveSceneClips(project) {
  const scenes = (Array.isArray(project.scenes) ? project.scenes : [])
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .filter((s) => s && s.videoHistoryId);
  if (scenes.length === 0) {
    throw new ServerError('No scene videos to render — generate at least one scene clip first', {
      status: 400, code: 'NO_SCENE_CLIPS',
    });
  }
  const history = await loadHistory();
  const historyMap = new Map((Array.isArray(history) ? history : []).map((h) => [h.id, h]));
  const missing = [];
  const clips = [];
  for (const scene of scenes) {
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
      inSec: 0,
      outSec: duration,
    });
  }
  if (missing.length > 0) {
    throw new ServerError(`Missing source clips for ${missing.length} scene(s)`, {
      status: 404, code: 'MISSING_CLIPS', context: { missingClipIds: missing },
    });
  }
  return clips;
}

// Pure: trim each clip's out-point so its cumulative cut lands on the nearest
// analyzed beat, when one is within `toleranceSec` and the trim keeps the clip
// at least `minClipSec` long. Snapping only ever SHORTENS a clip (a clip can't
// be extended past its rendered length), so a cut can move earlier onto a beat
// but never later. Returns a NEW clips array with adjusted `outSec`/`duration`.
// With no beats (no analysis) and no persisted scene arrangement, clips are
// returned unchanged.
//
// `scenes` (optional) is the project's scene list — when a clip's matching
// scene has `beatAligned: true` and a valid `startSec`/`endSec` (persisted by
// the BeatTimeline drag-snap arranger, #1854), that scene's saved duration is
// honored EXACTLY instead of being re-derived from the live beat grid: the
// director already snapped and saved it, so the render shouldn't silently
// recompute a different cut from whatever the grid says today. Clamped to the
// clip's own rendered length (a saved duration can't make a clip longer than
// what was actually generated) and to `minClipSec`. The running cursor still
// advances by the honored duration so any later, non-aligned clips keep
// snapping against the correct cumulative position.
export function beatSnapClips(clips, beats, { toleranceSec = 0.12, minClipSec = 0.4, scenes = null } = {}) {
  const grid = Array.isArray(beats) ? beats.filter((b) => typeof b === 'number' && b >= 0).sort((a, b) => a - b) : [];
  const scenesById = Array.isArray(scenes) ? new Map(scenes.map((s) => [s.sceneId, s])) : null;
  if (grid.length === 0 && !scenesById) return clips.map((c) => ({ ...c }));
  let running = 0;
  return clips.map((clip) => {
    const scene = scenesById?.get(clip.sceneId);
    if (scene?.beatAligned && typeof scene.startSec === 'number' && typeof scene.endSec === 'number' && scene.endSec > scene.startSec) {
      // inSec stays 0 here deliberately: this only ever trims how much of the
      // clip plays, never which frames — there is no in-point/out-point
      // distinction. The BeatTimeline client intentionally exposes only a
      // right-edge (out-point) trim handle for the same reason (#1854).
      const outSec = Math.min(clip.duration, Math.max(minClipSec, scene.endSec - scene.startSec));
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

// Pure: build the ffmpeg args for the master-bed render. Concats the clips
// video-only (each scaled/padded to the canonical dims + fps and trimmed to its
// snapped out-point) and maps ONE external audio input as the sole output audio.
// `-shortest` ends the output at the shorter of (concatenated video, track).
export function buildMusicVideoFfmpegArgs(clips, audioPath, outputPath, { audioDurationSec = null } = {}) {
  if (!Array.isArray(clips) || clips.length === 0) throw new Error('buildMusicVideoFfmpegArgs: empty clips');
  const canonW = clips[0].width;
  const canonH = clips[0].height;
  const fps = clips[0].fps || 24;

  const inputs = [];
  for (const c of clips) inputs.push('-i', c.videoPath);
  const audioIdx = clips.length; // master audio is the last input
  inputs.push('-i', audioPath);

  const filters = [];
  const vStreams = [];
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    filters.push(
      `[${i}:v]scale=${canonW}:${canonH}:force_original_aspect_ratio=decrease,`
      + `pad=${canonW}:${canonH}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},`
      + `trim=start=${c.inSec}:end=${c.outSec},setpts=PTS-STARTPTS[v${i}]`,
    );
    vStreams.push(`[v${i}]`);
  }
  filters.push(`${vStreams.join('')}concat=n=${clips.length}:v=1:a=0[outv]`);

  const videoTotal = clips.reduce((s, c) => s + (c.outSec - c.inSec), 0);
  const totalDuration = audioDurationSec != null ? Math.min(videoTotal, audioDurationSec) : videoTotal;

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
  return { args, totalDuration, canonW, canonH, fps };
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
    const rawClips = await resolveSceneClips(project);
    const audioDurationSec = await probeVideoDuration(audioPath).catch(() => null);
    const beats = project.audioAnalysis?.beats;
    const clips = beatSnapClips(rawClips, beats, { scenes: project.scenes });
    await ensureDir(PATHS.videos);
    await ensureDir(PATHS.videoThumbnails);

    const jobId = randomUUID();
    const filename = `music-video-${projectId.slice(0, 8)}-${Date.now()}.mp4`;
    const outputPath = join(PATHS.videos, filename);
    const { args, totalDuration, canonW, canonH, fps } = buildMusicVideoFfmpegArgs(clips, audioPath, outputPath, { audioDurationSec });

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
    await updateProject(projectId, { status: 'rendering' }).catch(() => {});

    console.log(`🎬 Rendering music video [${jobId.slice(0, 8)}]: project=${projectId.slice(0, 8)} clips=${clips.length} duration=${totalDuration.toFixed(2)}s`);

    const proc = spawn(ffmpeg, args, { env: safeChildProcessEnv(), stdio: ['ignore', 'ignore', 'pipe'] });
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
            broadcastSse(job, { type: 'progress', progress: Math.min(1, (us / 1_000_000) / totalDuration) });
          }
        } else if (key === 'progress' && val === 'end') {
          broadcastSse(job, { type: 'progress', progress: 1 });
        }
      }
    });

    proc.on('error', async (err) => {
      job.status = 'error';
      const reason = `Failed to spawn ffmpeg: ${err.message}`;
      job.lastError = reason;
      console.log(`❌ Music-video render spawn error [${jobId.slice(0, 8)}]: ${reason}`);
      broadcastSse(job, { type: 'error', error: reason });
      projectRenders.delete(projectId);
      await updateProject(projectId, { status: 'failed' }).catch(() => {});
      closeJobAfterDelay(jobs, jobId);
    });

    proc.on('close', async (code, signal) => {
      job.process = null;
      if (code !== 0) {
        const canceled = signal === 'SIGTERM' || signal === 'SIGKILL';
        job.status = canceled ? 'canceled' : 'error';
        const reason = canceled ? 'Render cancelled' : signal ? `Killed by signal ${signal}` : `ffmpeg exit ${code}`;
        job.lastError = reason;
        console.log(`${canceled ? '🛑' : '❌'} Music-video render ${canceled ? 'cancelled' : 'failed'} [${jobId.slice(0, 8)}]: ${reason}`);
        await unlink(outputPath).catch(() => {});
        broadcastSse(job, { type: canceled ? 'canceled' : 'error', error: reason });
        projectRenders.delete(projectId);
        // A cancel restores the pre-render status (so a cancelled re-render of a
        // 'complete' project stays 'complete'); a real failure marks it 'failed'.
        await updateProject(projectId, { status: canceled ? priorStatus : 'failed' }).catch(() => {});
        closeJobAfterDelay(jobs, jobId);
        return;
      }
      // Success finalization runs in an event callback (no request to bubble to)
      // — a throw in thumbnailing/history I/O would otherwise leave the project
      // stuck 'rendering' and projectRenders un-cleared (every later render 409s).
      // Wrap it so any failure still emits a terminal frame and releases the slot.
      try {
        job.status = 'complete';
        const thumb = await generateThumbnail(outputPath, jobId);
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
        await updateProject(projectId, { renderHistoryId: jobId, status: 'complete' }).catch(() => {});
        console.log(`✅ Music video rendered [${jobId.slice(0, 8)}]: ${filename}`);
        broadcastSse(job, { type: 'complete', result: { id: jobId, filename, thumbnail: thumb, path: `/data/videos/${filename}` } });
      } catch (err) {
        job.status = 'error';
        job.lastError = `Finalize failed: ${err.message}`;
        console.error(`❌ Music-video render finalize failed [${jobId.slice(0, 8)}]: ${err.message}`);
        broadcastSse(job, { type: 'error', error: 'Render finalize failed' });
        await updateProject(projectId, { status: 'failed' }).catch(() => {});
      } finally {
        projectRenders.delete(projectId);
        closeJobAfterDelay(jobs, jobId);
      }
    });

    return { jobId };
  } finally {
    // Prep threw (or we never handed off to the job lifecycle) — release the
    // reserved slot so a stale PENDING can't 409 every future render.
    if (!handedOff) projectRenders.delete(projectId);
  }
}
