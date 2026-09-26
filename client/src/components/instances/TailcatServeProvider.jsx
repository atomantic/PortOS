import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { getTailcatServe } from '../../services/api';
import { useSocketResource } from '../../hooks/useSocketResource';
import useMounted from '../../hooks/useMounted';
import toast from '../ui/Toast';

const ServeContext = createContext(null);
const SERVE_EVENTS = ['tailcat:serve:changed'];

// One owner for both controls. Status reads cannot overwrite a newer mutation receipt.
export function TailcatServeProvider({ children }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const mounted = useMounted();
  // Keep the mutation fence independently of socket read coalescing.
  const operation = useRef({ busy: false, generation: 0, dirty: false });
  const load = useCallback(async ({ signal }) => {
    if (operation.current.busy) {
      operation.current.dirty = true;
      return;
    }
    const generation = operation.current.generation;
    const data = await getTailcatServe({ silent: true, signal });
    if (!signal.aborted && !operation.current.busy && generation === operation.current.generation) setStatus(data);
  }, []);
  const { refetch } = useSocketResource(load, { events: SERVE_EVENTS });

  const run = async (fn, successMessage) => {
    if (operation.current.busy) return null;
    operation.current.busy = true;
    operation.current.generation += 1;
    setBusy(true);
    // API wrappers own failure toasts. A failed action keeps the last receipt.
    const result = await Promise.resolve().then(fn).catch(() => null);
    if (result && mounted.current) setStatus(result);
    operation.current.busy = false;
    if (!mounted.current) return result;
    setBusy(false);
    // A change during a mutation (including its failure) must not be lost.
    if (operation.current.dirty) {
      operation.current.dirty = false;
      void refetch();
    }
    if (result && successMessage) toast.success(successMessage);
    return result;
  };

  return <ServeContext.Provider value={{ status, busy, run }}>{children}</ServeContext.Provider>;
}

export const useTailcatServe = () => useContext(ServeContext);
