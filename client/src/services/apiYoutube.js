import { request } from './apiCore.js';

// YouTube watch-history ingestion (#2153) — CDP scrape of the signed-in history
// page in the managed browser + Takeout backfill, into the machine-local activity
// timeline. Config lives in settings.youtube; last-run state under data/youtube/.
// These wrappers drive the settings tab.
export const getYoutubeStatus = (options = {}) => request('/youtube/status', options);
export const getYoutubeSetupCheck = (options = {}) => request('/youtube/setup-check', options);
export const syncYoutube = (options = {}) => request('/youtube/sync', { method: 'POST', ...options });
