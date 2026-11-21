/**
 * Spotify Sync Scheduler (#2152)
 *
 * Registers an interval job that periodically runs the incremental Spotify
 * recently-played ingestion (see spotifySync.js). Shape shared with the
 * iMessage/Signal/YouTube schedulers via `createSyncScheduler`
 * (server/services/createSettingsGatedSyncScheduler.js).
 *
 * OFF by default: the scheduler is only registered when the user has connected
 * Spotify AND opted in via Settings → Spotify (`settings.spotify.enabled`). The
 * ~25-min default cadence keeps the timeline current. The interval and `enabled`
 * are reconciled on every settings save by `createSyncScheduler`
 * (createSettingsGatedSyncScheduler.js), and `enabled` is also re-read on every
 * tick so disabling mid-tick skips the run.
 *
 * No LLM calls happen on this path — ingestion is deterministic — so the
 * no-cold-bootstrap AI policy does not gate it; the opt-in is purely about user
 * intent + a completed OAuth connection.
 */

import { createSyncScheduler } from './createSettingsGatedSyncScheduler.js';
import { getSpotifyConfig, runSync, readSyncState } from './spotifySync.js';

/**
 * Start the Spotify sync scheduler. No-ops when disabled in settings.
 */
export const startSpotifyScheduler = createSyncScheduler({
  id: 'spotify-sync',
  label: 'Spotify',
  icon: '🎧',
  source: 'spotifyScheduler',
  getConfig: getSpotifyConfig,
  runSync,
  getLastRunAt: async () => (await readSyncState()).lastRunAt,
});
