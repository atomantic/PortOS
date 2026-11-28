/** Shared attribution, source validation and publication for queued video upscales. */

import { existsSync } from 'fs';
import { join } from 'path';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { FINISHED_OUTPUT_ADMISSION_MS } from '../../lib/backupPublicationWait.js';
import { ServerError } from '../../lib/errorHandler.js';
import { safeUnder, generateThumbnail, probeVideoStreamInfo, probeVideoDuration } from '../../lib/ffmpeg.js';
import { PATHS, unlinkGuarded } from '../../lib/fileUtils.js';
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { omitDerivedRenderFields, renderTimingFields } from '../../lib/renderTiming.js';
import { videoGenEvents } from './events.js';
import { getHistoryItem, mutateVideoHistory } from './history.js';

export function resolveUpscaleMusicVideo(item, { musicVideo, musicVideoProjectId, sceneId } = {}) {
  const projectId = musicVideoProjectId ?? item?.musicVideo?.projectId;
  const resolvedSceneId = sceneId ?? (projectId === item?.musicVideo?.projectId ? item?.musicVideo?.sceneId : null);
  const attribution = musicVideo ?? (projectId
    ? { projectId, ...(resolvedSceneId ? { sceneId: resolvedSceneId } : {}), tier: 'final' }
    : null);
  return attribution ? { musicVideo: attribution, musicVideoProjectId: attribution.projectId } : {};
}

export async function resolveQueuedUpscaleSource(historyId, sourceFilename) {
  const item = await getHistoryItem(historyId);
  if (!item) throw new ServerError('Video not found', { status: 404, code: 'NOT_FOUND' });
  if (item.upscaledFrom) throw new ServerError('Cannot upscale an already-upscaled video', { status: 400, code: 'ALREADY_UPSCALED' });
  // Older queued jobs may lack a pinned filename. Always validate the current
  // history filename before it reaches a renderer or cloud upload.
  if (sourceFilename !== undefined && item.filename !== sourceFilename) {
    throw new ServerError('The source clip was replaced while this upscale was queued.', { status: 409, code: 'UPSCALE_SOURCE_CHANGED' });
  }
  const sourcePath = safeUnder(PATHS.videos, item.filename);
  if (!sourcePath || !existsSync(sourcePath)) throw new ServerError('Video file not found on disk', { status: 404, code: 'NOT_FOUND' });
  return { item, sourcePath };
}

export async function removeOwnedUpscaleFile(jobId, path) {
  if (!path) return;
  try {
    await unlinkGuarded(path);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    maintenance.markCurrentUnsettled();
    maintenance.markResourceUnsettled('media', jobId);
    console.error(`❌ Video upscale cleanup failed [${jobId.slice(0, 8)}]: ${error.code ?? 'UNLINK_FAILED'}`);
  }
}

export function buildUpscaleHistoryEntry(item, { duration, musicVideo, renderStartedAtMs, ...fields }) {
  // Tier and auto-selection belong to the queue, while history stores the clip's attribution.
  const attribution = musicVideo?.projectId
    ? { projectId: musicVideo.projectId, ...(musicVideo.sceneId ? { sceneId: musicVideo.sceneId } : {}) }
    : item.musicVideo;
  return {
    ...omitDerivedRenderFields(item),
    ...fields,
    createdAt: new Date().toISOString(),
    upscaledFrom: item.id,
    duration,
    durationSec: duration,
    ...(attribution ? { musicVideo: attribution } : {}),
    hidden: false,
    ...renderTimingFields(renderStartedAtMs),
  };
}

/** Owns the finished deliverable on entry and rolls it back if publication fails. */
export async function publishUpscaledVideo({
  jobId, newId, newFilename, deliverablePath, item, musicVideo, renderStartedAtMs,
  isCanceled, buildFields, formatSuccessLog,
}) {
  const assertActive = () => {
    if (isCanceled()) throw new ServerError('Upscale canceled', { status: 499, code: 'UPSCALE_CANCELED' });
  };
  let admitted = false;
  let result;
  try {
    result = await withBackupAssetPublication(async () => {
      admitted = true;
      try {
        assertActive();
        const [measured, duration] = await Promise.all([
          probeVideoStreamInfo(deliverablePath),
          probeVideoDuration(deliverablePath),
        ]);
        const thumbnail = await generateThumbnail(deliverablePath, newId);
        assertActive();
        const row = buildUpscaleHistoryEntry(item, {
          id: newId, filename: newFilename, thumbnail, duration, musicVideo, renderStartedAtMs,
          ...buildFields(measured),
        });
        await mutateVideoHistory(rows => { rows.unshift(row); return rows; });
        return row;
      } catch (error) {
        // Roll back both outputs before releasing backup admission.
        await removeOwnedUpscaleFile(jobId, deliverablePath);
        await removeOwnedUpscaleFile(jobId, join(PATHS.videoThumbnails, `${newId}.jpg`));
        throw error;
      }
    }, {
      timeoutMs: FINISHED_OUTPUT_ADMISSION_MS,
      onWait: () => {
        console.log(`⏸️ Video upscale [${jobId.slice(0, 8)}] waiting for the backup to finish before saving`);
        videoGenEvents.emit('activity', { generationId: jobId });
      },
    });
  } catch (error) {
    if (!admitted) await removeOwnedUpscaleFile(jobId, deliverablePath);
    throw error;
  }
  console.log(formatSuccessLog(result));
  return result;
}
