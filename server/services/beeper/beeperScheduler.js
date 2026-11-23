/**
 * Beeper ingestion sweep scheduler (`createSyncScheduler`; `syncSchedulers.parity.test.js` pins its id).
 *
 * TWO gates: `isBeeperIngestionArmed()` (instance FEATURE plus token) is checked SILENTLY, so
 * a feature-off install registers and logs nothing; `settings.beeper.enabled` is handed to the
 * factory so turning it off mid-session stops runs without a restart.
 *
 * The first run is one interval AFTER registration, never at boot. `bootstrap.js` calls
 * `startBeeperScheduler()` directly, never `reconcileBeeperIngestion()` (which kicks an
 * immediate sweep off live triggers only).
 *
 * A running interval does not notice a settings change, so `restartBeeperScheduler()` re-registers.
 * `server/routes/settings.js` calls it on an interval change, including when an `enabled` flip
 * lands in the same save but the scheduler was already registered (true→false leaves it
 * registered), since reconcile's `!isBeeperSchedulerRegistered()` guard would keep the stale interval.
 */

import { createSyncScheduler } from '../createSettingsGatedSyncScheduler.js';
import { cancel, getEvent } from '../eventScheduler.js';
import { getBeeperSyncConfig, isBeeperIngestionArmed, runBeeperSweep } from './beeperSync.js';

const SCHEDULER_EVENT_ID = 'beeper-sync';

const registerBeeperScheduler = createSyncScheduler({
  id: SCHEDULER_EVENT_ID,
  label: 'Beeper',
  icon: '🫧',
  source: 'beeperScheduler',
  listenForSettings: false, // beeperArming owns the feature and credential gates
  getConfig: getBeeperSyncConfig,
  runSync: () => runBeeperSweep({ reason: 'scheduler' }),
});

/** Whether `beeper-sync` is currently registered with the event scheduler. */
export function isBeeperSchedulerRegistered() {
  return Boolean(getEvent(SCHEDULER_EVENT_ID));
}

/**
 * Start the scheduler; no-op when unarmed or already registered (re-`schedule()`
 * resets `nextRunAt` a whole interval away).
 */
export async function startBeeperScheduler() {
  if (isBeeperSchedulerRegistered()) return;
  if (!await isBeeperIngestionArmed()) return;
  await registerBeeperScheduler();
}

/**
 * Cancel the scheduler; returns whether an event was cancelled.
 */
export function stopBeeperScheduler() {
  return cancel(SCHEDULER_EVENT_ID);
}

/**
 * Cancel and re-register against the current config. Deliberately kicks no
 * immediate sweep (only ARMING does).
 */
export async function restartBeeperScheduler() {
  stopBeeperScheduler();
  await startBeeperScheduler();
}
