/**
 * iMessage Sync Scheduler (#2151)
 *
 * Registers an interval job that periodically runs the incremental iMessage
 * ingestion (see imessageSync.js). Shape shared with the Signal/Spotify/YouTube
 * schedulers via `createSyncScheduler` (server/lib/createSettingsGatedSyncScheduler.js).
 *
 * OFF by default: the scheduler is only registered when the user has opted in via
 * the iMessage Settings drawer on Comms → Messages → iMessage
 * (`settings.imessage.enabled`). Reading chat.db needs macOS Full Disk Access,
 * so we never poll it silently. The interval value is locked in
 * at registration (changing it needs a restart), but the `enabled` toggle is
 * re-read on every tick so disabling from settings stops runs without a restart.
 *
 * No LLM calls happen on this path — ingestion is deterministic — so the
 * no-cold-bootstrap AI policy does not gate it; the opt-in is purely about Full
 * Disk Access + user intent.
 */

import { createSyncScheduler } from './createSettingsGatedSyncScheduler.js';
import { getImessageConfig, runSync } from './imessageSync.js';

/**
 * Start the iMessage sync scheduler. No-ops when disabled in settings.
 */
export const startImessageScheduler = createSyncScheduler({
  id: 'imessage-sync',
  label: 'iMessage',
  icon: '💬',
  source: 'imessageScheduler',
  getConfig: getImessageConfig,
  runSync,
});
