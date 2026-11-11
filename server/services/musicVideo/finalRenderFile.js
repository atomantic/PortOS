import { existsSync } from 'node:fs';
import { safeUnder } from '../../lib/ffmpeg.js';
import { PATHS } from '../../lib/fileUtils.js';
import { getHistoryItem } from '../videoGen/history.js';

/**
 * Resolves a video history id to its media history entry and verified file path under PATHS.videos.
 * Returns null if renderHistoryId is falsy, the entry is not found, or its file does not exist.
 *
 * @param {string|null|undefined} renderHistoryId
 * @returns {Promise<{ entry: object, path: string } | null>}
 */
export async function resolveRenderVideoFile(renderHistoryId) {
  if (!renderHistoryId) return null;
  const entry = await getHistoryItem(renderHistoryId);
  const path = entry?.filename ? safeUnder(PATHS.videos, entry.filename) : null;
  if (!path || !existsSync(path)) return null;
  return { entry, path };
}
