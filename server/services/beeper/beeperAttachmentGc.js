/**
 * Scheduler registration for the Beeper attachment mirror sweep.
 *
 * ONE sweep does both the disk budget (least-recently-viewed eviction, guarded by
 * a HEAD so a file Beeper can no longer supply is never the one evicted) and the
 * orphan backstop (file with no row, row with no file, abandoned `.partial`);
 * they read the same two lists.
 *
 * `createSweepScheduler`, not `createSyncScheduler`: this is local housekeeping
 * that must run even when `settings.beeper.enabled` is off, since bytes on disk
 * still count against the budget. With no store it is two cheap queries and a
 * failed `readdir`.
 *
 * The handler owns its rejections: an escaping rejection outside the request
 * lifecycle takes the process down.
 */

import { createSweepScheduler } from '../sweepScheduler.js';
import { sweepBeeperAttachments } from './beeperAttachments.js';

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 10 * 60 * 1000;

const runSweep = async () => {
  await sweepBeeperAttachments().catch((err) => {
    console.error(`❌ Beeper attachment sweep failed: ${err.message}`);
  });
};

export const {
  start: startBeeperAttachmentGc,
  stop: stopBeeperAttachmentGc,
} = createSweepScheduler({
  id: 'beeper-attachment-gc',
  intervalMs: SWEEP_INTERVAL_MS,
  initialDelayMs: INITIAL_DELAY_MS,
  handler: runSweep,
  source: 'beeperAttachmentGc',
});
