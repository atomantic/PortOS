/**
 * Shared pending-request and generation guard for microphone permission prompts.
 *
 * Returns `{ tryStart, settleStart, isCurrent, cancel }` and delegates resource teardown plus
 * caller-owned idle reset. Use when: Any capture hook that must reject concurrent `getUserMedia`
 * starts and dispose a stream resolved after cancellation.
 */

import { useCallback, useRef } from 'react';

const noop = () => {};

/**
 * Coordinate a capture start that may remain pending during a permission
 * prompt. The generation token lets callers discard continuations from a
 * cancelled request without releasing a newer request's resources.
 *
 * @param {object} options
 * @param {() => void} options.teardown — release the caller's live resources.
 * @param {() => void} [options.onCancel] — reset caller-owned state after teardown.
 * @returns {{
 *   tryStart: () => number|null,
 *   settleStart: (generation: number) => boolean,
 *   isCurrent: (generation: number) => boolean,
 *   cancel: () => void,
 * }}
 */
export default function useAsyncCaptureGuard({ teardown, onCancel = noop }) {
  const pendingRef = useRef(false);
  const generationRef = useRef(0);

  const isCurrent = useCallback(
    (generation) => generation === generationRef.current,
    [],
  );

  const tryStart = useCallback(() => {
    if (pendingRef.current) return null;
    pendingRef.current = true;
    return ++generationRef.current;
  }, []);

  const settleStart = useCallback((generation) => {
    if (!isCurrent(generation)) return false;
    pendingRef.current = false;
    return true;
  }, [isCurrent]);

  const cancel = useCallback(() => {
    generationRef.current += 1;
    pendingRef.current = false;
    teardown();
    onCancel();
  }, [onCancel, teardown]);

  return { tryStart, settleStart, isCurrent, cancel };
}
