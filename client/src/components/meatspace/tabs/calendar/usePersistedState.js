import { useCallback, useState } from 'react';
import { safeReadJsonStorage, safeWriteStorage } from '../../../../lib/safeStorage';

const STORAGE_KEY = 'portos:life-calendar';

function loadGridPrefs() {
  return safeReadJsonStorage(STORAGE_KEY, {});
}

function saveGridPrefs(prefs) {
  safeWriteStorage(STORAGE_KEY, JSON.stringify(prefs));
}

// Per-key state persisted into a single localStorage blob shared by the Life Calendar.
export function usePersistedState(key, defaultValue) {
  const [value, setValue] = useState(() => {
    const prefs = loadGridPrefs();
    return prefs[key] ?? defaultValue;
  });
  const set = useCallback((v) => {
    setValue(v);
    const prefs = loadGridPrefs();
    prefs[key] = v;
    saveGridPrefs(prefs);
  }, [key]);
  return [value, set];
}
