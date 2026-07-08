/**
 * YouTube Watch-History Sync Scheduler (#2153)
 *
 * Registers an interval job that periodically runs the CDP scrape of the
 * signed-in YouTube history page (see youtubeSync.js). Mirrors spotifyScheduler /
 * imessageScheduler.
 *
 * OFF by default: only registered when the user has opted in via Settings →
 * YouTube (`settings.youtube.enabled`) AND is logged into YouTube in the managed
 * browser. The history page is DAY-bucketed, so the ~8h default cadence is
 * deliberately conservative (a polite scraper — polling more buys nothing). The
 * interval is locked at registration (changing it needs a restart), but the
 * `enabled` toggle is re-read every tick so disabling stops runs without a restart.
 *
 * No LLM calls happen on this path — extraction is deterministic DOM reading — so
 * the no-cold-bootstrap AI policy does not gate it; the opt-in is purely about
 * user intent + a signed-in browser profile.
 */

import { schedule } from './eventScheduler.js';
import { getYoutubeConfig, runSync } from './youtubeSync.js';

const EVENT_ID = 'youtube-sync';

/**
 * Start the YouTube sync scheduler. No-ops when disabled in settings.
 */
export async function startYoutubeScheduler() {
  const { enabled, intervalMinutes } = await getYoutubeConfig();

  if (!enabled) {
    console.log('📺 YouTube sync scheduler: disabled in settings — skipping');
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
      const current = await getYoutubeConfig();
      if (!current.enabled) {
        console.log('📺 YouTube sync scheduler: disabled since registration — skipping run');
        return;
      }
      await runSync();
    },
    metadata: { source: 'youtubeScheduler' },
  });

  console.log(`📺 YouTube sync scheduler: registered every ${intervalMinutes}min`);
}
