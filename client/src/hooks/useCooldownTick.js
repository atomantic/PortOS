import { useRef, useState, useEffect } from 'react';

// Shared 1-second cooldown ticker for the agents tabs. Three near-identical
// implementations (`OverviewTab`, `ToolsTab`, `WorldTab`) each ran their own
// `setInterval` that bumped a local `tick` so countdown labels re-rendered and
// fired a refetch once every cooldown expired. Collapsed into one hook.
//
// `cooldownEnds` is a `{ [actionId]: epochMillis }` map; the interval only runs
// while at least one entry is still in the future. `onAllExpired` fires once,
// the first tick after every entry crosses the deadline, and the interval is
// cleared at that same tick so a missing/no-op callback can't leave us spinning
// forever. When the caller's expiry handler swaps in a fresh `cooldownEnds`
// (new ref, new deadlines), the effect re-runs and a new interval starts.
// Latest-callback is kept in a ref so consumers don't have to memoize it — the
// interval's lifecycle is driven by `cooldownEnds` alone, matching the
// originals where the surrounding account/refetch dep only affected the
// *closure*, not the timer's start/stop.
export function useCooldownTick(options = {}) {
  const { cooldownEnds = {}, onAllExpired } = options;
  const [, setTick] = useState(0);
  // Update the ref during render (not in a useEffect) so the latest callback
  // is always visible to the interval tick — a useEffect-driven ref update
  // can lag one render behind and, if `onAllExpired` changes right before
  // the expiry tick, the interval would fire the previous closure once.
  // Pattern mirrored from usePostSession.js / useCityAudio.js.
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
