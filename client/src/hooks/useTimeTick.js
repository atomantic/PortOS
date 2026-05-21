import { useEffect, useState } from 'react';

// Singleton tickers keyed by intervalMs so N subscribers at the same cadence
// share one timer instead of spawning a setInterval per widget. A page with
// six widgets all asking for a minute tick should run one minute-interval
// timer, not six.
const tickers = new Map(); // intervalMs -> { handle, subscribers: Set<fn> }

const startTicker = (intervalMs) => {
  const entry = { handle: null, subscribers: new Set() };
  entry.handle = setInterval(() => {
    const now = Date.now();
    for (const fn of entry.subscribers) fn(now);
  }, intervalMs);
  tickers.set(intervalMs, entry);
  return entry;
};

/**
 * Re-render at a fixed cadence so derived-from-`Date.now()` UI (relative
 * timestamps, threshold-based health labels, countdowns) stays accurate even
 * when the underlying data is deduped by `useAutoRefetch`'s `compare` option.
 *
 * Returns the current `Date.now()` snapshot, which is also useful as a
 * dependency for `useMemo` callers that derive labels from a base timestamp.
 *
 * Subscribers grouped by `intervalMs` share one underlying `setInterval` (so
 * a Dashboard with six widgets calling `useTimeTick(60000)` runs one timer,
 * not six).
 *
 * @param {number} intervalMs - tick cadence. 60000 (one minute) is the right
 *   default for "X min ago" labels; bump to 3600000 for hourly "X hours ago"
 *   surfaces; 1000 only for true seconds-precision counters.
 * @returns {number} the latest `Date.now()` snapshot at the most recent tick.
 */
export function useTimeTick(intervalMs = 60000) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    let entry = tickers.get(intervalMs);
    if (!entry) entry = startTicker(intervalMs);
    entry.subscribers.add(setNow);
    return () => {
      entry.subscribers.delete(setNow);
      if (entry.subscribers.size === 0) {
        clearInterval(entry.handle);
        tickers.delete(intervalMs);
      }
    };
  }, [intervalMs]);

  return now;
}

// Test-only escape hatch — lets tests reset the singleton tickers between
// runs without exposing it as a public API.
export function __resetTimeTickForTests() {
  for (const entry of tickers.values()) {
    if (entry.handle) clearInterval(entry.handle);
  }
  tickers.clear();
}
