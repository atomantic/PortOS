/** Private, source-bound sharing exports run through the existing media queue. */
import { createHash } from 'crypto';
import { constants } from 'fs';
import { lstat, realpath, mkdtemp, rm, stat, link, unlink, open } from 'fs/promises';
import { join, sep } from 'path';
import { spawnDetached } from '../../lib/detachedSpawn.js';
import { PATHS, ensureDir } from '../../lib/fileUtils.js';
import { safeUnder, findFfmpeg, probeVideoDuration, probeVideoStreamInfo } from '../../lib/ffmpeg.js';
import { safeChildProcessEnv } from '../../lib/processEnv.js';
import { killWithEscalation } from '../../lib/killWithEscalation.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { ServerError } from '../../lib/errorHandler.js';
import { getProject, listProjects, mutateProjectRecord } from './projects.js';
import { getHistoryItem } from '../videoGen/history.js';
import { videoGenEvents } from '../videoGen/events.js';

export const SHARING_COPY_MAX_BYTES = 100_000_000;
const KIND = 'video-sharing';
const pending = new Map();
const running = new Map();
const fail = (message) => new ServerError(message, { status: 409, code: 'SHARING_COPY_UNAVAILABLE' });

const missingFile = error => {
  if (error.code === 'ENOENT' || error.code === 'ELOOP') throw fail('The video file is missing or unsafe — check the final render and prepare again');
  throw error;
};
const fileVersion = info => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');

async function ownedVideo(filename) {
  const path = safeUnder(PATHS.videos, filename);
  if (!path || !(await lstat(path).catch(missingFile)).isFile()) throw fail('The video file is missing or unsafe');
  const [root, actual] = await Promise.all([realpath(PATHS.videos), realpath(path).catch(missingFile)]);
  if (!actual.startsWith(root + sep)) throw fail('The video file is outside the media directory');
  return actual;
}

async function fileHash(path, retainedFile = null) {
  // Do not follow a leaf symlink installed after the ownership lookup.
  const file = retainedFile || await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)).catch(missingFile);
  try {
    const before = await file.stat();
    if (!before.isFile()) throw fail('Unsafe video file');
    const hash = createHash('sha256');
    for await (const chunk of file.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk);
    const after = await lstat(path).catch(missingFile);
    if (!after.isFile() || fileVersion(before) !== fileVersion(after)) throw fail('The video file changed during verification; prepare again');
    return { hash: hash.digest('hex'), version: fileVersion(after) };
  } finally { if (!retainedFile) await file.close(); }
}

async function assertSourceSelected(source) {
  const project = await getProject(source.project.id);
  const entry = project?.renderHistoryId === source.renderHistoryId ? await getHistoryItem(source.renderHistoryId) : null;
  const info = await lstat(source.path).catch(missingFile);
  if (!entry || entry.filename !== source.filename || !info.isFile() || fileVersion(info) !== source.fileVersion) throw fail('The final render changed during verification; prepare a new sharing copy');
  return project;
}

async function finalSource(projectId) {
  const project = await getProject(projectId);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  if (!project.renderHistoryId) throw fail('Render the final video before preparing a sharing copy');
  const entry = await getHistoryItem(project.renderHistoryId);
  if (!entry?.filename) throw fail('The final render is missing');
  const path = await ownedVideo(entry.filename);
  const digest = await fileHash(path);
  const source = { project, path, filename: entry.filename, sourceHash: digest.hash, fileVersion: digest.version, renderHistoryId: project.renderHistoryId };
  source.project = await assertSourceSelected(source);
  return source;
}

function sameSource(source, expected) {
  return source.renderHistoryId === expected.renderHistoryId && source.sourceHash === expected.sourceHash;
}

async function cachedCopy(source) {
  const copy = source.project.publishKit?.sharingCopy;
  if (!copy || copy.version !== 1 || !sameSource(source, copy)) return null;
  try {
    const path = await ownedVideo(copy.filename);
    const digest = await fileHash(path);
    const info = await stat(path).catch(missingFile);
    if (digest.version !== fileVersion(info) || info.size !== copy.bytes || !info.size || info.size >= SHARING_COPY_MAX_BYTES || digest.hash !== copy.hash) return null;
    return copy;
  } catch (error) {
    if (error.code === 'SHARING_COPY_UNAVAILABLE') return null;
    throw error;
  }
}

async function sharingState(source) {
  const projectId = source.project.id;
  const { listJobs } = await import('../mediaJobQueue/index.js');
  const job = listJobs({ kind: KIND }).find((job) => ['queued', 'running'].includes(job.status)
    && job.params?.sharingProjectId === projectId && sameSource(source, job.params));
  source.project = await assertSourceSelected(source);
  const copy = await cachedCopy(source);
  await assertSourceSelected(source);
  return { copy, jobId: job?.id || null, status: job?.status || null };
}

export async function getSharingCopy(projectId) {
  return sharingState(await finalSource(projectId));
}

/** Reserve before any async lookup; repeated clicks reuse the exact same request/job. */
export function prepareSharingCopy(projectId) {
  if (pending.has(projectId)) return pending.get(projectId);
  const request = (async () => {
    const source = await finalSource(projectId);
    const state = await sharingState(source);
    if (state.copy || state.jobId) return state;
    const { enqueueJob } = await import('../mediaJobQueue/index.js');
    return enqueueJob({ kind: KIND, owner: `music-video:${projectId}`, params: {
      sharingProjectId: projectId, renderHistoryId: source.renderHistoryId, sourceHash: source.sourceHash,
    } });
  })().finally(() => pending.delete(projectId));
  pending.set(projectId, request);
  return request;
}

export async function sharingCopyDownload(projectId) {
  const source = await finalSource(projectId);
  const copy = source.project.publishKit?.sharingCopy;
  if (!copy || copy.version !== 1 || !sameSource(source, copy)) throw fail('Prepare a sharing copy of the current final render first');
  const path = await ownedVideo(copy.filename);
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)).catch(missingFile);
  try {
    const digest = await fileHash(path, file);
    const info = await file.stat();
    if (digest.version !== fileVersion(info) || info.size !== copy.bytes || !info.size || info.size >= SHARING_COPY_MAX_BYTES || digest.hash !== copy.hash) throw fail('Prepare a sharing copy of the current final render first');
    await assertSourceSelected(source);
    // The caller owns this exact verified descriptor; never reopen the pathname.
    return { copy, file, modifiedAt: info.mtime };
  } catch (error) {
    await file.close();
    throw error;
  }
}

export function cancel(jobId) {
  const run = running.get(jobId);
  if (!run || run.committing) return false;
  run.aborted = true;
  const proc = run.proc;
  if (proc) killWithEscalation(proc, { label: 'sharing export', stillRunning: () => run.proc === proc });
  return true;
}

async function encode(bin, args, run) {
  if (run.aborted) throw fail('Sharing export cancelled');
  const proc = await spawnDetached(bin, args, {
    controlDir: join(PATHS.videos, '.detached', `sharing-${run.jobId}-${run.pass++}`),
    env: safeChildProcessEnv(), cleanup: true,
  });
  run.proc = proc;
  if (run.aborted) killWithEscalation(proc, { label: 'sharing export', stillRunning: () => run.proc === proc });
  return new Promise((resolve, reject) => {
    let tail = '';
    let processError;
    proc.stderr.on('data', chunk => {
      tail = (tail + chunk.toString()).slice(-2000);
      videoGenEvents.emit('activity', { generationId: run.jobId });
    });
    const timer = setTimeout(() => {
      run.aborted = true;
      killWithEscalation(proc, { label: 'sharing export timeout', stillRunning: () => run.proc === proc });
    }, 30 * 60_000);
    timer.unref?.();
    const cleanup = () => { clearTimeout(timer); run.proc = null; };
    proc.on('error', error => {
      processError = error;
      // An observer error with a live PID does not prove physical settlement.
      // Retain the lane and scratch until close; cancellation still escalates.
      if (proc.pid) killWithEscalation(proc, { label: 'sharing export observer failure', stillRunning: () => run.proc === proc });
      else { cleanup(); reject(error); }
    });
    proc.once('close', code => {
      cleanup();
      if (processError) reject(processError);
      else if (run.aborted) reject(fail('Sharing export cancelled or timed out'));
      else if (code !== 0) reject(new Error(`Sharing encode failed (${code}): ${tail}`));
      else resolve();
    });
  });
}

/** Queue worker: fixed two-pass H.264/AAC, at most 720p/60fps and strictly <100 MB. */
export async function runSharingCopy({ jobId, sharingProjectId, renderHistoryId, sourceHash }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) throw fail('Invalid sharing job identity');
  const run = { jobId, proc: null, aborted: false, committing: false, pass: 0 };
  running.set(jobId, run);
  let scratch;
  let output;
  let published = false;
  let result;
  let error;
  const reportStage = message => videoGenEvents.emit('status', { generationId: jobId, message });
  try {
    const source = await finalSource(sharingProjectId);
    if (!sameSource(source, { renderHistoryId, sourceHash })) throw fail('The final render changed; prepare a new sharing copy');
    const [duration, stream, bin] = await Promise.all([probeVideoDuration(source.path), probeVideoStreamInfo(source.path), findFfmpeg()]);
    if (!bin || !Number.isFinite(duration) || duration <= 0 || duration > 3600 || !stream.width || !stream.height || !Number.isFinite(stream.fps) || stream.fps <= 0) throw fail('Cannot export this final render (supported duration: up to one hour)');
    await ensureDir(PATHS.videos);
    await ensureDir(join(PATHS.videos, '.detached'));
    if (!(await lstat(join(PATHS.videos, '.detached'))).isDirectory()) throw fail('Unsafe render scratch directory');
    scratch = await mkdtemp(join(PATHS.videos, '.detached', 'sharing-work-'));
    const encoded = join(scratch, 'copy.mp4');
    const passlog = join(scratch, 'pass');
    // Budget 95 MB for streams; the remaining 5 MB protects against mux overhead.
    let bitrate = Math.min(8_000_000, Math.floor(95_000_000 * 8 / duration) - 128_000);
    if (bitrate < 100_000) throw fail('The video is too long for a usable sharing copy');
    for (let attempt = 0; attempt < 2; attempt++) {
      const video = ['-vf', "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2", '-r', String(Math.min(60, stream.fps)), '-c:v', 'libx264', '-preset', 'medium', '-threads', '2', '-b:v', String(bitrate), '-pix_fmt', 'yuv420p', '-passlogfile', passlog];
      const input = ['-hide_banner', '-nostdin', '-loglevel', 'info', '-filter_threads', '2', '-protocol_whitelist', 'file,pipe', '-f', 'mov', '-i', source.path, '-map', '0:v:0'];
      reportStage('Analyzing sharing encode (pass 1 of 2)');
      await encode(bin, [...input, ...video, '-pass', '1', '-an', '-f', 'null', '-y', process.platform === 'win32' ? 'NUL' : '/dev/null'], run);
      reportStage('Encoding sharing copy (pass 2 of 2)');
      await encode(bin, [...input, '-map', '0:a:0?', ...video, '-pass', '2', '-c:a', 'aac', '-b:a', '128k', '-map_metadata', '-1', '-fs', '104000000', '-movflags', '+faststart', '-y', encoded], run);
      const bytes = (await stat(encoded)).size;
      if (bytes < SHARING_COPY_MAX_BYTES) break;
      bitrate = Math.floor(bitrate * 90_000_000 / bytes);
    }
    reportStage('Verifying file size and current final render');
    const [info, measured, copyDuration, fresh] = await Promise.all([stat(encoded), probeVideoStreamInfo(encoded), probeVideoDuration(encoded), finalSource(sharingProjectId)]);
    if (run.aborted) throw fail('Sharing export cancelled');
    if (!sameSource(fresh, source)) throw fail('The final render changed during export; prepare a new sharing copy');
    if (!info.size || info.size >= SHARING_COPY_MAX_BYTES || !measured.width || !measured.height || measured.width > 1280 || measured.height > 720 || !Number.isFinite(measured.fps) || measured.fps <= 0 || measured.fps > 60 || !Number.isFinite(copyDuration) || Math.abs(copyDuration - duration) > Math.max(0.25, 2 / stream.fps)) throw fail('Sharing copy failed size, resolution or full-length verification');
    const filename = `music-video-sharing-${jobId}.mp4`;
    result = { version: 1, filename, bytes: info.size, width: measured.width, height: measured.height, fps: measured.fps,
      durationSec: copyDuration, renderHistoryId, sourceHash, hash: (await fileHash(encoded)).hash, createdAt: new Date().toISOString() };
    if (run.aborted) throw fail('Sharing export cancelled');
    // Once publication starts, cancellation is refused rather than reporting cancelled for a saved result.
    run.committing = true;
    await withBackupAssetPublication(async () => {
      await assertSourceSelected(source);
      const destination = join(PATHS.videos, filename);
      // An exclusive hard link publishes atomically without overwriting an existing file.
      await link(encoded, destination);
      output = destination;
      await mutateProjectRecord(sharingProjectId, current => {
        if (current.renderHistoryId !== renderHistoryId) throw fail('The final render changed during export');
        return { project: { ...current, publishKit: { ...current.publishKit, sharingCopy: result } } };
      });
      published = true;
    });
    const previous = source.project.publishKit?.sharingCopy?.filename;
    if (previous && previous !== filename) await releaseUnusedSharingCopy(previous).catch(err => cleanupFailed(jobId, err));
  } catch (err) {
    error = err.message || 'Sharing export failed';
  } finally {
    if (output && !published) await unlink(output).catch(err => {
      if (err.code !== 'ENOENT') { cleanupFailed(jobId, err); error ||= 'Sharing export cleanup needs recovery'; }
    });
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(err => {
      cleanupFailed(jobId, err); error ||= 'Sharing export cleanup needs recovery';
    });
    running.delete(jobId);
  }
  if (error) videoGenEvents.emit('failed', { generationId: jobId, error });
  else videoGenEvents.emit('completed', { generationId: jobId, ...result });
}

function cleanupFailed(jobId, error) {
  maintenance.markCurrentUnsettled();
  maintenance.markResourceUnsettled('media', jobId);
  console.error(`❌ Sharing copy cleanup needs recovery [${jobId.slice(0, 8)}]: ${error.message}`);
}

async function releaseUnusedSharingCopy(filename) {
  if (!/^music-video-sharing-[0-9a-f-]{36}\.mp4$/i.test(filename)) return;
  const projects = await listProjects();
  if (projects.some(project => project.publishKit?.sharingCopy?.filename === filename)) return;
  const path = await ownedVideo(filename).catch(error => {
    if (error.code === 'SHARING_COPY_UNAVAILABLE') return null;
    throw error;
  });
  if (path) await withBackupAssetPublication(() => unlink(path));
}

/** Boot reconciliation removes only this job's unpublished output, never a saved copy. */
export async function cleanupInterruptedSharingCopy(jobId) {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return;
  await releaseUnusedSharingCopy(`music-video-sharing-${jobId}.mp4`);
}
