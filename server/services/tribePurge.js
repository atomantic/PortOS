/**
 * Scheduler registration for the Tribe erasure sweep (#8459).
 *
 * Deleting a Tribe person is a soft delete; this daily sweep turns it into a
 * real erasure once the recovery window has passed — the person, their
 * touchpoints, identities and memory links, and every `record_audit` snapshot
 * of them. The same pass expires older tribe audit snapshots. The work itself
 * lives in `tribe.purgeDeletedPeople`.
 *
 * The handler owns its rejections: a sweep runs outside the request lifecycle,
 * where an escaping rejection takes the process down (root AGENTS.md). The log
 * line carries counts only — never a name or handle.
 */

import { createSweepScheduler } from './sweepScheduler.js';
import { purgeDeletedPeople } from './tribe.js';

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 15 * 60 * 1000;

export const runTribePurge = async () => {
  const result = await purgeDeletedPeople().catch((err) => {
    console.error(`❌ Tribe purge failed: ${err.message}`);
    return null;
  });
  if (result && (result.people > 0 || result.auditRows > 0)) {
    console.log(`🧹 Tribe purge: erased ${result.people} deleted people, ${result.auditRows} audit snapshots`);
  }
};

export const {
  start: startTribePurge,
  stop: stopTribePurge,
} = createSweepScheduler({
  id: 'tribe-purge',
  intervalMs: SWEEP_INTERVAL_MS,
  initialDelayMs: INITIAL_DELAY_MS,
  handler: runTribePurge,
  source: 'tribePurge',
});
