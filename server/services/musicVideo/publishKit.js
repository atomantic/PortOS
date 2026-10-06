/**
 * Music Video — publishing kit (#9281).
 *
 * Everything a release needs that the project already knows: platform encodes
 * of the final render (an X-sized 1080p, a 720p preview, a hook teaser),
 * thumbnail candidates, an SRT of the timed lyrics, YouTube chapters, and
 * per-platform copy the director edits. `project.publishKit` is an additive
 * field on the whole-record LWW body (same posture as `excerpts`), so an older
 * peer carries it through untouched.
 *
 * The build runs ffmpeg only; the copy is ONE user-triggered LLM call (AI
 * Provider Usage Policy) and every field stays editable afterwards.
 */
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { ServerError } from '../../lib/errorHandler.js';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { safeUnder, edgeFadeFilter } from '../../lib/ffmpeg.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay } from '../../lib/sseUtils.js';
import { getProject, listProjects, mutateProjectRecord } from './projects.js';
import { suggestSocialCuts } from './socialCuts.js';
import { musicVideoAspect } from '../../lib/musicVideoAspect.js';
import { buildChapters, buildSrt, buildPublishCopyPrompt, parsePublishCopy, normalizeCopyOptions, PUBLISH_PLATFORMS } from './publishKitText.js';

const jobs = new Map();
const projectBuilds = new Map();
const MAX_THUMBNAILS = 6;
// X caps a Premium upload's bitrate well under a 1080p master's; ~12 Mbps
// keeps the analog grain without the upload being re-crushed.
const X_VIDEO_ARGS = ['-c:v', 'libx264', '-profile:v', 'high', '-preset', 'medium', '-b:v', '10M', '-maxrate', '12M', '-bufsize', '24M', '-pix_fmt', 'yuv420p'];
const AUDIO_ARGS = ['-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'];

export const attachPublishKitSseClient = (jobId, res) => attachSse(jobs, jobId, res);
export const projectPublishKit = (project) => (project?.publishKit && typeof project.publishKit === 'object' ? project.publishKit : {});

const kitError = (status, code, message, context) => new ServerError(message, { status, code, ...(context ? { context } : {}) });

/**
 * The build running for a project (`{ jobId, status }`), so a reloaded page can
 * reattach. Only once its SSE job exists: during the prerequisite lookup the
 * reservation holds the slot but there is nothing to attach to yet.
 */
export const getActivePublishKitBuild = (projectId) => {
  const jobId = projectBuilds.get(projectId);
  return jobId && jobs.get(jobId)?.status === 'running' ? { jobId, status: 'running' } : null;
};

async function requireProject(projectId) {
  const project = await getProject(projectId);
  if (!project) throw kitError(404, 'NOT_FOUND', 'Project not found');
  return project;
}

/** The final render's file (the YouTube master), or a 409 naming what's missing. */
async function finalRenderFile(project) {
  if (!project.renderHistoryId) throw kitError(409, 'NO_FINAL_RENDER', 'Render the final video before building the publishing kit');
  const { getHistoryItem } = await import('../videoGen/history.js');
  const entry = await getHistoryItem(project.renderHistoryId);
  const path = entry?.filename ? safeUnder(PATHS.videos, entry.filename) : null;
  if (!path || !existsSync(path)) throw kitError(409, 'NO_FINAL_RENDER', 'The final render file is missing — render the final video again');
  return { entry, path };
}

/** Frame times worth a thumbnail: performance-shot midpoints spread across the song, else even steps. */
function thumbnailTimes(project, durationSec, max = MAX_THUMBNAILS) {
  const perf = (project.scenes || [])
    .filter((s) => s?.shotMode === 'performance' && Number.isFinite(s.startSec) && Number.isFinite(s.endSec) && s.endSec > s.startSec && s.startSec < durationSec)
    .map((s) => (s.startSec + Math.min(s.endSec, durationSec)) / 2);
  const pool = perf.length ? perf : Array.from({ length: max }, (_, i) => ((i + 0.5) / max) * durationSec);
  if (pool.length <= max) return pool.map((t) => Math.round(t * 1000) / 1000);
  return Array.from({ length: max }, (_, i) => pool[Math.floor((i * pool.length) / max)]).map((t) => Math.round(t * 1000) / 1000);
}

/** A file an older build left behind, deleted only once no project's kit still names it (a clone shares the record). */
export async function releaseKitFiles(filenames, keep = []) {
  if (!filenames.length) return;
  const others = await listProjects().catch(() => []);
  const referenced = new Set(keep);
  for (const p of others) {
    const kit = projectPublishKit(p);
    for (const f of [...(kit.exports || []).map((e) => e.filename), ...(kit.thumbnails || []), kit.captionsFilename, kit.coverArt?.filename]) if (f) referenced.add(f);
  }
  for (const name of filenames) {
    if (referenced.has(name)) continue;
    const root = name.endsWith('.jpg') ? PATHS.videoThumbnails : PATHS.videos;
    const path = safeUnder(root, name);
    if (path) await unlink(path).catch(() => {});
  }
}

/**
 * Start a kit build: encodes, thumbnails, captions and chapters from the
 * current final render. Returns `{ jobId }`; progress streams over SSE and the
 * record carries the result.
 */
export async function startPublishKitBuild(projectId) {
  if (projectBuilds.has(projectId)) throw kitError(409, 'PUBLISH_KIT_BUILD_IN_PROGRESS', 'A publishing kit build is already running for this project', getActivePublishKitBuild(projectId) || undefined);
  const jobId = `mvpk-${randomUUID()}`;
  // Reserve synchronously: final-render lookup and ffmpeg probing can overlap
  // another request before there is a background job to put in the registry.
  projectBuilds.set(projectId, jobId);
  try {
    return await beginPublishKitBuild(projectId, jobId);
  } catch (error) {
    projectBuilds.delete(projectId);
    throw error;
  }
}

async function beginPublishKitBuild(projectId, jobId) {
  const project = await requireProject(projectId);
  const { entry, path: masterPath } = await finalRenderFile(project);
  const { findFfmpeg, runFfmpegProcess, probeVideoDuration } = await import('../../lib/ffmpeg.js');
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw kitError(500, 'FFMPEG_MISSING', 'ffmpeg not found on PATH');
  const job = { id: jobId, projectId, status: 'running', clients: [], abort: new AbortController() };
  jobs.set(jobId, job);
  const tag = jobId.slice(5, 13);
  console.log(`📦 Building music-video publishing kit [${tag}]: project=${projectId.slice(0, 8)}`);

  const run = async () => {
    await ensureDir(PATHS.videos);
    await ensureDir(PATHS.videoThumbnails);
    const durationSec = Number(entry.durationSec) > 0 ? Number(entry.durationSec) : await probeVideoDuration(masterPath);
    const stem = `music-video-${projectId.slice(3, 11)}-${Date.now()}`;
    const [teaser] = suggestSocialCuts(project, { count: 1, minSec: 25, maxSec: 45 });
    const encodes = [
      { kind: 'x-1080p', label: 'X / social 1080p (12 Mbps)', filename: `${stem}-x-1080p.mp4`,
        args: ['-i', masterPath, '-vf', "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease", ...X_VIDEO_ARGS, ...AUDIO_ARGS] },
      { kind: 'preview-720p', label: '720p preview', filename: `${stem}-preview-720p.mp4`,
        args: ['-i', masterPath, '-vf', "scale=-2:'min(720,ih)'", '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-pix_fmt', 'yuv420p', ...AUDIO_ARGS] },
      ...(teaser ? [{ kind: 'teaser', label: `Teaser ${Math.round(teaser.endSec - teaser.startSec)}s`, filename: `${stem}-teaser.mp4`, window: teaser,
        args: ['-ss', String(teaser.startSec), '-t', String(teaser.endSec - teaser.startSec), '-i', masterPath, ...X_VIDEO_ARGS,
          '-af', `asetpts=PTS-STARTPTS${edgeFadeFilter(teaser.endSec - teaser.startSec)}`, ...AUDIO_ARGS] }] : []),
      // #10150: Shorts/TikTok/Reels need 9:16; a 16:9 render gets a center-crop of the hook window (no generation).
      ...(teaser && musicVideoAspect(project) === '16:9' ? [{ kind: 'vertical-9x16', label: `Vertical 9:16 ${Math.round(teaser.endSec - teaser.startSec)}s`, filename: `${stem}-vertical.mp4`, window: teaser,
        args: ['-ss', String(teaser.startSec), '-t', String(teaser.endSec - teaser.startSec), '-i', masterPath,
          '-vf', 'crop=trunc(ih*9/32)*2:ih,scale=1080:1920', ...X_VIDEO_ARGS,
          '-af', `asetpts=PTS-STARTPTS${edgeFadeFilter(teaser.endSec - teaser.startSec)}`, ...AUDIO_ARGS] }] : []),
    ];
    const times = thumbnailTimes(project, durationSec);
    const total = encodes.length + times.length;
    const written = [];
    let done = 0;
    const step = () => broadcastSse(job, { type: 'progress', progress: Math.min(0.99, ++done / total) });
    for (const encode of encodes) {
      const out = join(PATHS.videos, encode.filename);
      const result = await runFfmpegProcess({ bin: ffmpeg, signal: job.abort.signal, args: ['-hide_banner', '-loglevel', 'error', ...encode.args, '-y', out] });
      if (!result.ok) throw new Error(`${encode.label} encode failed: ${result.reason || 'ffmpeg error'}`);
      written.push(encode.filename);
      step();
    }
    const thumbnails = [];
    for (const [i, t] of times.entries()) {
      const name = `${stem}-thumb-${i + 1}.jpg`;
      const result = await runFfmpegProcess({ bin: ffmpeg, signal: job.abort.signal, args: ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', masterPath, '-frames:v', '1', '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2', '-q:v', '2', '-y', join(PATHS.videoThumbnails, name)] });
      if (result.ok) { thumbnails.push(name); written.push(name); }
      step();
    }
    const srt = buildSrt(project);
    const captionsFilename = srt ? `${stem}-captions.srt` : null;
    if (srt) { await writeFile(join(PATHS.videos, captionsFilename), srt); written.push(captionsFilename); }
    const previous = projectPublishKit(project);
    const staleFiles = [...(previous.exports || []).map((e) => e.filename), ...(previous.thumbnails || []), previous.captionsFilename].filter(Boolean);
    // ffmpeg wrote the kit's files in place; the row that first names them
    // commits under a backup lease (#9982). Stale files go only after it.
    await withBackupAssetPublication(() => mutateProjectRecord(projectId, (current) => {
      const kit = projectPublishKit(current);
      return { project: { ...current, publishKit: {
        ...kit,
        builtAt: new Date().toISOString(),
        master: { filename: entry.filename, renderHistoryId: project.renderHistoryId },
        exports: encodes.map(({ kind, label, filename, window }) => ({ kind, label, filename, ...(window ? { startSec: window.startSec, endSec: window.endSec } : {}) })),
        thumbnails,
        thumbnail: thumbnails.includes(kit.thumbnail) ? kit.thumbnail : (thumbnails[0] || null),
        captionsFilename,
        chapters: buildChapters(current),
      } } };
    }));
    await releaseKitFiles(staleFiles, written);
    return written;
  };

  Promise.resolve().then(run).then(() => {
    job.status = 'complete';
    projectBuilds.delete(projectId);
    console.log(`✅ Music-video publishing kit built [${tag}]`);
    broadcastSse(job, { type: 'complete', result: { projectId } });
    closeJobAfterDelay(jobs, jobId);
  }).catch((err) => {
    const canceled = job.abort.signal.aborted;
    job.status = canceled ? 'canceled' : 'error';
    projectBuilds.delete(projectId);
    const log = canceled ? console.log : console.error;
    log(`${canceled ? '🛑' : '❌'} Music-video publishing kit ${canceled ? 'cancelled' : 'failed'} [${tag}]: ${err.message}`);
    broadcastSse(job, { type: canceled ? 'canceled' : 'error', error: canceled ? 'Publishing kit build cancelled' : err.message });
    closeJobAfterDelay(jobs, jobId);
  });
  return { jobId };
}

export function cancelPublishKitBuild(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.status !== 'running') return false;
  job.abort.abort();
  return true;
}

/** Choose the thumbnail the release uses (one the build cut). */
export async function selectPublishKitThumbnail(projectId, filename) {
  await requireProject(projectId);
  return mutateProjectRecord(projectId, (current) => {
    const kit = projectPublishKit(current);
    if (!(kit.thumbnails || []).includes(filename)) throw kitError(422, 'VALIDATION_ERROR', 'That thumbnail is not one this kit built');
    return { project: { ...current, publishKit: { ...kit, thumbnail: filename } } };
  });
}

/** Merge edited copy fields per platform (only known platforms and string/array fields). */
export async function updatePublishKitCopy(projectId, patch) {
  await requireProject(projectId);
  return mutateProjectRecord(projectId, (current) => {
    const kit = projectPublishKit(current);
    const copy = { ...(kit.copy || {}) };
    for (const platform of PUBLISH_PLATFORMS) {
      if (patch?.[platform] && typeof patch[platform] === 'object') copy[platform] = { ...(copy[platform] || {}), ...patch[platform] };
    }
    const next = { ...kit, copy, copyEditedAt: new Date().toISOString() };
    if (typeof patch?.notes === 'string') next.notes = patch.notes;
    return { project: { ...current, publishKit: next } };
  });
}

/** True when a post was written or edited by hand after the last draft (or with no draft yet). */
export function copyEditedSinceDraft(kit) {
  const edited = Date.parse(kit?.copyEditedAt || '');
  if (!Number.isFinite(edited)) return false;
  const drafted = Date.parse(kit?.copyDraftedAt || '');
  return !Number.isFinite(drafted) || edited > drafted;
}

/** Generation spend across the project's production runs (what the copy may claim). */
function spentUsd(project) {
  const total = (project.productionRuns || []).reduce((sum, run) => sum + (Number.isFinite(Number(run?.usage?.spentUsd)) ? Number(run.usage.spentUsd) : 0), 0);
  return total > 0 ? total : null;
}

/**
 * Draft the copy for every platform the director posts to, in ONE provider call they asked for.
 * `notes` (their making-of story) and what they chose to include (`include`,
 * `length`) are saved with the kit so a redraft reuses them. A draft replaces
 * the posts' text, so once a post was written or edited by hand since the last
 * draft it is refused (409 PUBLISH_COPY_EDITED) unless `replaceEdited` says the
 * director agreed to replace it. Fields the draft does not return (YouTube tags
 * with hashtags off) keep what was there.
 */
export async function draftPublishKitCopy(projectId, { providerId = null, model = null, notes = '', links = {}, include, length, replaceEdited = false } = {}, deps = {}) {
  const project = await requireProject(projectId);
  if (!replaceEdited && copyEditedSinceDraft(projectPublishKit(project))) {
    throw kitError(409, 'PUBLISH_COPY_EDITED', 'The posts were edited by hand since the last draft; confirm replacing them to draft again');
  }
  const { getPublishPlatforms, publishHistory } = await import('./publish/platforms.js');
  const enabled = deps.platforms || await getPublishPlatforms();
  // Only where the director posts (#9287); Suno's caption reuses the YouTube description.
  const platforms = PUBLISH_PLATFORMS.filter((p) => enabled[p]?.enabled || (p === 'youtube' && enabled.suno?.enabled));
  if (!platforms.length) throw kitError(409, 'PUBLISH_NO_PLATFORMS', 'Turn on at least one platform under "Where you post" before drafting copy');
  const history = deps.history || await publishHistory().catch(() => ({}));
  const lessons = Object.entries(history).flatMap(([platform, h]) => (h?.notes || []).map((n) => ({ platform, ...n })));
  const { resolveProviderAndModel, runPromptThroughProvider } = deps.runner || await import('../promptRunner.js');
  const { provider, selectedModel } = await resolveProviderAndModel({ providerId, model });
  if (!provider) throw kitError(503, 'NO_PROVIDER', 'No AI provider is available to draft the copy');
  const options = normalizeCopyOptions({ include, length });
  const prompt = buildPublishCopyPrompt(project, { notes, spentUsd: spentUsd(project), links, platforms, lessons, ...options });
  const { text } = await runPromptThroughProvider({ provider, model: selectedModel, prompt, source: 'music-video-publish-copy' });
  const copy = parsePublishCopy(text, platforms, { hashtags: options.include.hashtags });
  if (!copy) throw kitError(502, 'PUBLISH_COPY_UNPARSEABLE', 'The copy draft came back without usable JSON — try again or another model');
  return mutateProjectRecord(projectId, (current) => {
    const kit = projectPublishKit(current);
    const merged = { ...(kit.copy || {}) };
    for (const [platform, fields] of Object.entries(copy)) merged[platform] = { ...(merged[platform] || {}), ...fields };
    return { project: { ...current, publishKit: { ...kit, copy: merged, notes, draftOptions: options, links: { ...(kit.links || {}), ...links }, copyDraftedAt: new Date().toISOString() } } };
  });
}
