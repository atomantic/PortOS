/** "Make it vertical": a library clip re-framed onto a tall blurred-fill canvas, as a new gallery row. */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { filterVideoFrames, generateThumbnail, probeFrameCount, probeVideoStreamInfo } from '../../lib/ffmpeg.js';
import { isAlreadyTallEnough, verticalFilterGraph, verticalTargetSize } from '../../lib/verticalReframe.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { omitDerivedRenderFields, renderTimingFields } from '../../lib/renderTiming.js';
import { discardUnpublishedVideo } from './generateVideoHelpers.js';
import { mutateVideoHistory } from './history.js';
import { resolveHistoryItem, resolveSourcePath } from './upscaleVideo.js';

/**
 * Re-frame history item `historyId` to `ratioId` (lib/verticalReframe.js) into a
 * NEW gallery row; the source is untouched. Returns the new history entry.
 */
export async function verticalReframeHistoryItem(historyId, ratioId, { id = randomUUID(), signal } = {}) {
  const item = await resolveHistoryItem(historyId);
  const sourcePath = resolveSourcePath(item);
  const { width, height } = await probeVideoStreamInfo(sourcePath);
  if (!(width > 0) || !(height > 0)) throw new ServerError('Could not read the clip size', { status: 422, code: 'SIZE_UNKNOWN' });
  if (isAlreadyTallEnough(width, height, ratioId)) {
    throw new ServerError(`This clip is already as tall as ${ratioId}`, { status: 400, code: 'ALREADY_VERTICAL' });
  }
  const target = verticalTargetSize(ratioId);

  const newFilename = `${id}.mp4`;
  const newPath = join(PATHS.videos, newFilename);
  const renderStartedAtMs = Date.now();
  console.log(`📱 Vertical [${item.id.slice(0, 8)} → ${id.slice(0, 8)}] ${ratioId} ${target.width}x${target.height}`);
  const result = await filterVideoFrames(sourcePath, newPath, { filterComplex: verticalFilterGraph(ratioId), signal, label: 'vertical' });
  if (!result.ok) {
    await discardUnpublishedVideo({ jobId: id, outputPath: newPath });
    throw new ServerError(`Vertical export failed: ${result.reason}`, { status: 500, code: 'FFMPEG_FAILED' });
  }
  return withBackupAssetPublication(async () => {
    let committed = false;
    try {
      const thumbnail = await generateThumbnail(newPath, id);
      const frames = await probeFrameCount(newPath);
      const newEntry = {
        ...omitDerivedRenderFields(item),
        id,
        filename: newFilename,
        thumbnail,
        createdAt: new Date().toISOString(),
        width: target.width,
        height: target.height,
        ...(Number.isFinite(frames) ? { numFrames: frames } : {}),
        verticalFrom: item.id,
        vertical: { ratio: ratioId, fill: 'blur' },
        hidden: false,
        ...renderTimingFields(renderStartedAtMs),
      };
      await mutateVideoHistory((history) => { history.unshift(newEntry); return history; });
      committed = true;
      console.log(`✅ Vertical [${id.slice(0, 8)}]: ${newFilename}`);
      return newEntry;
    } catch (error) {
      if (!committed) await discardUnpublishedVideo({ jobId: id, outputPath: newPath });
      throw error;
    }
  });
}
