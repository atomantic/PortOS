import { useCallback, useRef, useState } from 'react';

/**
 * Rejected Brain captures that the user can still recover.
 *
 * A capture box clears its composer the moment a submit starts so the user can
 * keep typing; when the server then rejects it, the submitted work would be
 * gone. Each failure is kept here as an immutable `payload` (the exact request
 * the surface built, including its settings) plus the human-readable `error`,
 * separate from whatever the composer holds now. Nothing in here ever re-sends:
 * the host's Retry action does that, once, on explicit activation.
 *
 * @returns {{
 *   failures: Array<{ id: string, payload: object, error: string, retrying: boolean }>,
 *   fail: (payload: object, error: string, id?: string) => string,
 *   markRetrying: (id: string) => boolean,
 *   discard: (id: string) => void,
 * }} `fail` adds a row (or, given the `id` of an existing row, refreshes its
 *   error and clears `retrying`) and returns the row id. `markRetrying` returns
 *   false when that row is already retrying, so a double click sends once.
 */
export function useFailedCaptures() {
  const [failures, setFailures] = useState([]);
  const counter = useRef(0);
  const retryingRef = useRef(new Set());

  const fail = useCallback((payload, error, id) => {
    const rowId = id ?? `failed-capture-${++counter.current}`;
    retryingRef.current.delete(rowId);
    setFailures((prev) => (prev.some((f) => f.id === rowId)
      ? prev.map((f) => (f.id === rowId ? { ...f, error, retrying: false } : f))
      : [{ id: rowId, payload, error, retrying: false }, ...prev]));
    return rowId;
  }, []);

  const markRetrying = useCallback((id) => {
    if (retryingRef.current.has(id)) return false;
    retryingRef.current.add(id);
    setFailures((prev) => prev.map((f) => (f.id === id ? { ...f, retrying: true } : f)));
    return true;
  }, []);

  const discard = useCallback((id) => {
    retryingRef.current.delete(id);
    setFailures((prev) => prev.filter((f) => f.id !== id));
  }, []);

  return { failures, fail, markRetrying, discard };
}

export default useFailedCaptures;
