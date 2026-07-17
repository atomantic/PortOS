import { useEffect, useRef } from 'react';

/**
 * Hold a screen wake lock (navigator.wakeLock) while `active` is true — keeps
 * the display on during hands-free surfaces like SongBook's autoscrolling play
 * view. No-op where the Wake Lock API is unsupported (older Safari, jsdom).
 *
 * The browser force-releases wake locks when the tab is hidden, so a
 * visibilitychange listener re-acquires on return while still active. A
 * generation counter makes a request that resolves after deactivation/unmount
 * release itself immediately instead of leaking a held lock, and an in-flight
 * request ref keeps concurrent same-generation acquires from racing (two
 * pending wakeLock.request calls — the second overwriting lockRef while the
 * first's sentinel is never released).
 */
export default function useWakeLock(active) {
  const lockRef = useRef(null);
  const generationRef = useRef(0);

  useEffect(() => {
    const wakeLock = typeof navigator !== 'undefined' ? navigator.wakeLock : undefined;
    if (!active || !wakeLock?.request) return undefined;

    const generation = ++generationRef.current;
    // In-flight request for THIS activation — effect-local so a stale
    // generation's pending request never blocks the next activation's acquire
    // (cross-generation staleness is the generation counter's job).
    let pending = null;

    const acquire = () => {
      // Re-entrancy guard: skip when a request is already pending, or a live
      // (not UA-released) lock is already held — a second concurrent request
      // would leak whichever sentinel loses the lockRef assignment.
      if (pending) return;
      if (lockRef.current && !lockRef.current.released) return;
      pending = wakeLock.request('screen')
        .catch(() => null)
        .then((lock) => {
          pending = null;
          if (!lock) return;
          // Deactivated (or re-activated) while the request was in flight, or
          // a live lock is somehow already held — this acquisition is stale;
          // release it rather than adopting it.
          if (generationRef.current !== generation || (lockRef.current && !lockRef.current.released)) {
            lock.release().catch(() => {});
            return;
          }
          lockRef.current = lock;
        });
    };

    const onVisibility = () => {
      // The UA auto-released the lock when the tab hid; re-acquire on return.
      if (document.visibilityState === 'visible' && generationRef.current === generation) {
        acquire();
      }
    };

    acquire();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      generationRef.current += 1; // invalidate any in-flight request
      document.removeEventListener('visibilitychange', onVisibility);
      lockRef.current?.release?.().catch(() => {});
      lockRef.current = null;
    };
  }, [active]);
}
