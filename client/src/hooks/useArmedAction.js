import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Two-click-arm confirmation hook. Returns `[armed, fire]`:
 *   - first call to `fire(...args)` flips `armed` to `true` and schedules a
 *     disarm after `timeoutMs`.
 *   - second call to `fire(...args)` within the timeout runs `onConfirm(...args)`
 *     and resets.
 *
 * Use for "wandering click could clobber a record" confirmations where a
 * modal is overkill (delete buttons, regenerate-arc, replace-storyboards).
 */
export function useArmedAction(onConfirm, { timeoutMs = 5000 } = {}) {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const fire = useCallback((...args) => {
    if (!armed) {
      setArmed(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setArmed(false), timeoutMs);
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setArmed(false);
    onConfirm(...args);
  }, [armed, timeoutMs, onConfirm]);

  return [armed, fire];
}
