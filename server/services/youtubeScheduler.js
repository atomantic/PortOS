/**
 * YouTube Watch-History Sync Scheduler (#2153)
 *
 * Registers an interval job that periodically runs the CDP scrape of the
 * signed-in YouTube history page (see youtubeSync.js). Shape shared with the
 * iMessage/Signal/Spotify schedulers via `createSyncScheduler`
 * (server/lib/createSettingsGatedSyncScheduler.js).
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

import { createSyncScheduler } from './createSettingsGatedSyncScheduler.js';
import { getYoutubeConfig, runSync } from './youtubeSync.js';

/**
 * Start the YouTube sync scheduler. No-ops when disabled in settings.
 */
export const startYoutubeScheduler = createSyncScheduler({
  id: 'youtube-sync',
  label: 'YouTube',
  icon: '📺',
  source: 'youtubeScheduler',
  getConfig: getYoutubeConfig,
  runSync,
});
