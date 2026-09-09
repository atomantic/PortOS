/**
 * Beeper Ingestion Sweep Scheduler (#32, decided on #12).
 *
 * The fifth instance of `createSyncScheduler`, alongside iMessage, Signal,
 * Spotify and YouTube, so the per-tick `enabled` re-read and the self-healing
 * re-arm come free and `syncSchedulers.parity.test.js` pins this domain's id,
 * source and log line like every other.
 *
 * TWO gates, and they are not the same flag (#11 keeps them apart):
 *   - `isBeeperIngestionArmed()` — the instance FEATURE plus a configured
 *     token. Checked here, and SILENTLY: #32's acceptance is that with the
 *     feature off or no token, nothing registers and nothing logs, so a fresh
 *     install never narrates a feature it does not have.
 *   - `settings.beeper.enabled` — the user's own "Enable scheduled Beeper
 *     sync" toggle from the Comms → Beeper card. Handed to the factory as
 *     `enabled`, so turning it off mid-session stops runs without a restart
 *     and logs the same "disabled in settings" line every other domain does.
 *
 * `type: 'interval'` means the first run is one interval AFTER registration,
 * never at boot — intended: boot should not fire a network sweep.
 * `bootstrap.js` calls `startBeeperScheduler()` directly for exactly that
 * reason, never through `beeperArming.js`'s `reconcileBeeperIngestion()` — the
 * one and only place that kicks an immediate sweep on ARMING (fork issue #79)
 * is that reconcile, which runs only off a live trigger (connect, a feature
 * toggle, the sync toggle), never off boot. A throwing handler cannot kill the
 * interval either; `eventScheduler.runEvent` catches the rejection, records
 * the failed run and re-arms.
 *
 * The interval is read fresh at every REGISTRATION (the factory's documented
 * carry-over from the four hand-written originals still locks it between
 * registrations — a running interval does not notice a settings change
 * mid-flight). Fork issue #79's fix for "a new interval only takes effect
 * after a restart" is therefore `restartBeeperScheduler()` below: cancel the
 * current registration and register a fresh one, which reads
 * `getBeeperSyncConfig()` again and picks up whatever is stored right now.
 * `server/routes/settings.js` calls it when a save changes the interval
 * without an `enabled` flip, AND — fork issue #94 — when a flip and an
 * interval change land in the same save but the scheduler was already
 * registered going in (a true→false save leaves it registered; it only gates
 * per tick), because `reconcileBeeperIngestion()`'s own registration guard
 * (`!isBeeperSchedulerRegistered()`) then declines to re-register and the
 * stale `intervalMs` would otherwise survive.
 *
 * No LLM calls happen on this path — ingestion is deterministic — so the
 * no-cold-bootstrap AI policy does not gate it; the opt-in is about the user's
 * credential and intent.
 */

import { createSyncScheduler } from './createSettingsGatedSyncScheduler.js';
import { cancel, getEvent } from './eventScheduler.js';
import { getBeeperSyncConfig, isBeeperIngestionArmed, runBeeperSweep } from './beeperSync.js';

const SCHEDULER_EVENT_ID = 'beeper-sync';

const registerBeeperScheduler = createSyncScheduler({
  id: SCHEDULER_EVENT_ID,
  label: 'Beeper',
  icon: '🫧',
  source: 'beeperScheduler',
  getConfig: getBeeperSyncConfig,
  runSync: () => runBeeperSweep({ reason: 'scheduler' }),
});

/** Whether `beeper-sync` is currently registered with the event scheduler. */
export function isBeeperSchedulerRegistered() {
  return Boolean(getEvent(SCHEDULER_EVENT_ID));
}

/**
 * Start the Beeper ingestion sweep scheduler. Returns without registering —
 * and without logging — when the instance feature is off or no token is
 * configured.
 *
 * Registering again while `beeper-sync` is already scheduled is a no-op rather
 * than a re-`schedule()`: `eventScheduler.schedule` cancels and replaces an
 * event with the same id, which resets `nextRunAt` to a whole interval away. A
 * user toggling the Comms group twice would otherwise keep pushing the next
 * sweep out.
 */
export async function startBeeperScheduler() {
  if (isBeeperSchedulerRegistered()) return;
  if (!await isBeeperIngestionArmed()) return;
  await registerBeeperScheduler();
}

/**
 * Cancel the sweep scheduler — the disarm half (the feature turned off, the
 * credential deleted). Returns whether an event was actually cancelled, so the
 * caller can keep its logging to real transitions.
 */
export function stopBeeperScheduler() {
  return cancel(SCHEDULER_EVENT_ID);
}

/**
 * Cancel and re-register the sweep scheduler against whatever
 * `getBeeperSyncConfig()` reads right now — the interval-change half of fork
 * issue #79. `startBeeperScheduler()` deliberately no-ops once `beeper-sync`
 * is already registered (see its own docblock: a second `schedule()` call
 * resets `nextRunAt` a whole interval into the future, which is exactly wrong
 * for a toggle that did not touch the cadence). An interval change is the one
 * case that guard must NOT swallow, so this cancels first and lets
 * `startBeeperScheduler()` register fresh.
 *
 * Deliberately does not kick an immediate sweep — only ARMING does that
 * (`beeperArming.js`'s `reconcileBeeperIngestion()`). Changing the cadence of
 * an already-running scheduler is a different event, and firing a sweep on
 * every interval edit would surprise a user who is just tuning a number.
 *
 * A no-op, like `startBeeperScheduler()`, when the feature is off or no token
 * is configured: `stopBeeperScheduler()` cancels whatever was registered (or
 * nothing, harmlessly), and the re-registration attempt then declines the
 * same way `startBeeperScheduler()` always has.
 */
export async function restartBeeperScheduler() {
  stopBeeperScheduler();
  await startBeeperScheduler();
}
