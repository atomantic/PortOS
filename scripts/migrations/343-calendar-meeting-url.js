/**
 * Stamp `meetingUrl: null` onto the Google events already sitting in each
 * account's calendar cache.
 *
 * `normalizeGoogleEvent` now selects a join link out of Google's
 * `conferenceData.entryPoints` / `hangoutLink` and caches it as `meetingUrl`
 * (#6289), which the event drawer renders as a "Join meeting" action. Events
 * cached before that change simply lack the key.
 *
 * This is a SHAPE normalization, not a behavior change, and deliberately so.
 * Nothing reads the cached key's presence: the drawer gates on the value being
 * a usable http(s) URL, and the sync path's preserve-vs-clear decision reads
 * the RAW incoming Google event, never the cached one. So a missing key is
 * already handled correctly everywhere, and this migration exists to stop the
 * cache from carrying two shapes for one state — every Google event a current
 * install writes has the key, and after this every Google event it has ever
 * written does too. That keeps a hand-inspected cache, a future consumer, and
 * a diff between two installs from having to re-derive which absence means
 * what.
 *
 * It is additive and offline. It never fetches, never contacts Google, and
 * never overwrites an existing `meetingUrl` — a re-run, or an install that
 * already synced under the new code, is a no-op. Non-Google events (the
 * iCal/CalDAV/Outlook paths, which have no conference metadata to project) are
 * left exactly as they are. A missing cache directory is a fresh install:
 * nothing is created. An unreadable or wrong-shaped cache file is left
 * untouched rather than rewritten from a guess, since the next real sync
 * repairs it and a partial rewrite here would not. Rolling back is safe in
 * both directions: older code never touches the field.
 */

import { join } from 'path';
import { readdir } from 'fs/promises';
import { atomicWrite, readJSONFileStrict } from '../../server/lib/fileUtils.js';

const CACHE_REL = join('data', 'calendar', 'cache');
const GOOGLE_SOURCE = 'google-calendar';

export default {
  async up({ rootDir }) {
    const cacheDir = join(rootDir, CACHE_REL);
    const files = await readdir(cacheDir).catch(() => null);
    if (files === null) return { stamped: 0, files: 0, skipped: 0, reason: 'no calendar cache directory' };

    let stampedEvents = 0;
    let rewrittenFiles = 0;
    let skippedFiles = 0;

    for (const file of files.filter((f) => f.endsWith('.json'))) {
      const path = join(cacheDir, file);
      const { ok, value: cache } = await readJSONFileStrict(path, null);
      // Unreadable, absent, or not the `{ events: [...] }` shape this migration
      // knows how to walk — leave it for the next sync to rebuild.
      if (!ok || !cache || !Array.isArray(cache.events)) {
        skippedFiles++;
        continue;
      }

      let changed = 0;
      for (const event of cache.events) {
        if (!event || typeof event !== 'object') continue;
        if (event.source !== GOOGLE_SOURCE) continue;
        if ('meetingUrl' in event) continue;
        event.meetingUrl = null;
        changed++;
      }

      if (changed === 0) continue;
      // `atomicWrite` serializes the object itself; every other field, the
      // event ids, and `syncCursor` ride through untouched.
      await atomicWrite(path, cache);
      stampedEvents += changed;
      rewrittenFiles++;
    }

    if (stampedEvents > 0) {
      console.log(`📅 Stamped meetingUrl on ${stampedEvents} cached Google events across ${rewrittenFiles} account caches`);
    }
    return { stamped: stampedEvents, files: rewrittenFiles, skipped: skippedFiles };
  },
};
