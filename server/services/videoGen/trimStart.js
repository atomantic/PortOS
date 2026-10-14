/** Non-destructive start trim for video-history items: keep a clip from a later frame on. */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import {
  generateThumbnail, probeFrameCount, probeVideoStreamInfo, trimVideoFromFrame,
} from '../../lib/ffmpeg.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { omitRenderTiming, renderTimingFields } from '../../lib/renderTiming.js';
import { discardUnpublishedVideo } from './generateVideoHelpers.js';
import { mutateVideoHistory } from './history.js';
import { resolveHistoryItem, resolveSourcePath } from './upscaleVideo.js';

// A trimmed copy shorter than this is not a usable clip.
const MIN_KEPT_FRAMES = 2;

// The clip's frame rate: the render's own `fps` when it recorded one, else the
// stream's (uploads and older rows carry none).
const resolveFps = async (item, sourcePath) => {
  const recorded = Number(item.fps);
  if (Number.isFinite(recorded) && recorded > 0) return recorded;
  const probed = (await probeVideoStreamInfo(sourcePath))?.fps;
  if (Number.isFinite(probed) && probed > 0) return probed;
  throw new ServerError('Could not read the clip frame rate', { status: 422, code: 'FPS_UNKNOWN' });
};

// Copy history item `historyId` into a NEW gallery row that starts at
// `startSec` (snapped to the nearest frame). The source clip is untouched, so
// a trim the user regrets costs nothing. Returns the new history entry.
export async function trimHistoryItemStart(historyId, { startSec } = {}) {
  const item = await resolveHistoryItem(historyId);
  const sourcePath = resolveSourcePath(item);
  const start = Number(startSec);
  if (!Number.isFinite(start) || start <= 0) {
    throw new ServerError('startSec must be a positive number of seconds', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const fps = await resolveFps(item, sourcePath);
  const startFrame = Math.round(start * fps);
  const totalFrames = await probeFrameCount(sourcePath);
  if (startFrame < 1) {
    throw new ServerError('That is already the first frame', { status: 400, code: 'TRIM_AT_START' });
  }
  if (Number.isFinite(totalFrames) && totalFrames - startFrame < MIN_KEPT_FRAMES) {
    throw new ServerError('Pick a frame before the end of the clip', { status: 400, code: 'TRIM_PAST_END' });
  }

  const newId = randomUUID();
  const newFilename = `${newId}.mp4`;
  const newPath = join(PATHS.videos, newFilename);
  const renderStartedAtMs = Date.now();
  console.log(`✂️ Trimming video [${historyId.slice(0, 8)} → ${newId.slice(0, 8)}] from frame ${startFrame}`);
  const result = await trimVideoFromFrame(sourcePath, newPath, { startFrame, fps });
  if (!result.ok) {
    await discardUnpublishedVideo({ jobId: newId, outputPath: newPath });
    throw new ServerError(`Trim failed: ${result.reason}`, { status: 500, code: 'FFMPEG_FAILED' });
  }
  return withBackupAssetPublication(async () => {
    let committed = false;
    try {
      const thumbnail = await generateThumbnail(newPath, newId);
      const keptFrames = await probeFrameCount(newPath);
      const trimStartSec = Math.round((startFrame / fps) * 1000) / 1000;
      const newEntry = {
        ...omitRenderTiming(item),
        id: newId,
        filename: newFilename,
        thumbnail,
        createdAt: new Date().toISOString(),
        ...(Number.isFinite(keptFrames) ? { numFrames: keptFrames } : {}),
        fps,
        // A poster picked on the source points into the cut-away part.
        posterSec: undefined,
        trimmedFrom: item.id,
        trimStartFrame: startFrame,
        trimStartSec,
        hidden: false,
        ...renderTimingFields(renderStartedAtMs),
      };
      await mutateVideoHistory((history) => { history.unshift(newEntry); return history; });
      committed = true;
      console.log(`✅ Trimmed [${newId.slice(0, 8)}]: ${newFilename} starts at ${trimStartSec}s`);
      return newEntry;
    } catch (error) {
      if (!committed) await discardUnpublishedVideo({ jobId: newId, outputPath: newPath });
      throw error;
    }
  });
}
