import { useState } from 'react';
import toast from '../components/ui/Toast';

/**
 * Wraps an async action with `running` state and toast-on-error.
 *
 * Usage:
 *   const [run, running] = useAsyncAction(async (id) => {
 *     return await someApi(id);
 *   }, { errorMessage: 'Failed to do thing' });
 *   // ...
 *   <button disabled={running} onClick={() => run(thing.id)}>Go</button>
 *
 * The fn return value is what `run` resolves to. If the fn throws, the
 * error is toasted and `run` resolves to `null`. The hook only models a
 * single boolean in-flight flag — keyed/indexed loading states (e.g. "which
 * row is saving") need a different abstraction.
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
