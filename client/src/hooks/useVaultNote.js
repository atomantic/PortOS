import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../services/api';

/** Read the note named by the URL, discarding responses from older selections. */
export default function useVaultNote(vaultId, notePath, { onReset, onLoad } = {}) {
  const [loadedNote, setLoadedNote] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const sequenceRef = useRef(0);
  const callbacks = useRef({ onReset, onLoad });
  callbacks.current = { onReset, onLoad };

  const clear = useCallback(() => {
    sequenceRef.current += 1;
    setLoadedNote(null);
    setLoading(false);
    setError(false);
    callbacks.current.onReset?.();
  }, []);

  const retry = useCallback(() => setAttempt(value => value + 1), []);

  useEffect(() => {
    const sequence = ++sequenceRef.current;
    setLoadedNote(null);
    setError(false);
    setLoading(Boolean(vaultId && notePath));
    callbacks.current.onReset?.();
    if (vaultId && notePath) {
      api.getNote(vaultId, notePath, { silent: true }).then(data => {
        if (sequence !== sequenceRef.current) return;
        if (data && !data.error && data.path === notePath) {
          setLoadedNote(data);
          callbacks.current.onLoad?.(data);
        } else setError(true);
        setLoading(false);
      }).catch(() => {
        if (sequence !== sequenceRef.current) return;
        setError(true);
        setLoading(false);
      });
    }
    return () => { ++sequenceRef.current; };
  }, [vaultId, notePath, attempt]);

  const note = loadedNote?.path === notePath ? loadedNote : null;
  return { note, setNote: setLoadedNote, loading, error, retry, clear, sequenceRef };
}
