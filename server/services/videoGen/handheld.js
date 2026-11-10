/** Handheld camera for video-history items: a clip re-shot as if held by a walking operator, as a new gallery row. */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { filterVideoFrames, generateThumbnail, probeFrameCount, probeVideoStreamInfo } from '../../lib/ffmpeg.js';
import { handheldFfmpegFilter, isHandheldStill, normalizeHandheld } from '../../lib/handheldCamera.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { omitDerivedRenderFields, renderTimingFields } from '../../lib/renderTiming.js';
import { discardUnpublishedVideo } from './generateVideoHelpers.js';
import { mutateVideoHistory } from './history.js';
import { resolveHistoryItem, resolveSourcePath } from './upscaleVideo.js';

// A handheld take of a handheld take shakes the original again rather than
// stacking a second zoom and shake on the first, so trying another setting
// never degrades the picture. A deleted original falls back to the take itself.
async function steadySource(item) {
  if (!item.handheldFrom) return item;
  try {
    const original = await resolveHistoryItem(item.handheldFrom);
    resolveSourcePath(original);
    return original;
  } catch {
    return item;
  }
}

/**
 * Copy history item `historyId` into a NEW gallery row with the handheld
 * motion `settings` (lib/handheldCamera.js) baked in. The source clip is
 * untouched. Returns the new history entry.
 */
export async function handheldHistoryItem(historyId, settings) {
  const handheld = normalizeHandheld(settings);
  if (isHandheldStill(handheld)) {
    throw new ServerError('Turn up the shake or the footsteps first', { status: 400, code: 'HANDHELD_STILL' });
  }
  const requested = await resolveHistoryItem(historyId);
  const item = await steadySource(requested);
  const sourcePath = resolveSourcePath(item);
  const { width, height } = await probeVideoStreamInfo(sourcePath);
  const filter = handheldFfmpegFilter(handheld, { width, height });
  if (!filter) throw new ServerError('Could not read the clip size', { status: 422, code: 'SIZE_UNKNOWN' });

  const newId = randomUUID();
  const newFilename = `${newId}.mp4`;
  const newPath = join(PATHS.videos, newFilename);
  const renderStartedAtMs = Date.now();
  console.log(`🎥 Handheld [${item.id.slice(0, 8)} → ${newId.slice(0, 8)}] shake ${handheld.shake} steps ${handheld.steps} seed ${handheld.seed}`);
  const result = await filterVideoFrames(sourcePath, newPath, { filter, label: 'handheld' });
  if (!result.ok) {
    await discardUnpublishedVideo({ jobId: newId, outputPath: newPath });
    throw new ServerError(`Handheld failed: ${result.reason}`, { status: 500, code: 'FFMPEG_FAILED' });
  }
  return withBackupAssetPublication(async () => {
    let committed = false;
    try {
      const thumbnail = await generateThumbnail(newPath, newId);
      const frames = await probeFrameCount(newPath);
      const newEntry = {
        ...omitDerivedRenderFields(item),
        id: newId,
        filename: newFilename,
        thumbnail,
        createdAt: new Date().toISOString(),
        ...(Number.isFinite(frames) ? { numFrames: frames } : {}),
        handheldFrom: item.id,
        handheld,
        hidden: false,
        ...renderTimingFields(renderStartedAtMs),
      };
      await mutateVideoHistory((history) => { history.unshift(newEntry); return history; });
      committed = true;
      console.log(`✅ Handheld [${newId.slice(0, 8)}]: ${newFilename}`);
      return newEntry;
    } catch (error) {
      if (!committed) await discardUnpublishedVideo({ jobId: newId, outputPath: newPath });
      throw error;
    }
  });
}
