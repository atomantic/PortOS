/**
 * Video Timeline — non-linear editor backend.
 *
 * Lets users compose multiple already-generated video clips into a single
 * output video with per-clip in/out trim and drag-drop ordering. Distinct
 * from videoGen/local.js#stitchVideos: that one is a stream-copy concat by
 * default (requires identical codec/dims), and only reaches a filter graph —
 * via lib/ffmpeg.js#buildTrimConcatArgs — when a chained render hands it
 * leading-frame cuts. This one always re-encodes through a filter_complex
 * graph, with per-clip in AND out points, so trims, mixed-audio inputs, and
 * dim mismatches across LTX-2 model versions all work safely.
 *
 * Projects persist to data/video-projects.json. Output entries land in the
 * existing data/video-history.json with a `timelineProjectId` flag so
 * Media History shows them alongside generated clips.
 */

import { spawn } from '../../lib/childProcess.js';
import { existsSync } from 'fs';
import { unlink } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { ensureDir, PATHS, readJSONFile, atomicWrite } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay } from '../../lib/sseUtils.js';
import { findFfmpeg, findFfprobe, safeUnder, generateThumbnail, probeVideoDuration, BT709_CONTAINER_ARGS, bt709TagFilter } from '../../lib/ffmpeg.js';
import { safeChildProcessOptions } from '../../lib/processEnv.js';
import { killWithEscalation } from '../../lib/killWithEscalation.js';
import { attachFfmpegRenderGuard } from '../../lib/ffmpegRenderGuard.js';
import { mapWithConcurrency } from '../../lib/mapWithConcurrency.js';
import { createFileWriteQueue } from '../../lib/fileWriteQueue.js';
import { loadHistory, mutateVideoHistory } from '../videoGen/local.js';
import {
  TIMELINE_SCHEMA_VERSION,
  IMAGE_ASSET_KINDS,
  AUDIO_ASSET_KINDS,
  normalizeProject,
  validateSegments,
  validateOverlays,
  validateAudio,
  defaultAudio,
  deriveLegacyClips,
  resolveAsset,
  fitFades,
} from './segments.js';

const PROJECTS_FILE = join(PATHS.data, 'video-projects.json');

// ffprobe spawns one child per source, so cap the fan-out: a 200-segment
// project would otherwise fork-bomb on render startup.
const PROBE_CONCURRENCY = 8;
// A stills-only project has no clip to take geometry from.
const DEFAULT_CANVAS = { width: 1280, height: 720, fps: 24 };
// Floor for a probe-clamped audio slice — atrim with start === end produces
// an empty stream that amix rejects.
const MIN_MEDIA_SEC = 0.05;
// Every audio branch entering concat must present identical link parameters.
const AUDIO_NORM = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';

// Per-project render mutex map. Keyed by projectId so two different projects
// can render in parallel; same project re-render returns 409 with the
// existing jobId so the UI can attach SSE instead of getting a stale failure.
const jobs = new Map();
const projectRenders = new Map(); // projectId → jobId

export const attachSseClient = (jobId, res) => attachSse(jobs, jobId, res);

/**
 * Return the current status of a render job, or null if unknown.
 * Lets external callers (e.g. stitchRunner) detect ffmpeg failures fast
 * instead of waiting for a polling timeout.
 * @param {string} jobId
 * @returns {{ status: string, error?: string } | null}
 */
export function getRenderJobStatus(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  return { status: job.status, error: job.lastError };
}

// =====================================================================
// Project CRUD
// =====================================================================

// Raw, un-normalized read. Callers that touch a single record (or only compare
// ids) use this and normalize just what they need — normalizing every project
// on every request is pure waste on a library of any size.
const loadRawProjects = async () => {
  const raw = await readJSONFile(PROJECTS_FILE, []);
  return Array.isArray(raw) ? raw : [];
};

export const loadProjects = async () => {
  // Defend against a hand-edited / corrupted JSON state file. Without this,
  // a non-array root would crash every CRUD path with "x.findIndex is not a
  // function" instead of degrading gracefully to an empty list.
  // Every read upgrades v1 (`clips`-only) projects to the v2 lane shape in
  // memory, so the rest of the service only ever sees `segments`/`overlays`/
  // `audio`. The on-disk upgrade is migration 296; this keeps a project the
  // migration missed (a restored backup, a hand-edited file) working anyway.
  return (await loadRawProjects()).map(normalizeProject);
};
// Every mutator read-modify-writes ONE shared file, so they share ONE tail:
// each waits for the previous to settle before it reads, and therefore merges
// against the freshest persisted state. Without it two concurrent PATCHes — a
// debounced lane save and the flush Render issues — can both read the same
// `updatedAt`, both pass the conflict check, and the later write silently
// erases the earlier one's lane (server/AGENTS.md, "write serialization").
const queueProjectWrite = createFileWriteQueue();

const saveProjects = async (projects) => {
  // First write on a fresh install lands before PATHS.data is created by any
  // other service — without ensureDir it would ENOENT on the temp-file write
  // inside atomicWrite.
  await ensureDir(PATHS.data);
  return atomicWrite(PROJECTS_FILE, projects);
};

export async function listProjects() {
  return loadProjects();
}

export async function getProject(id) {
  const project = (await loadRawProjects()).find((p) => p.id === id);
  return project ? normalizeProject(project) : null;
}

export const createProject = (name) => queueProjectWrite(() => createProjectNow(name));

async function createProjectNow(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) throw new ServerError('Project name required', { status: 400, code: 'VALIDATION_ERROR' });
  const projects = await loadProjects();
  const now = new Date().toISOString();
  const project = {
    id: randomUUID(),
    name: trimmed,
    createdAt: now,
    updatedAt: now,
    schemaVersion: TIMELINE_SCHEMA_VERSION,
    segments: [],
    overlays: [],
    audio: defaultAudio(),
    clips: [],
  };
  projects.unshift(project);
  await saveProjects(projects);
  console.log(`🎬 Timeline project created: ${project.id.slice(0, 8)} "${project.name}"`);
  return project;
}

// The video lane replaces v1's flat `clips` array. `validateSegments` owns
// every per-entry rule (clip trim bounds, still duration, asset containment,
// fades that fit inside their own duration) for both shapes — we don't trust
// client-supplied numFrames/fps here either; those come from the history
// entry at render time.

export const updateProject = (id, patch, expectedUpdatedAt) => queueProjectWrite(
  () => updateProjectNow(id, patch, expectedUpdatedAt),
);

async function updateProjectNow(id, patch, expectedUpdatedAt) {
  const projects = await loadProjects();
  const idx = projects.findIndex((p) => p.id === id);
  if (idx === -1) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const project = projects[idx];
  // Treat any explicitly-provided value (including '' or wrong type) as a
  // concurrency assertion — only `undefined` skips the check. A truthy guard
  // would silently let an empty-string `expectedUpdatedAt` clobber a
  // newer-than-claimed project.
  if (expectedUpdatedAt !== undefined) {
    if (typeof expectedUpdatedAt !== 'string' || project.updatedAt !== expectedUpdatedAt) {
      throw new ServerError('Project was modified by another writer', {
        status: 409, code: 'CONFLICT', context: { current: project.updatedAt },
      });
    }
  }
  if (patch.name != null) {
    const trimmed = String(patch.name).trim();
    if (!trimmed) throw new ServerError('Project name cannot be empty', { status: 400, code: 'VALIDATION_ERROR' });
    project.name = trimmed;
  }
  if (patch.segments != null) {
    project.segments = validateSegments(patch.segments);
  } else if (patch.clips != null) {
    // Legacy v1 client: a flat clip array replaces the whole video lane, and is
    // upgraded in place so the persisted model stays single-shaped.
    //
    // A v1 build reads the `clips` mirror and cannot see stills, so letting it
    // write that mirror back would silently DELETE every still in the lane —
    // turning a degraded read into unrecoverable data loss on the next save.
    // Refuse instead, the way every other version-gated payload in PortOS does.
    if (!Array.isArray(patch.clips)) {
      throw new ServerError('clips must be an array', { status: 400, code: 'VALIDATION_ERROR' });
    }
    // A `clips` entry carries only { clipId, inSec, outSec }, so rebuilding the
    // lane from one erases every layered field it cannot express — a still
    // outright, and a clip's fades and volume back to their neutral defaults.
    const wouldDrop = (project.segments || []).filter((s) => s.type !== 'clip'
      || s.fadeInSec > 0 || s.fadeOutSec > 0 || (s.volume != null && s.volume !== 1));
    if (wouldDrop.length > 0) {
      throw new ServerError('Project uses the layered timeline — a clips-only save would drop its stills, fades or volume', {
        status: 409,
        code: 'SCHEMA_TOO_NEW',
        context: { schemaVersion: TIMELINE_SCHEMA_VERSION, droppedSegmentCount: wouldDrop.length },
      });
    }
    project.segments = validateSegments(patch.clips.map((c) => ({ type: 'clip', ...(c && typeof c === 'object' ? c : {}) })));
  }
  if (patch.overlays != null) project.overlays = validateOverlays(patch.overlays);
  if (patch.audio != null) project.audio = validateAudio(patch.audio);
  // `clips` is a derived mirror, never an input to the render — rebuild it from
  // the authoritative lane on every write so it can't drift.
  project.schemaVersion = TIMELINE_SCHEMA_VERSION;
  project.clips = deriveLegacyClips(project.segments || []);
  project.updatedAt = new Date().toISOString();
  projects[idx] = project;
  await saveProjects(projects);
  return project;
}

export const deleteProject = (id) => queueProjectWrite(() => deleteProjectNow(id));

async function deleteProjectNow(id) {
  // Only ids are compared here — nothing to normalize.
  const projects = await loadRawProjects();
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
// an anullsrc silent input. Falls back to false when ffprobe is missing so
// the render can still proceed (silent track inserted for every clip).
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
    ], safeChildProcessOptions({ stdio: ['ignore', 'pipe', 'ignore'] }));
    let out = '';
    proc.stdout.on('data', (c) => { out += c.toString(); });
    proc.on('close', () => resolve(out.trim() === 'audio'));
    proc.on('error', () => resolve(false));
  });
};

// Run `probe` over the DISTINCT paths in `paths`, bounded by PROBE_CONCURRENCY,
// and return a path → result map. Deduping here rather than at the call site
// keeps a timeline that reuses one source from spawning an ffprobe per
// placement.
const probeByPath = async (paths, probe) => {
  const distinct = [...new Set(paths)];
  const results = await mapWithConcurrency(distinct, PROBE_CONCURRENCY, probe);
  return new Map(distinct.map((p, i) => [p, results[i]]));
};

// Resolve a project's three lanes to verified on-disk paths + durations +
// audio-presence. Throws ServerError(404) listing every missing clip AND every
// missing asset so the editor can highlight them all in one pass instead of
// surfacing one broken reference per failed render.
export async function resolveTimeline(rawProject) {
  // getProject already normalized — only a caller handing us a raw record pays
  // for a second full rebuild.
  const project = rawProject?.schemaVersion === TIMELINE_SCHEMA_VERSION ? rawProject : normalizeProject(rawProject);
  const segments = project.segments || [];
  if (segments.length === 0) {
    throw new ServerError('Project has no clips', { status: 400, code: 'EMPTY_PROJECT' });
  }
  const history = await loadHistory();
  // loadHistory comes from the JSON state file; defend against corruption so
  // a non-array root degrades to "all clips missing" rather than crashing.
  const historyList = Array.isArray(history) ? history : [];
  const historyMap = new Map(historyList.map((h) => [h.id, h]));
  const missing = [];
  const missingAssets = [];
  const prepared = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.type === 'still') {
      const assetPath = resolveAsset(seg.assetKind, seg.assetFile, { allowedKinds: IMAGE_ASSET_KINDS });
      if (!assetPath) { missingAssets.push(`${seg.assetKind}/${seg.assetFile}`); continue; }
      prepared.push({
        kind: 'still', i, seg, assetPath, duration: seg.durationSec,
        fades: fitFades(seg.fadeInSec, seg.fadeOutSec, seg.durationSec),
      });
      continue;
    }
    const entry = historyMap.get(seg.clipId);
    if (!entry) { missing.push(seg.clipId); continue; }
    const videoPath = safeUnder(PATHS.videos, entry.filename);
    if (!videoPath || !existsSync(videoPath)) { missing.push(seg.clipId); continue; }
    const sourceDuration = entry.numFrames && entry.fps ? entry.numFrames / entry.fps : null;
    const inSec = Math.max(0, seg.inSec);
    const outSec = sourceDuration != null ? Math.min(seg.outSec, sourceDuration) : seg.outSec;
    if (outSec - inSec < 1 / Math.max(1, entry.fps || 24)) {
      throw new ServerError(`Clip ${i} trim too short — must be ≥ 1 frame`, {
        status: 400, code: 'CLIP_TOO_SHORT', context: { index: i, clipId: seg.clipId },
      });
    }
    // A fade authored against the stored trim can outlast a clip that the
    // history entry has since shortened; rescale rather than emitting a
    // negative fade start (which renders as an all-black segment).
    const duration = outSec - inSec;
    const fades = fitFades(seg.fadeInSec, seg.fadeOutSec, duration);
    prepared.push({ kind: 'clip', i, seg, entry, videoPath, inSec, outSec, duration, fades });
  }

  const overlays = [];
  for (const ov of project.overlays || []) {
    const assetPath = resolveAsset(ov.assetKind, ov.assetFile, { allowedKinds: IMAGE_ASSET_KINDS });
    if (!assetPath) { missingAssets.push(`${ov.assetKind}/${ov.assetFile}`); continue; }
    overlays.push({ ...ov, assetPath });
  }

  const audioTracks = [];
  for (const tr of project.audio?.tracks || []) {
    const assetPath = resolveAsset(tr.assetKind, tr.assetFile, { allowedKinds: AUDIO_ASSET_KINDS });
    if (!assetPath) { missingAssets.push(`${tr.assetKind}/${tr.assetFile}`); continue; }
    audioTracks.push({ ...tr, assetPath });
  }

  if (missing.length > 0 || missingAssets.length > 0) {
    throw new ServerError(`Missing timeline sources: ${missing.length + missingAssets.length}`, {
      status: 404, code: 'MISSING_CLIPS', context: { missingClipIds: missing, missingAssets },
    });
  }

  // Probe once per distinct FILE, not per placement: a cut that returns to the
  // same source clip, or a bed placed twice, would otherwise spawn an identical
  // ffprobe per occurrence. Both fan-outs are independent, so they share the
  // wall clock — each stays capped at PROBE_CONCURRENCY on its own.
  const clipEntries = prepared.filter((p) => p.kind === 'clip');
  const [audioFlagByPath, durationByPath] = await Promise.all([
    probeByPath(clipEntries.map((p) => p.videoPath), probeAudio),
    probeByPath(audioTracks.map((tr) => tr.assetPath), probeVideoDuration),
  ]);

  for (const p of clipEntries) p.hasAudio = audioFlagByPath.get(p.videoPath) === true;

  for (const tr of audioTracks) {
    const probed = durationByPath.get(tr.assetPath);
    // A probe reporting LESS than the requested slice is authoritative.
    // `null` (no ffprobe on PATH, unreadable container) must NOT collapse into
    // "0 seconds available" — leave the stored slice alone in that case.
    if (probed == null) continue;
    tr.offsetSec = Math.min(tr.offsetSec, Math.max(0, probed - MIN_MEDIA_SEC));
    tr.durationSec = Math.min(tr.durationSec, Math.max(MIN_MEDIA_SEC, probed - tr.offsetSec));
    const fitted = fitFades(tr.fadeInSec, tr.fadeOutSec, tr.durationSec);
    tr.fadeInSec = fitted.fadeInSec;
    tr.fadeOutSec = fitted.fadeOutSec;
  }

  const resolvedSegments = prepared.map((p) => (p.kind === 'still'
    ? {
      type: 'still',
      index: p.i,
      assetKind: p.seg.assetKind,
      assetFile: p.seg.assetFile,
      assetPath: p.assetPath,
      duration: p.duration,
      fadeInSec: p.fades.fadeInSec,
      fadeOutSec: p.fades.fadeOutSec,
    }
    : {
      type: 'clip',
      index: p.i,
      clipId: p.seg.clipId,
      videoPath: p.videoPath,
      inSec: p.inSec,
      outSec: p.outSec,
      duration: p.duration,
      width: p.entry.width,
      height: p.entry.height,
      fps: p.entry.fps,
      hasAudio: p.hasAudio,
      fadeInSec: p.fades.fadeInSec,
      fadeOutSec: p.fades.fadeOutSec,
      volume: p.seg.volume,
    }));

  // Pick the geometry off the first clip that actually HAS dimensions. An
  // uploaded or downloaded clip carries no width/height (videoUpload.js /
  // videoDownload.js write no dims), so taking the first clip unconditionally
  // would letterbox a whole project into the 720p fallback because of one
  // dims-less entry — and the editor's preview, which skips those, would then
  // show a different canvas than the render produces.
  const firstClip = resolvedSegments.find((seg) => seg.type === 'clip' && seg.width > 0 && seg.height > 0);
  const firstFps = resolvedSegments.find((seg) => seg.type === 'clip' && seg.fps > 0);
  return {
    segments: resolvedSegments,
    overlays,
    audioTracks,
    clipVolume: project.audio?.clipVolume ?? 1,
    // A stills-only project has no intrinsic geometry — fall back to 720p/24
    // rather than letting scale/pad inherit `undefined` and fail the graph.
    canonW: firstClip?.width || DEFAULT_CANVAS.width,
    canonH: firstClip?.height || DEFAULT_CANVAS.height,
    fps: firstFps?.fps || DEFAULT_CANVAS.fps,
  };
}

// Filter-graph number formatting. Raw interpolation of a subtraction result
// leaks float noise (`2.9000000000000004`) into the graph string, while
// toFixed would pad clean integers to `4.000`. Round to microseconds, then
// stringify.
const fmt = (n) => String(Math.round(Number(n) * 1e6) / 1e6);

const fadeChain = (prefix, { fadeInSec = 0, fadeOutSec = 0 }, duration, lead = []) => {
  const parts = [...lead];
  if (fadeInSec > 0) parts.push(`${prefix}=t=in:st=0:d=${fmt(fadeInSec)}`);
  if (fadeOutSec > 0) {
    parts.push(`${prefix}=t=out:st=${fmt(Math.max(0, duration - fadeOutSec))}:d=${fmt(fadeOutSec)}`);
  }
  return parts.length > 0 ? `,${parts.join(',')}` : '';
};

// scale+pad, format, aresample and aformat are unconditional
// belt-and-suspenders. Without them, mixed LTX-2 versions error with "Input
// link parameters do not match" mid-render — and an RGBA still concatenated
// after a yuv420p clip fails exactly the same way.
//
// Takes a RESOLVED timeline from resolveTimeline() — every segment already
// carries its on-disk path, its project-time `duration`, and (for a clip) its
// probed `hasAudio`. Geometry comes off the timeline rather than being
// re-derived here, so exactly one place decides the canvas.
export function buildFfmpegArgs(timeline, outputPath, { colorTagFilter = null } = {}) {
  const t = timeline || {};
  const segments = t.segments || [];
  if (segments.length === 0) throw new Error('buildFfmpegArgs: empty clips');
  const overlays = t.overlays || [];
  const audioTracks = t.audioTracks || [];
  const clipVolume = t.clipVolume == null ? 1 : t.clipVolume;

  const canonW = t.canonW || DEFAULT_CANVAS.width;
  const canonH = t.canonH || DEFAULT_CANVAS.height;
  const fps = t.fps || DEFAULT_CANVAS.fps;

  const inputs = [];
  const filters = [];
  const concatStreams = [];
  let inputIdx = 0;

  const totalDuration = segments.reduce((sum, seg) => sum + seg.duration, 0);

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const isStill = seg.type === 'still';
    const { duration } = seg;

    const vIdx = inputIdx++;
    if (isStill) {
      // -loop 1 turns a single image into an endless stream; -t bounds it to
      // the segment's held duration so concat receives a finite input.
      inputs.push('-loop', '1', '-t', fmt(duration), '-i', seg.assetPath);
    } else {
      inputs.push('-i', seg.videoPath);
    }

    // fps=<canon> resamples each source to the timeline's canonical frame rate;
    // without it, concat fails with "Input link parameters do not match" when a
    // project mixes clips of different fps (e.g. a 24fps generation next to a
    // 30fps one) or holds a still alongside them.
    const trim = isStill
      ? `trim=start=0:end=${fmt(duration)}`
      : `trim=start=${fmt(seg.inSec)}:end=${fmt(seg.outSec)}`;
    filters.push(
      `[${vIdx}:v]scale=${canonW}:${canonH}:force_original_aspect_ratio=decrease,pad=${canonW}:${canonH}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,fps=${fps},${trim},setpts=PTS-STARTPTS${fadeChain('fade', seg, duration)}[v${i}]`
    );

    // The silent stub must share the real-audio branches' sample format and
    // layout — concat=v=1:a=1 fails fast with "Input link parameters do not
    // match" if they diverge.
    if (!isStill && seg.hasAudio) {
      const vol = clipVolume * (seg.volume == null ? 1 : seg.volume);
      const lead = vol === 1 ? [] : [`volume=${fmt(vol)}`];
      filters.push(
        `[${vIdx}:a]${AUDIO_NORM},atrim=start=${fmt(seg.inSec)}:end=${fmt(seg.outSec)},asetpts=PTS-STARTPTS${fadeChain('afade', seg, duration, lead)}[a${i}]`
      );
    } else {
      // -t bounds the otherwise-infinite anullsrc to the segment's duration so
      // concat gets a length-matched silent track. No volume or fade here — the
      // stream is already silence.
      const aIdx = inputIdx++;
      inputs.push('-f', 'lavfi', '-t', fmt(duration), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
      filters.push(`[${aIdx}:a]${AUDIO_NORM},asetpts=PTS-STARTPTS[a${i}]`);
    }
    concatStreams.push(`[v${i}][a${i}]`);
  }

  // Label the concat outputs as the FINAL outputs whenever no later lane
  // post-processes them, so a plain clip-only project still produces the exact
  // minimal graph it always has.
  // From ffmpeg 8 the encoder reads colour properties off the FRAMES, silently
  // overriding the container flags — so a flags-only output still decodes
  // washed-out. `setparams` stamps the frames; the caller probes for it once
  // (`bt709TagFilter()`) and passes the string in, keeping this builder pure.
  const tag = typeof colorTagFilter === 'string' && colorTagFilter ? colorTagFilter : null;
  const videoOut = tag ? '[vpre]' : '[outv]';
  const vConcatOut = overlays.length > 0 ? '[cv]' : videoOut;
  const aConcatOut = audioTracks.length > 0 ? '[ca]' : '[outa]';
  filters.push(`${concatStreams.join('')}concat=n=${segments.length}:v=1:a=1${vConcatOut}${aConcatOut}`);

  // Overlay lane. Each overlay input is looped for the WHOLE timeline rather
  // than just its own window: overlay() blocks waiting on a secondary frame
  // when the secondary stream starts late, so we keep it always-available and
  // gate visibility with enable=between(). The alpha fades therefore run on
  // the shared timeline clock, not an overlay-local one.
  let overlayIn = '[cv]';
  overlays.forEach((ov, j) => {
    const oIdx = inputIdx++;
    inputs.push('-loop', '1', '-t', fmt(totalDuration), '-i', ov.assetPath);
    // -2 keeps the auto-derived height even — libx264 rejects odd dimensions
    // once the overlay is composited back into yuv420p.
    const w = Math.max(2, Math.round((ov.width * canonW) / 2) * 2);
    const x = Math.round(ov.x * canonW);
    const y = Math.round(ov.y * canonH);
    const end = Math.min(totalDuration, ov.startSec + ov.durationSec);
    // An overlay running past the end of the video lane has its window cut
    // short, which can leave its fades longer than the window itself. Refit
    // them against the VISIBLE span — the same rule the preview applies — or
    // the ramp never completes before `enable` cuts the overlay off, and the
    // render pops from most-of-opaque to nothing on the last frame.
    const fades = fitFades(ov.fadeInSec, ov.fadeOutSec, end - ov.startSec);
    const chain = [`scale=${w}:-2`, `fps=${fps}`, 'format=rgba'];
    if (ov.opacity < 1) chain.push(`colorchannelmixer=aa=${fmt(ov.opacity)}`);
    if (fades.fadeInSec > 0) chain.push(`fade=t=in:st=${fmt(ov.startSec)}:d=${fmt(fades.fadeInSec)}:alpha=1`);
    if (fades.fadeOutSec > 0) {
      chain.push(`fade=t=out:st=${fmt(end - fades.fadeOutSec)}:d=${fmt(fades.fadeOutSec)}:alpha=1`);
    }
    filters.push(`[${oIdx}:v]${chain.join(',')}[ov${j}]`);
    const out = j === overlays.length - 1 ? videoOut : `[ovc${j}]`;
    filters.push(
      `${overlayIn}[ov${j}]overlay=x=${x}:y=${y}:eof_action=pass:enable='between(t,${fmt(ov.startSec)},${fmt(end)})'${out}`
    );
    overlayIn = out;
  });

  // Audio bed. Each track is trimmed from its own offset, faded on its own
  // clock, then delayed to its project-time start before mixing under the
  // concatenated lane audio. normalize=0 keeps adding a second bed from
  // silently attenuating everything already in the mix.
  if (audioTracks.length > 0) {
    const bedLabels = [];
    audioTracks.forEach((tr, j) => {
      const aIdx = inputIdx++;
      inputs.push('-i', tr.assetPath);
      const parts = [
        'aresample=48000',
        'aformat=sample_fmts=fltp:channel_layouts=stereo',
        `atrim=start=${fmt(tr.offsetSec)}:end=${fmt(tr.offsetSec + tr.durationSec)}`,
        'asetpts=PTS-STARTPTS',
      ];
      if (tr.volume !== 1) parts.push(`volume=${fmt(tr.volume)}`);
      if (tr.fadeInSec > 0) parts.push(`afade=t=in:st=0:d=${fmt(tr.fadeInSec)}`);
      if (tr.fadeOutSec > 0) {
        parts.push(`afade=t=out:st=${fmt(Math.max(0, tr.durationSec - tr.fadeOutSec))}:d=${fmt(tr.fadeOutSec)}`);
      }
      if (tr.startSec > 0) {
        const ms = Math.round(tr.startSec * 1000);
        parts.push(`adelay=${ms}|${ms}`);
      }
      filters.push(`[${aIdx}:a]${parts.join(',')}[bed${j}]`);
      bedLabels.push(`[bed${j}]`);
    });
    filters.push(
      `[ca]${bedLabels.join('')}amix=inputs=${bedLabels.length + 1}:duration=first:dropout_transition=0:normalize=0[outa]`
    );
  }

  if (tag) filters.push(`[vpre]${tag}[outv]`);

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
    // Untagged H.264 decodes washed-out or over-saturated depending on the
    // player; stills and overlays re-encoded here must match the tagged stitch
    // path or one output file carries two colour interpretations.
    ...BT709_CONTAINER_ARGS,
    '-movflags', '+faststart',
    '-progress', 'pipe:2',
    '-y',
    outputPath,
  ];

  return { args, totalDuration, canonW, canonH, fps };
}

export function cancelRender(jobId) {
  const job = jobs.get(jobId);
  if (!job || !job.process) return false;
  const proc = job.process;
  killWithEscalation(proc, { label: 'ffmpeg render', stillRunning: () => job.process === proc });
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

  // Resolve every lane and build args BEFORE claiming the mutex — if either
  // step throws (missing clips or assets, validation), a stale projectRenders
  // entry would permanently block future renders of this project.
  const timeline = await resolveTimeline(project);
  await ensureDir(PATHS.videos);
  await ensureDir(PATHS.videoThumbnails);

  const jobId = randomUUID();
  const filename = `timeline-${projectId.slice(0, 8)}-${Date.now()}.mp4`;
  const outputPath = join(PATHS.videos, filename);
  const { args, totalDuration, canonW, canonH, fps } = buildFfmpegArgs(timeline, outputPath, { colorTagFilter: await bt709TagFilter() });

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

  console.log(`🎞️ Rendering timeline [${jobId.slice(0, 8)}]: project=${projectId.slice(0, 8)} segments=${timeline.segments.length} overlays=${timeline.overlays.length} beds=${timeline.audioTracks.length} duration=${totalDuration.toFixed(2)}s`);

  const proc = spawn(ffmpeg, args, safeChildProcessOptions({ stdio: ['ignore', 'ignore', 'pipe'] }));
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

  // Spawn-state tracking + exactly-once terminal guard + pre-vs-post-spawn
  // dispatch live in the shared helper; only the finalize bodies below are
  // service-specific (timeline does NOT mutate any project status).
  attachFfmpegRenderGuard(proc, {
    label: `Timeline render [${jobId.slice(0, 8)}]`,
    onProcessError: (err) => {
      // Post-spawn error (e.g. a failed kill during cancel). The ffmpeg is
      // still live — do NOT release the project mutex or null job.process
      // here, or a replacement render could spawn and overlap it. Record the
      // reason; the pending 'close' runs the sole terminal finalization.
      job.lastError = `ffmpeg process error: ${err.message}`;
      console.log(`⚠️ Timeline render post-spawn error [${jobId.slice(0, 8)}]: ${err.message}`);
    },
    onSpawnError: (err) => {
      // Pre-spawn failure: the child never started, so 'close' won't follow.
      job.process = null;
      job.status = 'error';
      const reason = `Failed to spawn ffmpeg: ${err.message}`;
      job.lastError = reason;
      console.log(`❌ Timeline render spawn error [${jobId.slice(0, 8)}]: ${reason}`);
      broadcastSse(job, { type: 'error', error: reason });
      projectRenders.delete(projectId);
      closeJobAfterDelay(jobs, jobId);
    },
    onClose: async (code, signal) => {
      // Runs outside the request lifecycle — an uncaught throw from
      // generateThumbnail/loadHistory/saveHistory would crash the process, so
      // wrap the body and surface the failure over SSE instead.
      try {
        job.process = null;
        if (code !== 0) {
          const canceled = signal === 'SIGTERM' || signal === 'SIGKILL';
          // 'canceled' (single l) matches every other SSE emitter in the app —
          // useSseProgress treats it as terminal.
          job.status = canceled ? 'canceled' : 'error';
          const reason = canceled
            ? 'Render cancelled'
            : signal ? `Killed by signal ${signal}` : `ffmpeg exit ${code}`;
          job.lastError = reason;
          console.log(`${canceled ? '🛑' : '❌'} Timeline render ${canceled ? 'cancelled' : 'failed'} [${jobId.slice(0, 8)}]: ${reason}`);
          await unlink(outputPath).catch(() => {});
          broadcastSse(job, { type: canceled ? 'canceled' : 'error', error: reason });
          projectRenders.delete(projectId);
          closeJobAfterDelay(jobs, jobId);
          return;
        }
        job.status = 'complete';
        // The encode args already include -movflags +faststart, so no separate
        // remux pass is needed here.
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
        // Serialized append through the single shared history tail so a concurrent
        // download/render/timeline write can't clobber this entry.
        await mutateVideoHistory((history) => { history.unshift(meta); return history; });
        console.log(`✅ Timeline rendered [${jobId.slice(0, 8)}]: ${filename}`);
        broadcastSse(job, { type: 'complete', result: { id: jobId, filename, thumbnail: thumb, path: `/data/videos/${filename}` } });
        projectRenders.delete(projectId);
        closeJobAfterDelay(jobs, jobId);
      } catch (err) {
        const reason = `Post-render failed: ${err.message}`;
        job.status = 'error';
        job.lastError = reason;
        console.error(`❌ Timeline render post-processing error [${jobId.slice(0, 8)}]: ${reason}`);
        broadcastSse(job, { type: 'error', error: reason });
        projectRenders.delete(projectId);
        closeJobAfterDelay(jobs, jobId);
      }
    },
  });

  return { jobId };
}
