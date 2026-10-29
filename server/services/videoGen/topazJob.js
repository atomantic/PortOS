/** Topaz upscale worker. Provider identities and intent are persisted before
 * credit reservation; recovery observes the existing request, never creates one. */
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { stat, unlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { createWriteStream } from 'node:fs';
import { PATHS, UUID_RE } from '../../lib/fileUtils.js';
import { safeUnder, probeVideoStreamInfo, probeFrameCount, probeVideoDuration, hasAudioStream, generateThumbnail } from '../../lib/ffmpeg.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { enqueueJob, getJob, listJobs, updateJobResult } from '../mediaJobQueue/index.js';
import { HISTORY_UNCHANGED, loadHistory, mutateVideoHistory } from './history.js';
import { finalizeUpscaleOutput } from './upscaleFfmpeg.js';
import { consumeTopazQuote, hashTopazFile, topazKey, topazKeyFingerprint, topazRequest, TOPAZ_MODELS } from './topazQuote.js';
import { registerStaging, hasTopazStaging, cleanupTopazStaging, releaseTopazStaging, topazPreparedPath, topazOutputPath, topazFinalPath } from './topazStaging.js';
import { videoGenEvents } from './events.js';
import { ServerError } from '../../lib/errorHandler.js';

const safeError = message => Object.assign(new Error(message), { safeTopaz: true });
const active = new Map();
const admitting = new Set();
const safeSignedUrl = value => {
  const url = URL.parse(value);
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port
    || !(url.hostname.endsWith('.amazonaws.com') || url.hostname.endsWith('.topazlabs.com'))) {
    throw safeError('Topaz returned an unsupported transfer URL.');
  }
  return url.href;
};
const transfer = async (url, options) => {
  const response = await fetch(safeSignedUrl(url), { ...options, redirect: 'error' }).catch(() => { throw safeError('Topaz video transfer failed.'); });
  if (!response.ok) throw safeError(`Topaz video transfer failed (HTTP ${response.status}).`);
  return response;
};
const receipt = async (jobId, phase) => {
  if (!await updateJobResult(jobId, { topazPhase: phase, topazUncertain: true })) throw safeError('Could not persist Topaz job state.');
};
const sourcePathFor = quote => safeUnder(PATHS.videos, quote.filename);
const statOptional = path => stat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const activityStream = jobId => new Transform({ transform(chunk, _encoding, done) {
  videoGenEvents.emit('activity', { generationId: jobId });
  done(null, chunk);
} });
export const cleanupPreparedTopaz = cleanupTopazStaging;
export function assertNoPendingTopaz(historyId) {
  const pending = listJobs({ kind: 'video-upscale' }).find(job => job.params?.mode === 'topaz' && job.params?.historyId === historyId
    && (['queued', 'running'].includes(job.status) || job.result?.topazUncertain === true));
  if (pending || admitting.has(historyId)) throw new ServerError('A Topaz request for this video is still running or has an uncertain outcome. Check the existing request before starting another.', { status: 409, code: 'TOPAZ_PENDING' });
}

export async function enqueueTopazUpscale(historyId, token) {
  assertNoPendingTopaz(historyId);
  admitting.add(historyId);
  try {
  // Consume once: two simultaneous clicks cannot reserve twice for one quote.
  const quote = consumeTopazQuote(token, historyId);
  const path = sourcePathFor(quote);
  const source = path && await stat(path).catch(() => null);
  if (!source || source.size !== quote.size || source.mtimeMs !== quote.mtimeMs) {
    await cleanupTopazStaging(quote.preparedId).catch(() => { throw new ServerError('Could not clean Topaz staging.', { status: 500, code: 'TOPAZ_CLEANUP_FAILED' }); });
    throw new ServerError('The source changed after the estimate. Request a new estimate.', { status: 409, code: 'TOPAZ_SOURCE_CHANGED' });
  }
  return await enqueueJob({ kind: 'video-upscale', params: { mode: 'topaz', ...quote, prompt: 'Topaz video upscale', width: 1920, height: 1080 } })
    .then(result => { releaseTopazStaging(quote.preparedId); return result; })
    .catch(async error => { await cleanupTopazStaging(quote.preparedId).catch(() => { throw new ServerError('Could not clean Topaz staging.', { status: 500, code: 'TOPAZ_CLEANUP_FAILED' }); }); throw error; });
  } finally { admitting.delete(historyId); }
}

export async function reconcileTopazStatus(jobId, { cancelRemote = false } = {}) {
  const job = getJob(jobId);
  if (!job || job.kind !== 'video-upscale' || job.params?.mode !== 'topaz' || !UUID_RE.test(job.params.requestId || '')) throw new ServerError('Topaz job not found.', { status: 404, code: 'NOT_FOUND' });
  if (cancelRemote && ['queued', 'running'].includes(job.status)) throw new ServerError('Cancel the active job through the render queue.', { status: 409, code: 'TOPAZ_JOB_ACTIVE' });
  if (cancelRemote && job.result?.topazUncertain !== true) throw new ServerError('This Topaz request is already settled.', { status: 409, code: 'TOPAZ_JOB_SETTLED' });
  const key = await topazKey();
  if (topazKeyFingerprint(key) !== job.params.keyFingerprint) throw new ServerError('The Topaz credential changed since this request.', { status: 409, code: 'TOPAZ_KEY_CHANGED' });
  if (cancelRemote) await topazRequest(`/video/${job.params.requestId}`, { method: 'DELETE', key });
  const status = await topazRequest(`/video/${job.params.requestId}/status`, { key });
  const allowed = ['requested', 'accepted', 'initializing', 'preprocessing', 'processing', 'postprocessing', 'complete', 'canceling', 'canceled', 'failed'];
  if (!allowed.includes(status.status)) throw new ServerError('Topaz returned an unknown request state.', { status: 502, code: 'TOPAZ_INVALID_RESPONSE' });
  if (['complete', 'canceled', 'failed'].includes(status.status)) await updateJobResult(jobId, { topazUncertain: false, topazProviderStatus: status.status, topazRecoveryAvailable: status.status === 'complete' && job.status !== 'completed' });
  return { requestId: job.params.requestId, status: status.status, progress: Number.isFinite(status.progress) ? status.progress : null };
}

export async function recoverTopazResult(jobId) {
  const job = getJob(jobId);
  if (!job || job.kind !== 'video-upscale' || job.params?.mode !== 'topaz' || job.result?.topazRecoveryAvailable !== true) throw new ServerError('No Topaz result is available for recovery.', { status: 409, code: 'TOPAZ_RECOVERY_UNAVAILABLE' });
  const { historyId } = job.params;
  assertNoPendingTopaz(historyId);
  admitting.add(historyId);
  const preparedId = randomUUID();
  try {
    const status = await reconcileTopazStatus(jobId);
    if (status.status !== 'complete') throw new ServerError('Topaz has not confirmed that this result is complete.', { status: 409, code: 'TOPAZ_RECOVERY_UNAVAILABLE' });
    await registerStaging(preparedId).catch(() => { throw new ServerError('Could not prepare Topaz staging.', { status: 500, code: 'TOPAZ_PREPARE_FAILED' }); });
    const result = await enqueueJob({ kind: 'video-upscale', params: { ...job.params, preparedId, resumeOnly: true, topazRecovery: false } })
      .catch(async error => { await cleanupTopazStaging(preparedId).catch(() => { throw new ServerError('Could not clean Topaz staging.', { status: 500, code: 'TOPAZ_CLEANUP_FAILED' }); }); throw error; });
    releaseTopazStaging(preparedId);
    await updateJobResult(jobId, { topazRecoveryAvailable: false });
    return result;
  } finally { admitting.delete(historyId); }
}

export function cancel(jobId) {
  const entry = active.get(jobId);
  if (!entry) return false;
  entry.cancelRequested = true;
  entry.abort.abort();
  return true;
}

async function uploadParts(urls, path, size, signal, jobId) {
  if (!Array.isArray(urls) || !urls.length || urls.length > 150) throw safeError('Topaz did not provide usable upload URLs.');
  const partSize = urls.length === 1 ? size : Math.max(500_000_000, Math.ceil(size / urls.length));
  const results = [];
  for (let i = 0; i < urls.length; i++) {
    const start = i * partSize;
    const end = Math.min(size, start + partSize) - 1;
    if (end < start) throw safeError('Topaz provided an invalid upload plan.');
    const stream = createReadStream(path, { start, end });
    const progress = activityStream(jobId);
    stream.on('error', error => progress.destroy(error));
    const response = await transfer(urls[i], { method: 'PUT', signal, duplex: 'half', headers: { 'content-type': 'video/mp4', 'content-length': String(end - start + 1) }, body: stream.pipe(progress) });
    const eTag = urls.length === 1 ? 'unused' : response.headers.get('etag');
    if (!eTag) throw safeError('Topaz upload did not return a part receipt.');
    results.push({ partNum: i + 1, eTag });
  }
  return results;
}

const wait = () => new Promise(resolve => setTimeout(resolve, 5000));
export async function runVideoUpscale(params) {
  const { jobId, historyId, filename, size, mtimeMs, preparedId, source, target, requestId, model } = params;
  const entry = { cancelRequested: params.topazCancelRequested === true, abort: new AbortController() };
  active.set(jobId, entry);
  let delivered = false;
  let confirmedCancel = false;
  let providerTerminal = false;
  let status;
  let outputPath;
  let ownsOutput = false;
  let thumbnailPath;
  const preparedPath = UUID_RE.test(preparedId || '') ? topazPreparedPath(preparedId) : null;
  const downloadPath = UUID_RE.test(preparedId || '') ? topazOutputPath(preparedId) : null;
  const finalPath = UUID_RE.test(preparedId || '') ? topazFinalPath(preparedId) : null;
  const fail = error => videoGenEvents.emit('failed', { generationId: jobId, error, remoteCancellationConfirmed: confirmedCancel });
  try {
    if (!preparedPath || !downloadPath || !UUID_RE.test(requestId || '') || !UUID_RE.test(jobId || '') || !Object.hasOwn(TOPAZ_MODELS, model)
      || target?.width !== 1920 || target?.height !== 1080 || !Number.isSafeInteger(source?.size) || source.size <= 0
      || !Number.isSafeInteger(source?.frameCount) || source.frameCount <= 0 || !Number.isFinite(source?.frameRate) || !(source.frameRate > 0) || !Number.isFinite(source?.duration) || !(source.duration > 0)
      || !/^[a-f0-9]{64}$/.test(params.sourceDigest || '') || !/^[a-f0-9]{64}$/.test(params.preparedDigest || '')) throw safeError('Invalid Topaz job record.');
    const history = await loadHistory();
    const existing = history.find(row => row.id === jobId && row.upscaledFrom === historyId && row.upscaleMethod === 'topaz');
    if (existing) { delivered = true; videoGenEvents.emit('completed', { generationId: jobId, ...existing }); return existing; }
    if (!await hasTopazStaging(preparedId)) throw safeError('Topaz staging ownership is missing; the provider request may still need reconciliation.');
    const key = await topazKey();
    if (topazKeyFingerprint(key) !== params.keyFingerprint) throw safeError('The Topaz credential changed since the estimate; check the provider request before retrying.');
    const path = sourcePathFor({ filename });
    const original = path && await stat(path).catch(() => null);
    const prepared = params.resumeOnly ? null : await stat(preparedPath).catch(() => null);
    if (!original || original.size !== size || original.mtimeMs !== mtimeMs || await hashTopazFile(path) !== params.sourceDigest || (!params.resumeOnly && (!prepared || prepared.size !== source.size || await hashTopazFile(preparedPath) !== params.preparedDigest))) throw safeError('The source changed or the prepared video is missing.');
    const item = history.find(row => row.id === historyId && row.filename === filename);
    if (!item) throw safeError('The source video is no longer available.');
    videoGenEvents.emit('started', { generationId: jobId, id: jobId, upscaleMethod: 'topaz', width: target.width, height: target.height });
    let phase = getJob(jobId)?.result?.topazPhase || (params.resumeOnly ? 'processing' : null);
    if (!phase && entry.cancelRequested) { confirmedCancel = true; throw safeError('Canceled before Topaz acceptance.'); }
    if (!phase) {
      await updateJobResult(jobId, { topazRequestId: requestId });
      await receipt(jobId, 'accepting');
      phase = 'accepting';
      status = await topazRequest(`/video/${requestId}/accept`, { method: 'PATCH', key });
      await receipt(jobId, 'accepted');
      phase = 'accepted';
    } else {
      status = await topazRequest(`/video/${requestId}/status`, { key });
      if (phase === 'accepting' && status.status === 'requested') throw safeError('Topaz acceptance is uncertain. Check the provider request before retrying; charges may apply.');
    }
    if (!entry.cancelRequested && ['accepting', 'accepted'].includes(phase) && (status.urls?.length || status.status === 'accepted')) {
      if (!status.urls?.length) status = await topazRequest(`/video/${requestId}/status`, { key });
      const results = await uploadParts(status.urls, preparedPath, source.size, entry.abort.signal, jobId);
      await receipt(jobId, 'completing');
      phase = 'completing';
      await topazRequest(`/video/${requestId}/complete-upload/`, { method: 'PATCH', key, body: { uploadResults: results } });
      await receipt(jobId, 'processing');
      phase = 'processing';
    }
    for (;;) {
      if (entry.cancelRequested) {
        await topazRequest(`/video/${requestId}`, { method: 'DELETE', key }).catch(() => null);
      }
      status = await topazRequest(`/video/${requestId}/status`, { key });
      if (status.status === 'canceled') { confirmedCancel = true; providerTerminal = true; throw safeError('Topaz confirmed cancellation.'); }
      if (entry.cancelRequested && status.status !== 'canceling') throw safeError('Local cancellation could not be confirmed by Topaz; remote processing or charges may continue.');
      if (status.status === 'failed') { providerTerminal = true; throw safeError('Topaz reported that processing failed.'); }
      if (status.status === 'complete') { providerTerminal = true; break; }
      if (['completing', 'processing'].includes(phase) && status.status === 'accepted') throw safeError('Topaz upload completion is uncertain; check the provider request before retrying.');
      if (!['accepted', 'initializing', 'preprocessing', 'processing', 'postprocessing', 'canceling'].includes(status.status)) throw safeError('Topaz returned an unknown request state.');
      videoGenEvents.emit('activity', { generationId: jobId });
      videoGenEvents.emit('progress', { generationId: jobId, progress: Number.isFinite(status.progress) ? Math.max(0, Math.min(1, status.progress / 100)) : 0, message: `Topaz: ${status.status}` });
      await wait();
    }
    const response = await transfer(status.download?.url, { signal: entry.abort.signal });
    await pipeline(Readable.fromWeb(response.body), activityStream(jobId), createWriteStream(downloadPath));
    const downloaded = await probeVideoStreamInfo(downloadPath);
    if (downloaded.width !== target.width || downloaded.height !== target.height) throw safeError('Topaz returned unexpected output dimensions.');
    const current = await stat(path).catch(() => null);
    if (!current || current.size !== size || current.mtimeMs !== mtimeMs || await hashTopazFile(path) !== params.sourceDigest) throw safeError('The source changed while Topaz was processing.');
    outputPath = join(PATHS.videos, `${jobId}.mp4`);
    const [priorFinal, priorOutput] = await Promise.all([statOptional(finalPath), statOptional(outputPath)]);
    // A crash after linking but before recording history leaves two links to
    // the same owned inode. Remove only that proven link before re-finishing.
    if (priorOutput && priorFinal && priorOutput.dev === priorFinal.dev && priorOutput.ino === priorFinal.ino) {
      if (priorFinal.nlink !== 2 || history.some(row => row.filename === `${jobId}.mp4`)) throw safeError('The existing output is referenced elsewhere.');
      await unlink(outputPath);
    } else if (priorFinal?.nlink > 1) throw safeError('The staged output is referenced elsewhere.');
    const finalized = await finalizeUpscaleOutput(downloadPath, finalPath, { width: target.width, height: target.height, frameCount: source.frameCount, audioSourcePath: path, signal: entry.abort.signal });
    if (!finalized.ok) throw safeError('Could not attach the original audio to the Topaz result.');
    const [measured, duration, originalAudio, outputAudio] = await Promise.all([probeVideoStreamInfo(finalPath), probeVideoDuration(finalPath), hasAudioStream(path), hasAudioStream(finalPath)]);
    const frames = measured.frameCount ?? await probeFrameCount(finalPath);
    if (measured.width !== target.width || measured.height !== target.height || frames !== source.frameCount || !(measured.fps > 0) || Math.abs(measured.fps - source.frameRate) > 0.01 || !(duration > 0) || Math.abs(duration - source.duration) > 1 / source.frameRate + 0.05 || originalAudio !== outputAudio) throw safeError('Topaz result did not preserve the requested dimensions, timeline or audio.');
    if (await hashTopazFile(path) !== params.sourceDigest) throw safeError('The source changed while the result was being finalized.');
    const result = await withBackupAssetPublication(async () => {
      await link(finalPath, outputPath);
      ownsOutput = true;
      const candidate = join(PATHS.videoThumbnails, `${jobId}.jpg`);
      let thumbnail = null;
      if (!await statOptional(candidate)) {
        thumbnailPath = candidate;
        thumbnail = await generateThumbnail(outputPath, jobId);
        if (!thumbnail) { await unlink(candidate).catch(error => { if (error.code !== 'ENOENT') throw error; }); thumbnailPath = null; }
      }
      const row = { ...item, id: jobId, filename: `${jobId}.mp4`, thumbnail, createdAt: new Date().toISOString(), width: measured.width, height: measured.height, fps: measured.fps, numFrames: frames, duration, upscaledFrom: historyId, upscaleMethod: 'topaz', upscaleRuntime: 'topaz', upscaleModel: TOPAZ_MODELS[model], hidden: false };
      await mutateVideoHistory(rows => { rows.unshift(row); return rows; });
      return row;
    });
    delivered = true;
    videoGenEvents.emit('completed', { generationId: jobId, ...result });
    return result;
  } catch (error) {
    if (entry.cancelRequested && !confirmedCancel && getJob(jobId)?.result?.topazPhase) {
      const key = await topazKey().catch(() => null);
      if (key && topazKeyFingerprint(key) === params.keyFingerprint) {
        await topazRequest(`/video/${requestId}`, { method: 'DELETE', key }).catch(() => null);
        const state = await topazRequest(`/video/${requestId}/status`, { key }).catch(() => null);
        confirmedCancel = state?.status === 'canceled';
        providerTerminal = ['canceled', 'failed', 'complete'].includes(state?.status);
      }
    }
    if (getJob(jobId)?.result?.topazPhase) await updateJobResult(jobId, { topazUncertain: !providerTerminal, topazRequestId: requestId }).catch(() => {});
    if (providerTerminal && !confirmedCancel && status?.status === 'complete') await updateJobResult(jobId, { topazRecoveryAvailable: true, topazProviderStatus: 'complete', topazRequestId: requestId }).catch(() => {});
    fail(entry.cancelRequested && !confirmedCancel ? `Local cancellation was requested; Topaz request ${requestId} is unconfirmed and charges or processing may continue.` : (error.safeTopaz || error instanceof ServerError ? error.message : 'Topaz upscale could not be completed.'));
  } finally {
    active.delete(jobId);
    const cleanupFailed = () => {
      maintenance.markCurrentUnsettled();
      maintenance.markResourceUnsettled('media', jobId);
      console.error('❌ Topaz upscale cleanup failed; owned files were retained for recovery.');
    };
    let cleanupProven = true;
    if (!delivered && !ownsOutput && finalPath && UUID_RE.test(jobId || '')) {
      await mutateVideoHistory(async rows => {
        const destination = join(PATHS.videos, `${jobId}.mp4`);
        const [finalFile, outputFile] = await Promise.all([statOptional(finalPath), statOptional(destination)]);
        if (finalFile && outputFile && finalFile.dev === outputFile.dev && finalFile.ino === outputFile.ino
          && !rows.some(row => row.filename === `${jobId}.mp4`)) {
          if (finalFile.nlink !== 2) { cleanupProven = false; return HISTORY_UNCHANGED; }
          await unlink(destination);
        }
        return HISTORY_UNCHANGED;
      }).catch(() => { cleanupProven = false; });
    }
    if (!delivered && ownsOutput && outputPath) await unlink(outputPath).catch(error => { if (error.code !== 'ENOENT') cleanupProven = false; });
    if (cleanupProven) await cleanupTopazStaging(preparedId).catch(cleanupFailed);
    else cleanupFailed();
    if (!delivered && thumbnailPath) await unlink(thumbnailPath).catch(error => { if (error.code !== 'ENOENT') cleanupFailed(); });
  }
  return null;
}
