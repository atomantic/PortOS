import { useCallback, useState } from 'react';

/**
 * Arm a deliberate "do it anyway" override after N consecutive failures against
 * the SAME target.
 *
 * Built for the iCloud force-save escape hatch (#3717): an Obsidian note whose
 * bytes look offloaded is refused rather than written, because overwriting a
 * dataless file blocks the process. That screen can false-positive on a
 * genuinely-local file, and when it does the refusal is permanent — so the user
 * needs a way through. The override must never be the *default* retry path
 * (it re-admits exactly the blocking write the guard exists to prevent), so it
 * stays hidden until the same target has failed twice in a row and then requires
 * its own explicit click.
 *
 * Keyed by target, so switching to a different note disarms automatically and a
 * one-off failure elsewhere can't arm the note you're looking at.
 *
 * Returns:
 *   isArmed(key)      — true once `key` has failed `threshold` times in a row
 *   recordFailure(key)— count one failure for `key` (resets the count on a switch)
 *   reset()           — disarm (wire to a successful save and to the row's cancel)
 *
 * @param {number} [threshold=2] - consecutive failures before the override shows.
 */
export function useForceSaveGate(threshold = 2) {
  const [failure, setFailure] = useState({ key: null, count: 0 });

  const recordFailure = useCallback((key) => {
    setFailure(prev => (prev.key === key ? { key, count: prev.count + 1 } : { key, count: 1 }));
  }, []);

  // Returning the same object when already clear keeps the common case — every
  // successful save calls this — from re-rendering the editor for nothing.
  const reset = useCallback(
    () => setFailure(prev => (prev.key === null ? prev : { key: null, count: 0 })),
    [],
  );

  const isArmed = useCallback(
    (key) => Boolean(key) && failure.key === key && failure.count >= threshold,
    [failure, threshold],
  );

  return { isArmed, recordFailure, reset };
}

export default useForceSaveGate;
