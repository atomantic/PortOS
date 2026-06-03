import { useCallback, useState } from 'react';

const STORAGE_KEY = 'portos:life-calendar';

function loadGridPrefs() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return {};
  return JSON.parse(raw);
}

function saveGridPrefs(prefs) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
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
