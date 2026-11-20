/**
 * The local image runtime's verdict for one model — `{ runtime, loading, refresh }` — from `GET
 * /api/image-gen/status?mode=local&modelId=…`, the same `diagnoseLocalRuntime` the renderer refuses
 * against.
 *
 * `runtime` carries `readiness`, `reason` and a one-button `remedy`. Pass `null` while the host is
 * still resolving which model it renders on. Use when: Any surface whose renders can be blocked by an
 * unhealthy local runtime: pair it with `LocalRuntimeStatus` to show the verdict and its fix, and read
 * `readiness` to stand the surface's own Render button down.
 */

import { useCallback, useEffect, useState } from 'react';
import { getImageGenStatus } from '../services/apiSystem.js';

/**
 * The local image runtime's verdict for one model (`readiness`, `reason`, one-button `remedy`) from the SAME server diagnosis the renderer refuses against (`server/services/imageGen/localRuntime.js`). A hook rather than state fused into the status card because a host needs the VALUE too: a deck must disable "Render all" when the runtime is dead, one step earlier than the error message.
 * `modelId` may be null while the host resolves which model it renders on; the probe waits rather than ask about the install default and re-ask. Silent: the card owns its own failure display.
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
