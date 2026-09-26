/**
 * Settings-gated sync scheduler factory (#4883)
 *
 * Four ingestion domains (iMessage, Signal, Spotify, YouTube) each register the
 * same interval job: read the domain's settings, no-op when the user hasn't
 * opted in, otherwise arm an interval that re-reads `enabled` on every tick so
 * flipping the toggle stops runs without a server restart. They differed only in
 * event id, log emoji/label, config getter, and the `runSync` they call — this
 * factory owns the shared shape so each domain file is its own opt-in rationale
 * plus a ~10-line instantiation.
 *
 * Registration is reconciled on settings saves. The handler also re-checks
 * `enabled` so a disable during an in-flight tick does not run a sync.
 */

import { schedule, cancel, getEvent } from './eventScheduler.js';
import { settingsEvents } from './settings.js';

/**
 * Build a `start*Scheduler()` function for one settings-gated sync domain.
 *
 * @param {object} options
 * @param {string} options.id - eventScheduler event id (e.g. `'spotify-sync'`).
 * @param {string} options.label - Human label used in logs (e.g. `'Spotify'`).
 * @param {string} options.icon - Log emoji prefix (e.g. `'🎧'`).
 * @param {string} options.source - `metadata.source` recorded on the scheduled event.
 * @param {() => Promise<{ enabled: boolean, intervalMinutes: number }>} options.getConfig
 *   Reads the domain's current settings at reconciliation and on every tick.
 * @param {() => Promise<unknown>} options.runSync - The domain's incremental ingestion.
 * @param {boolean} [options.listenForSettings=true] - False when another arming gate owns reconciliation.
 * @returns {() => Promise<void>} Reconcile function, also called at boot.
 */
export function createSyncScheduler({ id, label, icon, source, getConfig, runSync, listenForSettings = true }) {
  let registeredInterval = null;
  let reconciliation = Promise.resolve();

  function reconcile() {
    // Keep overlapping boot and settings-event reads in save order.
    reconciliation = reconciliation.catch(() => {}).then(async () => {
      const { enabled, intervalMinutes } = await getConfig();
      if (!enabled) {
        if (registeredInterval !== null) {
          cancel(id);
          registeredInterval = null;
        }
        console.log(`${icon} ${label} sync scheduler: disabled in settings — skipping`);
        return;
      }
      if (registeredInterval === intervalMinutes && getEvent(id)) return;

      schedule({
        id,
        type: 'interval',
        intervalMs: intervalMinutes * 60 * 1000,
        handler: async () => {
          // A disable during an in-flight tick still prevents the sync.
          const current = await getConfig();
          if (!current.enabled) {
            console.log(`${icon} ${label} sync scheduler: disabled since registration — skipping run`);
            return;
          }
          const result = await runSync();
          // `runSync()` reports a detected failure by returning `{ ok: false, error }`
          // rather than throwing (#7549) — surface it as a failed scheduler run so
          // the event's lastError/consecutiveFailures reflect reality instead of a
          // permanently "successful" run.
          if (result?.ok === false) {
            throw new Error(result.error || `${label} sync reported failure`);
          }
        },
        metadata: { source },
      });
      registeredInterval = intervalMinutes;
      console.log(`${icon} ${label} sync scheduler: registered every ${intervalMinutes}min`);
    });
    return reconciliation;
  }

  if (listenForSettings) {
    settingsEvents.on('settings:updated', () => {
      reconcile().catch((error) => console.error(`${icon} ${label} sync scheduler: reconciliation failed: ${error.message}`));
    });
  }
  return reconcile;
}
