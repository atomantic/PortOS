/**
 * Beeper ingestion arming — the one place that decides whether the sweep
 * scheduler and the realtime transport should be live.
 *
 * Both are gated on `isBeeperIngestionArmed()` (the instance FEATURE plus a
 * vaulted token), which boot alone cannot track on a live install.
 * `reconcileBeeperIngestion()` reads the gate and moves both subsystems to match;
 * call it after a credential is stored, after the feature (or its Comms group)
 * changes, and after a disconnect deletes the credential.
 *
 * IDEMPOTENT: the scheduler registers only when `eventScheduler` does not already
 * hold `beeper-sync` (re-registering pushes the next sweep a full interval out).
 * Calls serialize on one tail so overlapping triggers cannot interleave gate-read
 * and start/stop. Logging is transition-only.
 *
 * **Arming also kicks one sweep immediately** (`runBeeperSweep({ reason: 'arm' })`,
 * fire-and-forget) when a reconcile newly registers the scheduler. Not via
 * `triggerNow`: a direct call leaves `nextRunAt` at registration + one interval.
 */

import { isBeeperIngestionArmed, runBeeperSweep } from './beeperSync.js';
import { isBeeperSchedulerRegistered, startBeeperScheduler, stopBeeperScheduler } from './beeperScheduler.js';
import { isBeeperSocketRunning, startBeeperSocket, stopBeeperSocket } from './beeperSocket.js';

const LOG_PREFIX = '🫧 Beeper ingestion';

// Serializes overlapping reconciles. Rejections are absorbed here so one failed
// reconcile cannot poison every later one.
let tail = Promise.resolve();

/**
 * Bring the sweep scheduler and the realtime transport into line with the gate.
 *
 * @param {object} [options]
 * @param {string} [options.reason] - What triggered this, for the log line.
 * @returns {Promise<{armed: boolean, socketRunning: boolean, schedulerRegistered: boolean, changed: boolean}>}
 */
export function reconcileBeeperIngestion({ reason = 'unspecified', restartSocket = false } = {}) {
  const run = () => reconcileOnce(reason, restartSocket);
  const next = tail.then(run, run);
  tail = next.then(() => {}, () => {});
  return next;
}

async function reconcileOnce(reason, restartSocket) {
  // An unreadable gate already resolves to `false` inside `isBeeperIngestionArmed`.
  if (!await isBeeperIngestionArmed()) return disarm(reason);

  // The transport arms on the feature+token gate alone (it writes nothing). A
  // connection-setting or credential change must retire the old transport first.
  if (restartSocket) stopBeeperSocket();
  const socketStarted = await startBeeperSocket();

  // `startBeeperScheduler` owns the `settings.beeper.enabled` opt-in check.
  let schedulerStarted = false;
  if (!isBeeperSchedulerRegistered()) {
    await startBeeperScheduler();
    schedulerStarted = isBeeperSchedulerRegistered();
  }

  // A fresh registration on a LIVE trigger (never boot) earns one immediate
  // sweep. `Promise.resolve` tolerates a test double returning `undefined`; not
  // awaited because reconciles serialize on `tail` and a long sweep would stall a
  // toggle-off landing right behind this one.
  if (schedulerStarted) {
    Promise.resolve(runBeeperSweep({ reason: 'arm' })).catch((err) => {
      console.error(`${LOG_PREFIX}: immediate sweep on arm failed: ${err.message}`);
    });
  }

  const changed = socketStarted || schedulerStarted;
  if (changed) console.log(`${LOG_PREFIX}: armed (${reason})`);
  return {
    armed: true,
    socketRunning: isBeeperSocketRunning(),
    schedulerRegistered: isBeeperSchedulerRegistered(),
    changed,
  };
}

function disarm(reason) {
  const socketStopped = stopBeeperSocket();
  const schedulerStopped = stopBeeperScheduler();
  const changed = socketStopped || schedulerStopped;
  if (changed) console.log(`${LOG_PREFIX}: disarmed (${reason})`);
  return { armed: false, socketRunning: false, schedulerRegistered: false, changed };
}
