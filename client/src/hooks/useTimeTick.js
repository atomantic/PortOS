import { useEffect, useState } from 'react';
import { subscribeVisibility } from './useVisibilityEvent.js';

// Singleton tickers keyed by intervalMs so N subscribers at the same cadence
// share one timer instead of spawning a setInterval per widget. A page with
// six widgets all asking for a minute tick should run one minute-interval
// timer, not six.
//
// Tickers also pause while the tab is hidden — there's no UI to refresh, so
// running the interval just burns CPU/battery in the background. Visibility
// orchestration piggybacks on `useVisibilityEvent`'s singleton emitter
// (`subscribeVisibility`) so the document-level listener count stays at one
// across this hook + every `useVisibilityEvent` consumer + `useAutoRefetch`.
// On tab show we fire once immediately so labels are correct before the
// next scheduled tick lands.
const tickers = new Map(); // intervalMs -> { handle, subscribers: Set<fn> }

const isHidden = () =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden';

const fire = (entry) => {
  const now = Date.now();
  for (const fn of entry.subscribers) fn(now);
};

const startTimer = (entry, intervalMs) => {
  if (entry.handle != null) return;
  entry.handle = setInterval(() => fire(entry), intervalMs);
};

const stopTimer = (entry) => {
  if (entry.handle == null) return;
  clearInterval(entry.handle);
  entry.handle = null;
};

const startTicker = (intervalMs) => {
  const entry = { handle: null, subscribers: new Set() };
  tickers.set(intervalMs, entry);
  if (!isHidden()) startTimer(entry, intervalMs);
  return entry;
};

// Lazy-attached subscription to the shared visibility emitter. We only
// subscribe while at least one ticker is alive — when the last subscriber
// unmounts we unsubscribe so the visibility singleton can detach its
// document-level listener if nothing else is using it.
let unsubscribeVisibility = null;

const handleVisibility = (state) => {
  if (state === 'hidden') {
    for (const entry of tickers.values()) stopTimer(entry);
  } else {
    for (const [intervalMs, entry] of tickers) {
      startTimer(entry, intervalMs);
      fire(entry);
    }
  }
};

const ensureVisibilitySubscribed = () => {
  if (unsubscribeVisibility) return;
  unsubscribeVisibility = subscribeVisibility(handleVisibility);
};

const releaseVisibilityIfIdle = () => {
  if (!unsubscribeVisibility || tickers.size > 0) return;
  unsubscribeVisibility();
  unsubscribeVisibility = null;
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
 * not six). Tickers also pause while the tab is hidden and fire once on
 * tab-visible so deduped labels catch up — the visibility listener is shared
 * with `useVisibilityEvent` so we don't grow the document-listener count.
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
    ensureVisibilitySubscribed();
    return () => {
      entry.subscribers.delete(setNow);
      if (entry.subscribers.size === 0) {
        stopTimer(entry);
        tickers.delete(intervalMs);
        releaseVisibilityIfIdle();
      }
    };
  }, [intervalMs]);

  return now;
}

// Test-only escape hatch — lets tests reset the singleton tickers between
// runs without exposing it as a public API.
export function __resetTimeTickForTests() {
  for (const entry of tickers.values()) stopTimer(entry);
  tickers.clear();
  if (unsubscribeVisibility) {
    unsubscribeVisibility();
    unsubscribeVisibility = null;
  }
}
