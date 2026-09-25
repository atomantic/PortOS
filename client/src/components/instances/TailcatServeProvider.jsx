import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { getTailcatServe } from '../../services/api';
import { useAutoRefetch } from '../../hooks/useAutoRefetch';
import toast from '../ui/Toast';

const ServeContext = createContext(null);

// One owner for both controls. Polls cannot overwrite a newer mutation receipt.
export function TailcatServeProvider({ children }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  // useAutoRefetch is single-flight, so polls never overlap each other; the
  // generation only has to fence a poll against a mutation that started while
  // it was pending.
  const operation = useRef({ busy: false, generation: 0 });
  const load = useCallback(async () => {
    if (operation.current.busy) return;
    const generation = operation.current.generation;
    const data = await getTailcatServe({ silent: true });
    if (!operation.current.busy && generation === operation.current.generation) setStatus(data);
  }, []);
  useAutoRefetch(load, 10_000, { pollOnly: true });

  const run = async (fn, successMessage) => {
    if (operation.current.busy) return null;
    operation.current.busy = true;
    operation.current.generation += 1;
    setBusy(true);
    // API wrappers own failure toasts. A failed action keeps the last receipt.
    const result = await Promise.resolve().then(fn).catch(() => null);
    if (result) setStatus(result);
    operation.current.busy = false;
    setBusy(false);
    if (result && successMessage) toast.success(successMessage);
    return result;
  };

  return <ServeContext.Provider value={{ status, busy, run }}>{children}</ServeContext.Provider>;
}

export const useTailcatServe = () => useContext(ServeContext);
