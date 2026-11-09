/** Non-destructive trim for video-history items: keep a frame range of a clip as a new gallery row. */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import {
  generateThumbnail, probeFrameCount, probeVideoStreamInfo, trimVideoFromFrame,
} from '../../lib/ffmpeg.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { omitDerivedRenderFields, renderTimingFields } from '../../lib/renderTiming.js';
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

// Copy history item `historyId` into a NEW gallery row holding frames
// [startSec, endSec) (each snapped to the nearest frame; either may be
// omitted for the clip's own start or end). The source clip is untouched, so a
// trim the user regrets costs nothing. Returns the new history entry.
export async function trimHistoryItem(historyId, { startSec, endSec } = {}) {
  const item = await resolveHistoryItem(historyId);
  const sourcePath = resolveSourcePath(item);
  const hasStart = startSec !== undefined && startSec !== null;
  const hasEnd = endSec !== undefined && endSec !== null;
  if (!hasStart && !hasEnd) {
    throw new ServerError('startSec or endSec is required', { status: 400, code: 'VALIDATION_ERROR' });
  }
  for (const [name, value] of [['startSec', startSec], ['endSec', endSec]]) {
    if (value != null && !(Number.isFinite(Number(value)) && Number(value) > 0)) {
      throw new ServerError(`${name} must be a positive number of seconds`, { status: 400, code: 'VALIDATION_ERROR' });
    }
  }
  const fps = await resolveFps(item, sourcePath);
  const totalFrames = await probeFrameCount(sourcePath);
  const startFrame = hasStart ? Math.round(Number(startSec) * fps) : 0;
  const endFrame = hasEnd ? Math.round(Number(endSec) * fps) : null;
  if (hasStart && startFrame < 1) {
    throw new ServerError('That is already the first frame', { status: 400, code: 'TRIM_AT_START' });
  }
  if (endFrame !== null && Number.isFinite(totalFrames) && endFrame >= totalFrames) {
    throw new ServerError('That is already the last frame', { status: 400, code: 'TRIM_AT_END' });
  }
  const lastFrame = endFrame ?? totalFrames;
  if (Number.isFinite(lastFrame) && lastFrame - startFrame < MIN_KEPT_FRAMES) {
    throw new ServerError(hasEnd ? 'Pick a later frame to end on' : 'Pick a frame before the end of the clip',
      { status: 400, code: hasEnd ? 'TRIM_TOO_SHORT' : 'TRIM_PAST_END' });
  }

  const newId = randomUUID();
  const newFilename = `${newId}.mp4`;
  const newPath = join(PATHS.videos, newFilename);
  const renderStartedAtMs = Date.now();
  console.log(`✂️ Trimming video [${historyId.slice(0, 8)} → ${newId.slice(0, 8)}] frames ${startFrame}–${endFrame ?? 'end'}`);
  const result = await trimVideoFromFrame(sourcePath, newPath, { startFrame, endFrame, fps });
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
        ...omitDerivedRenderFields(item),
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
        ...(endFrame !== null
          ? { trimEndFrame: endFrame, trimEndSec: Math.round((endFrame / fps) * 1000) / 1000 }
          : { trimEndFrame: undefined, trimEndSec: undefined }),
        hidden: false,
        ...renderTimingFields(renderStartedAtMs),
      };
      await mutateVideoHistory((history) => { history.unshift(newEntry); return history; });
      committed = true;
      console.log(`✅ Trimmed [${newId.slice(0, 8)}]: ${newFilename} from ${trimStartSec}s${endFrame !== null ? ` to ${newEntry.trimEndSec}s` : ''}`);
      return newEntry;
    } catch (error) {
      if (!committed) await discardUnpublishedVideo({ jobId: newId, outputPath: newPath });
      throw error;
    }
  });
}
