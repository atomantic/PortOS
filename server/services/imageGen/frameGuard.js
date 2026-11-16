/**
 * Image Gen — degenerate-frame gate (issue #4173): the seam every provider's completion
 * passes through before writing a sidecar. Job-based providers return a `jobId` before the
 * PNG lands, so each calls it from its own completion handler rather than the dispatcher.
 */

import { basename } from 'path';
import { tryReadFile, unlinkGuarded } from '../../lib/fileUtils.js';
import { describeFrameStats, isDegenerateFrame } from '../../lib/imageFrameStats.js';
import { describeDegenerateFrame } from './noImageReason.js';

/**
 * Returns a user-facing failure string ONLY for a measured degenerate verdict; null for a
 * healthy frame, unmeasurable stats, or a file not on disk (those paths belong to the
 * existing missing-file and `INVALID_IMAGE` handling).
 * @param {string} pngPath absolute path to the frame a provider just wrote
 * @returns {Promise<string|null>} narrated failure, or null to let it through
 */
export async function degenerateFrameReason(pngPath) {
  if (!pngPath) return null;
  // A missing file is not this gate's verdict; providers own the "no image written" path.
  const buffer = await tryReadFile(pngPath, null);
  if (!buffer) return null;
  const stats = await describeFrameStats(buffer);
  if (!isDegenerateFrame(stats)) return null;
  console.warn(`🚫 Rejected empty frame (${stats.reason}): ${basename(pngPath)}`);
  return describeDegenerateFrame(stats.reason);
}

// Same gate, plus removal of the empty PNG so the gallery scan can't pick it up.
export async function rejectDegenerateFrame(pngPath) {
  const reason = await degenerateFrameReason(pngPath);
  if (reason) await unlinkGuarded(pngPath).catch(() => {});
  return reason;
}
