/**
 * 1-second ticker over a `{ id: epochMs }` cooldown map.
 *
 * Fires `onAllExpired` once when every deadline passes. Use when: Rate-limit countdown labels that
 * need to refetch when the last cooldown clears (agents tabs pattern).
 */

import { useRef, useState, useEffect } from 'react';

// Shared 1-second cooldown ticker for the agents tabs (collapsing the `OverviewTab` / `ToolsTab` / `WorldTab` copies). `cooldownEnds` is a `{ [actionId]: epochMillis }` map; the interval runs only while an entry is in the future. `onAllExpired` fires once, the first tick after every entry crosses its deadline, and the interval is cleared at that tick so a missing/no-op callback can't spin forever;
// if the expiry handler swaps in a fresh `cooldownEnds` the effect re-runs and a new interval starts. The latest callback lives in a ref so consumers needn't memoize it; the interval's lifecycle is driven by `cooldownEnds` alone.
export function useCooldownTick(options = {}) {
  const { cooldownEnds = {}, onAllExpired } = options;
  const [, setTick] = useState(0);
  // Update the ref during render (not in a useEffect) so the latest callback
  // is always visible to the interval tick — a useEffect-driven ref update
  // can lag one render behind and, if `onAllExpired` changes right before
  // the expiry tick, the interval would fire the previous closure once.
  // Pattern mirrored from usePostSession.js.
  const callbackRef = useRef(onAllExpired);
  callbackRef.current = onAllExpired;

  useEffect(() => {
    const hasActive = Object.values(cooldownEnds).some((end) => end > Date.now());
    if (!hasActive) return;
    let interval = null;
    const stop = () => {
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    };
    interval = setInterval(() => {
      const stillActive = Object.values(cooldownEnds).some((end) => end > Date.now());
      setTick((t) => t + 1);
      if (!stillActive) {
        // Fire the one-shot expiry signal and stop ticking. If the caller's
        // handler refetches and produces a fresh `cooldownEnds` (different ref
        // with new deadlines), the effect re-runs and a new interval starts.
        // If it doesn't (handler omitted, network error, no new cooldowns),
        // we don't spin forever re-rendering for no reason.
        stop();
        callbackRef.current?.();
      }
    }, 1000);
    return stop;
  }, [cooldownEnds]);
}
