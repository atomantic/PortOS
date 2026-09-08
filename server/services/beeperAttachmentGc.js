/**
 * Scheduler registration for the Beeper attachment mirror sweep (#37).
 *
 * ONE sweep does both jobs #13 asked for, because they read the same two
 * lists: the disk budget (least-recently-viewed eviction, guarded by a HEAD so
 * a file Beeper can no longer supply is never the one thrown away) and the
 * orphan backstop (a file no row points at, a row whose file is gone, an
 * abandoned `.partial`). Splitting them would mean enumerating the store
 * twice on every tick for no behavioural gain.
 *
 * `createSweepScheduler` rather than `createSyncScheduler`: this is local
 * housekeeping over the mirror, not an ingestion pass, and it must run whether
 * or not `settings.beeper.enabled` is on — bytes already on disk still count
 * against the budget after a user turns scheduled sync off. It is gated only
 * by having a store at all: with no `data/beeper/attachments` and no rows the
 * sweep is two cheap queries and a failed `readdir`.
 *
 * The handler owns its rejections. A sweep runs outside the request lifecycle,
 * where an escaping rejection takes the process down (root AGENTS.md).
 */

import { createSweepScheduler } from './sweepScheduler.js';
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
