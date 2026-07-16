import { useState, useEffect } from 'react';
import { getSettings } from '../services/api';

/**
 * Resolve the user's CONFIGURED IANA timezone (`settings.timezone`) once on
 * mount, so date-scoped POST surfaces derive "today" the same way the server
 * does (issue #2681). The server stamps and windows POST records on the
 * configured local day; a client that keyed off `new Date().toISOString()` (UTC)
 * would disagree around the local/UTC midnight boundary.
 *
 * Fallback chain mirrors the server's `getUserTimezone`: configured tz →
 * browser's own IANA zone (which `useTimezoneBootstrap` in App.jsx seeds into
 * settings on first load, so the two normally match) → 'UTC'. A transient
 * settings-fetch failure fails open to the browser zone rather than blocking
 * render. Starts at the browser zone so the first paint is already close.
 *
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
      .then((s) => { if (s?.timezone) setTimezone(s.timezone); })
      .catch(() => {});
  }, []);

  return timezone;
}
