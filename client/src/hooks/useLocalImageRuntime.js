import { useCallback, useEffect, useState } from 'react';
import { getImageGenStatus } from '../services/api';

/**
 * The local image runtime's verdict for one model — `readiness`, the `reason`,
 * and the one-button `remedy` that fixes it — from the SAME server diagnosis the
 * renderer refuses against (`server/services/imageGen/localRuntime.js`).
 *
 * A hook rather than state fused into the status card, because a host usually
 * needs the VALUE as well as the display: a deck has to disable "Render all"
 * when the runtime is dead, which is the reported complaint one step earlier
 * than the error message.
 *
 * `modelId` may be null while the host is still resolving which model it renders
 * on; the probe waits rather than asking about the install default and then
 * re-asking. Silent — the card owns its own failure display.
 */
export default function useLocalImageRuntime(modelId) {
  const [runtime, setRuntime] = useState(null);
  const [loading, setLoading] = useState(!!modelId);
  // Manual refreshes (the card's button, an install completing) must re-run
  // without changing `modelId`, and must abort with it.
  const [attempt, setAttempt] = useState(0);
  const refresh = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!modelId) { setRuntime(null); setLoading(false); return undefined; }
    const controller = new AbortController();
    setLoading(true);
    getImageGenStatus('local', modelId, { silent: true, signal: controller.signal })
      .then((s) => { if (!controller.signal.aborted && s) setRuntime(s); })
      .catch(() => {})
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [modelId, attempt]);

  return { runtime, loading, refresh };
}
