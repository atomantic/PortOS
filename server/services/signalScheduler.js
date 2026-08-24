/**
 * Signal Desktop Sync Scheduler (#2154)
 *
 * Registers an interval job that periodically runs the incremental Signal
 * ingestion (see signalSync.js). Shape shared with the iMessage/Spotify/YouTube
 * schedulers via `createSyncScheduler` (server/lib/createSettingsGatedSyncScheduler.js).
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

import { createSyncScheduler } from './createSettingsGatedSyncScheduler.js';
import { getSignalConfig, runSync } from './signalSync.js';

/**
 * Start the Signal sync scheduler. No-ops when disabled in settings.
 */
export const startSignalScheduler = createSyncScheduler({
  id: 'signal-sync',
  label: 'Signal',
  icon: '🔒',
  source: 'signalScheduler',
  getConfig: getSignalConfig,
  runSync,
});
