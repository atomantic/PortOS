/**
 * Signal Desktop Sync Scheduler (#2154)
 *
 * Registers an interval job that periodically runs the incremental Signal
 * ingestion (see signalSync.js). Mirrors the imessageScheduler pattern.
 *
 * OFF by default: the scheduler is only registered when the user has opted in via
 * Settings → Signal (`settings.signal.enabled`). Reading the SQLCipher DB needs
 * the keychain-wrapped key + a DB snapshot, so we never poll it silently. The
 * interval value is locked in at registration (changing it needs a restart), but
 * the `enabled` toggle is re-read on every tick so disabling from settings stops
 * runs without a restart.
 *
 * No LLM calls happen on this path — ingestion is deterministic — so the
 * no-cold-bootstrap AI policy does not gate it; the opt-in is purely about
 * key/DB access + user intent.
 */

import { schedule } from './eventScheduler.js';
import { getSignalConfig, runSync } from './signalSync.js';

const EVENT_ID = 'signal-sync';

/**
 * Start the Signal sync scheduler. No-ops when disabled in settings.
 */
export async function startSignalScheduler() {
  const { enabled, intervalMinutes } = await getSignalConfig();

  if (!enabled) {
    console.log('🔒 Signal sync scheduler: disabled in settings — skipping');
    return;
  }

  const intervalMs = intervalMinutes * 60 * 1000;

  schedule({
    id: EVENT_ID,
    type: 'interval',
    intervalMs,
    handler: async () => {
      // Re-read settings each run so an `enabled: false` toggle takes effect
      // without a restart (the interval value itself is locked at registration).
      const current = await getSignalConfig();
      if (!current.enabled) {
        console.log('🔒 Signal sync scheduler: disabled since registration — skipping run');
        return;
      }
      await runSync();
    },
    metadata: { source: 'signalScheduler' },
  });

  console.log(`🔒 Signal sync scheduler: registered every ${intervalMinutes}min`);
}
