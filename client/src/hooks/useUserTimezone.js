/**
 * Resolve the user's configured IANA timezone (`settings.timezone`) once, falling back to the browser
 * zone then UTC.
 *
 * Returns the tz string. Use when: A date-scoped surface that must derive "today" the same way the
 * server does (POST launcher/history day keys, #2681).
 */

import { useState, useEffect } from 'react';
import { getSettings } from '../services/apiSystem.js';
import { isValidTimezone } from '../utils/timezone.js';

/**
 * Resolve the user's CONFIGURED IANA timezone (`settings.timezone`) once on mount, so date-scoped POST surfaces derive "today" as the server does (issue #2681); a client keyed off `new Date().toISOString()` (UTC) would disagree around the local/UTC midnight boundary.
 * Fallback chain mirrors the server's `getUserTimezone`: configured tz → the browser's IANA zone (which `useTimezoneBootstrap` in App.jsx seeds into settings, so they normally match) → 'UTC'. A transient settings-fetch failure fails open to the browser zone rather than blocking render, and it starts there so the first paint is already close.
 * @returns {string} IANA timezone string
 */
export default function useUserTimezone() {
  const browserZone = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  })();
  const [timezone, setTimezone] = useState(browserZone);

  useEffect(() => {
    getSettings({ silent: true })
      .then((s) => {
        const tz = s?.timezone;
        if (!tz) return; // unconfigured: keep the browser zone (self-heal seeds it)
        // A hand-edited/invalid configured tz makes the server fall back to its
        // process timezone (UTC under TZ=UTC). Match that instead of letting
        // dayKeyInTimezone silently drift to the browser zone (issue #2681 r4).
        setTimezone(isValidTimezone(tz) ? tz : 'UTC');
      })
      .catch(() => {});
  }, []);

  return timezone;
}
