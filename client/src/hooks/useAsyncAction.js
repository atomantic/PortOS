/**
 * `running` state + toast-on-error.
 *
 * Use when: Buttons that await an async action.
 */

import { useState } from 'react';
import toast from '../components/ui/Toast';

/**
 * Wraps an async action with `running` state and toast-on-error.
 *
 * Usage:
 *   const [run, running] = useAsyncAction(async (id) => someApi(id), { errorMessage: 'Failed to do thing' });
 *   <button disabled={running} onClick={() => run(thing.id)}>Go</button>
 *
 * `run` resolves to the fn's return value, or `null` (after a toast) if it throws. Only a single boolean in-flight flag: keyed loading states need a different abstraction.
 * The trailing `setRunning(false)` is deliberately UNGUARDED: React 19 makes a post-unmount setState a silent no-op, and a mounted-ref guard here froze every button backed by this hook under StrictMode (#3264). Don't re-add one.
 */
export function useAsyncAction(fn, { errorMessage } = {}) {
  const [running, setRunning] = useState(false);
  const run = async (...args) => {
    setRunning(true);
    const result = await fn(...args).catch((err) => {
      toast.error(err?.message || errorMessage || 'Action failed');
      return null;
    });
    setRunning(false);
    return result;
  };
  return [run, running];
}

export default useAsyncAction;
