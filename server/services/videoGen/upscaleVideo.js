/** Non-destructive 2x upscaling for video-history items. */

import { existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, UUID_RE, copyFileGuarded, unlinkGuarded } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { safeUnder, generateThumbnail, upscaleVideo2x } from '../../lib/ffmpeg.js';
import { loadHistory, mutateVideoHistory } from './history.js';
import { omitRenderTiming, renderTimingFields } from '../../lib/renderTiming.js';

const UPLOADED_HISTORY_ID_RE = /^upload-[a-f0-9]{8}$/i;

// 2× Lanczos upscale of an existing history item. Writes the upscaled clip
// to a new file (never overwrites the original) and inserts a new history
// entry pointing at it, so the user gets both versions side-by-side in the
// gallery. Doubles width and height; aspect-ratio is preserved exactly.
//
// Returns the new history entry on success; throws ServerError on any
// missing-input / ffmpeg / file-system failure so the route can map it to
// a clean HTTP status.
export async function upscaleHistoryItem(historyId) {
  // Validate the input arg first — failing here surfaces a clean 400 even if
  // the history file happens to contain a record with a malformed id, and
  // it short-circuits the loadHistory I/O for obviously-bogus requests.
  // Rendered clips use UUIDs; shared-gallery uploads use their `upload-<uuid8>`
  // filename stem as the id. Keep the strict UUID check for render ids while
  // allowing the upload producer's documented id shape.
  if (typeof historyId !== 'string' || (!UUID_RE.test(historyId) && !UPLOADED_HISTORY_ID_RE.test(historyId))) {
    throw new ServerError('Invalid history id', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const history = await loadHistory();
  const item = history.find((h) => h.id === historyId);
  if (!item) throw new ServerError('Video not found', { status: 404, code: 'NOT_FOUND' });
  if (item.upscaledFrom) {
    throw new ServerError('Cannot upscale an already-upscaled video', { status: 400, code: 'ALREADY_UPSCALED' });
  }
  const sourcePath = safeUnder(PATHS.videos, item.filename);
  if (!sourcePath) throw new ServerError('Invalid video filename', { status: 400, code: 'VALIDATION_ERROR' });
  if (!existsSync(sourcePath)) throw new ServerError('Video file not found on disk', { status: 404, code: 'NOT_FOUND' });

  const newId = randomUUID();
  const newFilename = `${newId}.mp4`;
  const newPath = join(PATHS.videos, newFilename);
  // Wall-clock timing (#5878) for the pass the user actually waits through. An
  // upscale gets its own gallery card, so the ffmpeg pass is a real cost worth
  // reporting rather than leaving blank.
  const renderStartedAtMs = Date.now();
  // Copy first, then upscale-in-place — keeps the upscaler's atomic-rename
  // contract intact and means a mid-process kill leaves the source clip
  // untouched.
  await copyFileGuarded(sourcePath, newPath);
  console.log(`🔍 Upscaling video [${historyId.slice(0, 8)} → ${newId.slice(0, 8)}]: 2×`);
  const result = await upscaleVideo2x(newPath);
  if (!result.ok) {
    await unlinkGuarded(newPath).catch(() => {});
    throw new ServerError(`Upscale failed: ${result.reason}`, { status: 500, code: 'FFMPEG_FAILED' });
  }
  const thumbnail = await generateThumbnail(newPath, newId);
  // Build the new history entry from the original, but bump dimensions and
  // tag with `upscaledFrom: <id>` + a reusable suffix on the prompt so the
  // gallery row reads as "<original prompt> (2×)".
  const newEntry = {
    // Strip before the spread rather than relying on the override below to win:
    // `renderTimingFields` reports `{}` when it can't measure the span, and an
    // override that contributes no keys would silently leave the SOURCE render's
    // duration on a row that only ran an ffmpeg pass.
    ...omitRenderTiming(item),
    id: newId,
    filename: newFilename,
    width: (Number(item.width) || 0) * 2,
    height: (Number(item.height) || 0) * 2,
    thumbnail,
    createdAt: new Date().toISOString(),
    upscaledFrom: item.id,
    prompt: item.prompt ? `${item.prompt} (2×)` : '(upscaled 2×)',
    // Drop hidden so the upscaled version surfaces in the visible gallery
    // even when the source clip was hidden.
    hidden: false,
    ...renderTimingFields(renderStartedAtMs),
  };
  // Serialized append (re-reads inside the mutator) so a concurrent
  // download/render write can't drop the upscaled entry.
  await mutateVideoHistory((history) => { history.unshift(newEntry); return history; });
  console.log(`✅ Upscaled [${newId.slice(0, 8)}]: ${newFilename} (${newEntry.width}×${newEntry.height})`);
  return newEntry;
}
