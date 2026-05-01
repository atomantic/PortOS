/**
 * Video Timeline — non-linear editor backend.
 *
 * Lets users compose multiple already-generated video clips into a single
 * output video with per-clip in/out trim and drag-drop ordering. Distinct
 * from videoGen/local.js#stitchVideos: that one is stream-copy concat (no
 * trim, requires identical codec/dims). This one re-encodes through a
 * filter_complex graph so trims, mixed-audio inputs, and dim mismatches
 * across LTX-2 model versions all work safely.
 *
 * Projects persist to data/video-projects.json. Output entries land in the
 * existing data/video-history.json with a `timelineProjectId` flag so
 * Media History shows them alongside generated clips.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { unlink } from 'fs/promises';
import { join, basename } from 'path';
import { randomUUID } from 'crypto';
import { ensureDir, PATHS, readJSONFile, atomicWrite } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay } from '../../lib/sseUtils.js';
import { findFfmpeg, findFfprobe, safeUnder, generateThumbnail, optimizeForStreaming } from '../../lib/ffmpeg.js';
import { loadHistory, saveHistory } from '../videoGen/local.js';

const PROJECTS_FILE = join(PATHS.data, 'video-projects.json');

// Per-project render mutex map. Keyed by projectId so two different projects
// can render in parallel; same project re-render returns 409 with the
// existing jobId so the UI can attach SSE instead of getting a stale failure.
const jobs = new Map();
const projectRenders = new Map(); // projectId → jobId

export const attachSseClient = (jobId, res) => attachSse(jobs, jobId, res);

// =====================================================================
// Project CRUD
// =====================================================================

export const loadProjects = () => readJSONFile(PROJECTS_FILE, []);
const saveProjects = (projects) => atomicWrite(PROJECTS_FILE, projects);

export async function listProjects() {
  return loadProjects();
}

export async function getProject(id) {
  const projects = await loadProjects();
  return projects.find((p) => p.id === id) || null;
}

export async function createProject(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) throw new ServerError('Project name required', { status: 400, code: 'VALIDATION_ERROR' });
  const projects = await loadProjects();
  const now = new Date().toISOString();
  const project = {
    id: randomUUID(),
    name: trimmed,
    createdAt: now,
    updatedAt: now,
    clips: [],
  };
  projects.unshift(project);
  await saveProjects(projects);
  console.log(`🎬 Timeline project created: ${project.id.slice(0, 8)} "${project.name}"`);
  return project;
}

// Validate a single clip patch entry. Returns the cleaned object or throws.
// We don't trust client-supplied numFrames/fps — those come from the history
// entry at render time. Only clipId + inSec/outSec are persisted.
const validateClip = (raw, idx) => {
  if (!raw || typeof raw !== 'object') {
    throw new ServerError(`Clip ${idx}: must be an object`, { status: 400, code: 'VALIDATION_ERROR' });
  }
  const clipId = String(raw.clipId || '').trim();
  if (!/^[a-f0-9-]{36}$/i.test(clipId)) {
    throw new ServerError(`Clip ${idx}: invalid clipId`, { status: 400, code: 'VALIDATION_ERROR' });
  }
  const inSec = Number(raw.inSec);
  const outSec = Number(raw.outSec);
  if (!Number.isFinite(inSec) || !Number.isFinite(outSec) || inSec < 0 || outSec <= inSec) {
    throw new ServerError(`Clip ${idx}: inSec/outSec invalid (need 0 ≤ inSec < outSec)`, { status: 400, code: 'VALIDATION_ERROR' });
  }
  return { clipId, inSec, outSec };
};

export async function updateProject(id, patch, expectedUpdatedAt) {
  const projects = await loadProjects();
  const idx = projects.findIndex((p) => p.id === id);
  if (idx === -1) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const project = projects[idx];
  if (expectedUpdatedAt && project.updatedAt !== expectedUpdatedAt) {
    throw new ServerError('Project was modified by another writer', {
      status: 409, code: 'CONFLICT', context: { current: project.updatedAt },
    });
  }
  if (patch.name != null) {
    const trimmed = String(patch.name).trim();
    if (!trimmed) throw new ServerError('Project name cannot be empty', { status: 400, code: 'VALIDATION_ERROR' });
    project.name = trimmed;
  }
  if (patch.clips != null) {
    if (!Array.isArray(patch.clips)) {
      throw new ServerError('clips must be an array', { status: 400, code: 'VALIDATION_ERROR' });
    }
    project.clips = patch.clips.map(validateClip);
  }
  project.updatedAt = new Date().toISOString();
  projects[idx] = project;
  await saveProjects(projects);
  return project;
}

export async function deleteProject(id) {
  const projects = await loadProjects();
  const filtered = projects.filter((p) => p.id !== id);
  if (filtered.length === projects.length) {
    throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  }
  await saveProjects(filtered);
  console.log(`🗑️ Timeline project deleted: ${id.slice(0, 8)}`);
  return { ok: true };
}

// =====================================================================
// Render pipeline
// =====================================================================

// ffprobe a clip to find out whether it has an audio stream. Used to decide
// whether to wire the clip's audio through trim/aresample chain or to insert
// an anullsrc silent input. Returns null when ffprobe is missing — caller
// treats that as "no audio" so the render still succeeds.
const probeAudio = async (videoPath) => {
  const ffprobe = await findFfprobe();
  if (!ffprobe) return false;
  return new Promise((resolve) => {
    const proc = spawn(ffprobe, [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_type',
      '-of', 'default=nw=1:nk=1',
      videoPath,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout.on('data', (c) => { out += c.toString(); });
    proc.on('close', () => resolve(out.trim() === 'audio'));
    proc.on('error', () => resolve(false));
  });
};

// Resolve every clip in a project to a verified on-disk path + duration +
// audio-presence. Throws ServerError(404) listing every missing/invalid clip
// so the editor can highlight them. Returns the array of resolved entries
// in project order.
export async function resolveClips(project) {
  if (!Array.isArray(project.clips) || project.clips.length === 0) {
    throw new ServerError('Project has no clips', { status: 400, code: 'EMPTY_PROJECT' });
  }
  const history = await loadHistory();
  const historyMap = new Map(history.map((h) => [h.id, h]));
  const missing = [];
  const prepared = [];
  for (let i = 0; i < project.clips.length; i++) {
    const ref = project.clips[i];
    const entry = historyMap.get(ref.clipId);
    if (!entry) { missing.push(ref.clipId); continue; }
    const videoPath = safeUnder(PATHS.videos, entry.filename);
    if (!videoPath || !existsSync(videoPath)) { missing.push(ref.clipId); continue; }
    const sourceDuration = entry.numFrames && entry.fps ? entry.numFrames / entry.fps : null;
    const inSec = Math.max(0, ref.inSec);
    const outSec = sourceDuration != null ? Math.min(ref.outSec, sourceDuration) : ref.outSec;
    if (outSec - inSec < 1 / Math.max(1, entry.fps || 24)) {
      throw new ServerError(`Clip ${i} trim too short — must be ≥ 1 frame`, {
        status: 400, code: 'CLIP_TOO_SHORT', context: { index: i, clipId: ref.clipId },
      });
    }
    prepared.push({ i, ref, entry, videoPath, inSec, outSec });
  }
  if (missing.length > 0) {
    throw new ServerError(`Missing source clips: ${missing.length}`, {
      status: 404, code: 'MISSING_CLIPS', context: { missingClipIds: missing },
    });
  }
  // ffprobe spawns one child per clip — parallelize so 5 clips don't add 5×
  // sequential probe latency to render startup.
  const audioFlags = await Promise.all(prepared.map((p) => probeAudio(p.videoPath)));
  return prepared.map((p, idx) => ({
    index: p.i,
    clipId: p.ref.clipId,
    videoPath: p.videoPath,
    inSec: p.inSec,
    outSec: p.outSec,
    duration: p.outSec - p.inSec,
    width: p.entry.width,
    height: p.entry.height,
    fps: p.entry.fps,
    hasAudio: audioFlags[idx],
  }));
}

// scale+pad, aresample, and aformat are unconditional belt-and-suspenders.
// Without them, mixed LTX-2 versions error with "Input link parameters do
// not match" mid-render.
export function buildFfmpegArgs(clips, outputPath) {
  if (clips.length === 0) throw new Error('buildFfmpegArgs: empty clips');
  const canonW = clips[0].width;
  const canonH = clips[0].height;

  const inputs = [];
  const filters = [];
  const concatStreams = [];

  let inputIdx = 0;
  const indices = clips.map((c) => {
    const vIdx = inputIdx++;
    inputs.push('-i', c.videoPath);
    let aIdx;
    if (c.hasAudio) {
      aIdx = vIdx;
    } else {
      // -t bounds the otherwise-infinite anullsrc to match the trimmed clip
      // duration so concat=v=1:a=1 gets a length-matched silent track.
      aIdx = inputIdx++;
      inputs.push('-f', 'lavfi', '-t', String(c.duration), '-i', `anullsrc=channel_layout=stereo:sample_rate=48000`);
    }
    return { vIdx, aIdx };
  });

  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const { vIdx, aIdx } = indices[i];
    filters.push(
      `[${vIdx}:v]scale=${canonW}:${canonH}:force_original_aspect_ratio=decrease,pad=${canonW}:${canonH}:(ow-iw)/2:(oh-ih)/2,setsar=1,trim=start=${c.inSec}:end=${c.outSec},setpts=PTS-STARTPTS[v${i}]`
    );
    if (c.hasAudio) {
      filters.push(
        `[${aIdx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start=${c.inSec}:end=${c.outSec},asetpts=PTS-STARTPTS[a${i}]`
      );
    } else {
      filters.push(`[${aIdx}:a]asetpts=PTS-STARTPTS[a${i}]`);
    }
    concatStreams.push(`[v${i}][a${i}]`);
  }

  filters.push(`${concatStreams.join('')}concat=n=${clips.length}:v=1:a=1[outv][outa]`);

  const totalDuration = clips.reduce((s, c) => s + c.duration, 0);

  const args = [
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[outv]',
    '-map', '[outa]',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    '-progress', 'pipe:2',
    '-y',
    outputPath,
  ];

  return { args, totalDuration, canonW, canonH, fps: clips[0].fps };
}

export function cancelRender(jobId) {
  const job = jobs.get(jobId);
  if (!job || !job.process) return false;
  const proc = job.process;
  proc.kill('SIGTERM');
  setTimeout(() => {
    if (job.process === proc && proc.exitCode === null && proc.signalCode === null) {
      console.log(`⚠️ ffmpeg render didn't exit on SIGTERM — escalating to SIGKILL`);
      proc.kill('SIGKILL');
    }
  }, 8000);
  return true;
}

export async function renderProject(projectId) {
  const project = await getProject(projectId);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });

  // Per-project mutex — return the existing jobId so the UI can re-attach
  // SSE instead of getting a stale 500. A different project can render in
  // parallel; only same-project re-entry is blocked.
  const existingJob = projectRenders.get(projectId);
  if (existingJob && jobs.has(existingJob)) {
    throw new ServerError('Render already in progress for this project', {
      status: 409, code: 'RENDER_IN_PROGRESS', context: { jobId: existingJob },
    });
  }

  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new ServerError('ffmpeg not found on PATH', { status: 500, code: 'FFMPEG_MISSING' });

  // Resolve clips and build args BEFORE claiming the mutex — if either step
  // throws (missing clips, validation), a stale projectRenders entry would
  // permanently block future renders of this project.
  const clips = await resolveClips(project);
  await ensureDir(PATHS.videos);
  await ensureDir(PATHS.videoThumbnails);

  const jobId = randomUUID();
  const filename = `timeline-${projectId.slice(0, 8)}-${Date.now()}.mp4`;
  const outputPath = join(PATHS.videos, filename);
  const { args, totalDuration, canonW, canonH, fps } = buildFfmpegArgs(clips, outputPath);

  const job = {
    id: jobId,
    projectId,
    status: 'running',
    clients: [],
    process: null,
    totalDuration,
  };
  jobs.set(jobId, job);
  projectRenders.set(projectId, jobId);

  console.log(`🎞️ Rendering timeline [${jobId.slice(0, 8)}]: project=${projectId.slice(0, 8)} clips=${clips.length} duration=${totalDuration.toFixed(2)}s`);

  const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  job.process = proc;

  // ffmpeg's -progress pipe:2 emits key=value lines, one per line, every
  // few hundred ms. The relevant key is `out_time_us` (microseconds of
  // output written so far). Divide by total duration to get a 0..1 ratio.
  let stderrBuf = '';
  proc.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq);
      const val = line.slice(eq + 1);
      if (key === 'out_time_us') {
        const us = parseInt(val, 10);
        if (Number.isFinite(us) && totalDuration > 0) {
          const progress = Math.min(1, (us / 1_000_000) / totalDuration);
          broadcastSse(job, { type: 'progress', progress });
        }
      } else if (key === 'progress' && val === 'end') {
        broadcastSse(job, { type: 'progress', progress: 1 });
      }
    }
  });

  proc.on('error', (err) => {
    job.status = 'error';
    const reason = `Failed to spawn ffmpeg: ${err.message}`;
    console.log(`❌ Timeline render spawn error [${jobId.slice(0, 8)}]: ${reason}`);
    broadcastSse(job, { type: 'error', error: reason });
    projectRenders.delete(projectId);
    closeJobAfterDelay(jobs, jobId);
  });

  proc.on('close', async (code, signal) => {
    job.process = null;
    if (code !== 0) {
      job.status = 'error';
      const reason = signal === 'SIGKILL'
        ? 'Render killed (cancelled or out of memory)'
        : signal ? `Killed by signal ${signal}` : `ffmpeg exit ${code}`;
      console.log(`❌ Timeline render failed [${jobId.slice(0, 8)}]: ${reason}`);
      await unlink(outputPath).catch(() => {});
      broadcastSse(job, { type: 'error', error: reason });
      projectRenders.delete(projectId);
      closeJobAfterDelay(jobs, jobId);
      return;
    }
    job.status = 'complete';
    await optimizeForStreaming(outputPath);
    const thumb = await generateThumbnail(outputPath, jobId);

    // Push to existing video history with a timelineProjectId flag so the
    // Media History page picks it up alongside generated clips.
    const renderedNumFrames = Math.round(totalDuration * (fps || 24));
    const meta = {
      id: jobId,
      prompt: `Timeline: ${project.name}`,
      modelId: 'timeline',
      seed: 0,
      width: canonW,
      height: canonH,
      numFrames: renderedNumFrames,
      fps: fps || 24,
      filename,
      thumbnail: thumb,
      createdAt: new Date().toISOString(),
      timelineProjectId: projectId,
    };
    const history = await loadHistory();
    history.unshift(meta);
    await saveHistory(history);
    console.log(`✅ Timeline rendered [${jobId.slice(0, 8)}]: ${filename}`);
    broadcastSse(job, { type: 'complete', result: { id: jobId, filename, thumbnail: thumb, path: `/data/videos/${filename}` } });
    projectRenders.delete(projectId);
    closeJobAfterDelay(jobs, jobId);
  });

  return { jobId };
}
