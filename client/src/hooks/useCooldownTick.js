import { useEffect, useRef, useState } from 'react';

// Shared 1-second cooldown ticker for the agents tabs. Three near-identical
// implementations (`OverviewTab`, `ToolsTab`, `WorldTab`) each ran their own
// `setInterval` that bumped a local `tick` so countdown labels re-rendered and
// fired a refetch once every cooldown expired. Collapsed into one hook.
//
// `cooldownEnds` is a `{ [actionId]: epochMillis }` map; the interval only runs
// while at least one entry is still in the future. `onAllExpired` fires once,
// the first tick after every entry crosses the deadline. Latest-callback is
// kept in a ref so consumers don't have to memoize it — the interval's
// lifecycle is driven by `cooldownEnds` alone, matching the originals where
// the surrounding account/refetch dep only affected the *closure*, not the
// timer's start/stop.
export function useCooldownTick({ cooldownEnds, onAllExpired }) {
  const [, setTick] = useState(0);
  const callbackRef = useRef(onAllExpired);
  useEffect(() => {
    callbackRef.current = onAllExpired;
  });

  useEffect(() => {
    const hasActive = Object.values(cooldownEnds).some((end) => end > Date.now());
    if (!hasActive) return;
    let refetched = false;
    const interval = setInterval(() => {
      const stillActive = Object.values(cooldownEnds).some((end) => end > Date.now());
      setTick((t) => t + 1);
      if (!stillActive && !refetched) {
        refetched = true;
        callbackRef.current?.();
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [cooldownEnds]);
}
