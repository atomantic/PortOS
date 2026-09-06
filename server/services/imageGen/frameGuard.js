/**
 * Image Gen — degenerate-frame gate (issue #4173).
 *
 * Every provider path could previously finish "successfully" having written a
 * frame that decodes but has no content, and that frame became a gallery
 * record, a sidecar, an `imageRefs[]` entry, and a paid vision-judge call.
 * This is the one seam every provider's completion funnels through before it
 * writes a sidecar and emits `completed`.
 *
 * Contract — `degenerateFrameReason(pngPath)`:
 *   - returns a user-facing failure string ONLY for a measured degenerate
 *     verdict (`describeFrameStats(...).ok === false`);
 *   - returns `null` for a healthy frame, for a frame whose stats could not be
 *     computed (`ok: null`), and for a file that isn't on disk yet. Absent /
 *     unmeasurable must never be reported as a generation failure — the
 *     existing missing-file and `INVALID_IMAGE` paths still own those.
 *
 * Note the dispatcher (`index.js#generateImage`) can only apply this to a
 * provider that resolves AFTER writing its bytes (the synchronous external
 * SD-API path). The four job-based providers return a `jobId` long before the
 * PNG lands, so each of them calls the gate from its own completion handler.
 */

import { basename } from 'path';
import { tryReadFile, unlinkGuarded } from '../../lib/fileUtils.js';
import { describeFrameStats, isDegenerateFrame } from '../../lib/imageFrameStats.js';
import { describeDegenerateFrame } from './noImageReason.js';

/**
 * @param {string} pngPath absolute path to the frame a provider just wrote
 * @returns {Promise<string|null>} narrated failure, or null to let it through
 */
export async function degenerateFrameReason(pngPath) {
  if (!pngPath) return null;
  // A missing file is not this gate's verdict to give — the providers already
  // have a "no image was written" path with far better narration.
  const buffer = await tryReadFile(pngPath, null);
  if (!buffer) return null;
  const stats = await describeFrameStats(buffer);
  if (!isDegenerateFrame(stats)) return null;
  console.warn(`🚫 Rejected empty frame (${stats.reason}): ${basename(pngPath)}`);
  return describeDegenerateFrame(stats.reason);
}

/**
 * Same gate, plus the cleanup a job-based provider needs: the empty PNG is
 * removed so a half-written render can't be picked up by the gallery scan.
 */
export async function rejectDegenerateFrame(pngPath) {
  const reason = await degenerateFrameReason(pngPath);
  if (reason) await unlinkGuarded(pngPath).catch(() => {});
  return reason;
}
