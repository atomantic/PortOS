/**
 * iMessage Sync Scheduler (#2151)
 *
 * Registers an interval job that periodically runs the incremental iMessage
 * ingestion (see imessageSync.js). Mirrors the citySnapshotScheduler pattern.
 *
 * OFF by default: the scheduler is only registered when the user has opted in via
 * Settings → iMessage (`settings.imessage.enabled`). Reading chat.db needs macOS
 * Full Disk Access, so we never poll it silently. The interval value is locked in
 * at registration (changing it needs a restart), but the `enabled` toggle is
 * re-read on every tick so disabling from settings stops runs without a restart.
 *
 * No LLM calls happen on this path — ingestion is deterministic — so the
 * no-cold-bootstrap AI policy does not gate it; the opt-in is purely about Full
 * Disk Access + user intent.
 */

import { schedule } from './eventScheduler.js';
import { getImessageConfig, runSync } from './imessageSync.js';

const EVENT_ID = 'imessage-sync';

/**
 * Start the iMessage sync scheduler. No-ops when disabled in settings.
 */
export async function startImessageScheduler() {
  const { enabled, intervalMinutes } = await getImessageConfig();

  if (!enabled) {
    console.log('💬 iMessage sync scheduler: disabled in settings — skipping');
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
      const current = await getImessageConfig();
      if (!current.enabled) {
        console.log('💬 iMessage sync scheduler: disabled since registration — skipping run');
        return;
      }
      await runSync();
    },
    metadata: { source: 'imessageScheduler' },
  });

  console.log(`💬 iMessage sync scheduler: registered every ${intervalMinutes}min`);
}
