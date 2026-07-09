/**
 * Spotify Sync Scheduler (#2152)
 *
 * Registers an interval job that periodically runs the incremental Spotify
 * recently-played ingestion (see spotifySync.js). Mirrors imessageScheduler.
 *
 * OFF by default: the scheduler is only registered when the user has connected
 * Spotify AND opted in via Settings → Spotify (`settings.spotify.enabled`). The
 * ~25-min default cadence beats the API's 50-track recently-played window so no
 * plays are missed. The interval value is locked at registration (changing it
 * needs a restart), but the `enabled` toggle is re-read on every tick so
 * disabling from settings stops runs without a restart.
 *
 * No LLM calls happen on this path — ingestion is deterministic — so the
 * no-cold-bootstrap AI policy does not gate it; the opt-in is purely about user
 * intent + a completed OAuth connection.
 */

import { schedule } from './eventScheduler.js';
import { getSpotifyConfig, runSync } from './spotifySync.js';

const EVENT_ID = 'spotify-sync';

/**
 * Start the Spotify sync scheduler. No-ops when disabled in settings.
 */
export async function startSpotifyScheduler() {
  const { enabled, intervalMinutes } = await getSpotifyConfig();

  if (!enabled) {
    console.log('🎧 Spotify sync scheduler: disabled in settings — skipping');
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
      const current = await getSpotifyConfig();
      if (!current.enabled) {
        console.log('🎧 Spotify sync scheduler: disabled since registration — skipping run');
        return;
      }
      await runSync();
    },
    metadata: { source: 'spotifyScheduler' },
  });

  console.log(`🎧 Spotify sync scheduler: registered every ${intervalMinutes}min`);
}
