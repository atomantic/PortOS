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
 * Deliberate carry-overs from the four hand-written originals:
 * - The interval value is LOCKED at registration; changing it needs a restart.
 *   Only `enabled` is re-read per tick.
 * - `enabled` is re-checked inside the handler, not just at registration, so a
 *   user disabling the sync mid-session doesn't keep polling until restart.
 */

import { schedule } from './eventScheduler.js';

/**
 * Build a `start*Scheduler()` function for one settings-gated sync domain.
 *
 * @param {object} options
 * @param {string} options.id - eventScheduler event id (e.g. `'spotify-sync'`).
 * @param {string} options.label - Human label used in logs (e.g. `'Spotify'`).
 * @param {string} options.icon - Log emoji prefix (e.g. `'🎧'`).
 * @param {string} options.source - `metadata.source` recorded on the scheduled event.
 * @param {() => Promise<{ enabled: boolean, intervalMinutes: number }>} options.getConfig
 *   Reads the domain's current settings. Called once at registration and again
 *   on every tick (for `enabled` only).
 * @param {() => Promise<unknown>} options.runSync - The domain's incremental ingestion.
 * @returns {() => Promise<void>} Start function that no-ops when disabled in settings.
 */
export function createSyncScheduler({ id, label, icon, source, getConfig, runSync }) {
  return async function startSyncScheduler() {
    const { enabled, intervalMinutes } = await getConfig();

    if (!enabled) {
      console.log(`${icon} ${label} sync scheduler: disabled in settings — skipping`);
      return;
    }

    schedule({
      id,
      type: 'interval',
      intervalMs: intervalMinutes * 60 * 1000,
      handler: async () => {
        // Re-read settings each run so an `enabled: false` toggle takes effect
        // without a restart (the interval value itself is locked at registration).
        const current = await getConfig();
        if (!current.enabled) {
          console.log(`${icon} ${label} sync scheduler: disabled since registration — skipping run`);
          return;
        }
        await runSync();
      },
      metadata: { source },
    });

    console.log(`${icon} ${label} sync scheduler: registered every ${intervalMinutes}min`);
  };
}
