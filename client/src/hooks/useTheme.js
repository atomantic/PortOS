import { useState, useCallback, useEffect, useRef } from 'react';
import {
  THEMES,
  THEME_LIST,
  getTheme,
  getPairedThemeId,
  normalizeThemeId,
} from '../themes/portosThemes';
import {
  STORAGE_KEY as CITY_SETTINGS_KEY,
  TIME_OF_DAY_AUTO_EVENT as CITY_TIME_OF_DAY_AUTO_EVENT,
} from './useCitySettings';
import { safeReadStorage, safeWriteStorage } from '../lib/safeStorage.js';

const STORAGE_KEY = 'portos-theme';

const applyTheme = (id) => {
  const theme = getTheme(id);
  const style = document.documentElement.style;
  const vars = { ...theme.colors, ...theme.tokens };
  for (const [prop, value] of Object.entries(vars)) {
    style.setProperty(prop, value);
  }
  document.documentElement.dataset.portTheme = theme.id;
  document.documentElement.dataset.portThemeFamily = theme.family;
  document.documentElement.dataset.portThemeDensity = theme.density;
  document.documentElement.dataset.portThemeMode = theme.mode;
  document.documentElement.style.colorScheme = theme.colorScheme ?? 'dark';
  return theme.id;
};

const loadTheme = () => {
  const saved = safeReadStorage(STORAGE_KEY);
  const normalized = normalizeThemeId(saved);
  if (saved && saved !== normalized) safeWriteStorage(STORAGE_KEY, normalized);
  return normalized;
};

const resetCityTimeOfDayOverride = () => {
  const raw = safeReadStorage(CITY_SETTINGS_KEY);
  let citySettings = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') citySettings = parsed;
    } catch {
      // Corrupt city settings — start from an empty object rather than bail.
    }
  }
  safeWriteStorage(CITY_SETTINGS_KEY, JSON.stringify({ ...citySettings, timeOfDay: 'auto' }));
  window.dispatchEvent(new Event(CITY_TIME_OF_DAY_AUTO_EVENT));
};

export default function useTheme() {
  const [themeId, setThemeId] = useState(() => {
    const id = loadTheme();
    applyTheme(id);
    return id;
  });
  const userPickedRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/settings', { signal: controller.signal })
      .then(r => r.ok ? r.json() : null)
      .then(settings => {
        if (userPickedRef.current) return;
        const serverTheme = settings?.theme ? normalizeThemeId(settings.theme) : null;
        const currentSaved = normalizeThemeId(safeReadStorage(STORAGE_KEY));
        if (serverTheme && serverTheme !== currentSaved) {
          // Apply the in-memory theme first so a failing persistence/side-effect
          // path can't leave the UI on the stale theme.
          applyTheme(serverTheme);
          setThemeId(serverTheme);
          safeWriteStorage(STORAGE_KEY, serverTheme);
          resetCityTimeOfDayOverride();
        }
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        console.warn(`⚠️ Theme fetch failed, using localStorage fallback: ${err.message}`);
      });
    return () => controller.abort();
  }, []);

  const setTheme = useCallback((id) => {
    userPickedRef.current = true;
    const normalized = normalizeThemeId(id);
    // Apply the in-memory theme (DOM + state) first so persistence or side-effect
    // failures never leave switching non-functional (issue #2387).
    applyTheme(normalized);
    setThemeId(normalized);
    safeWriteStorage(STORAGE_KEY, normalized);
    resetCityTimeOfDayOverride();
    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: normalized }),
    }).catch(() => console.warn('Theme sync to server failed'));
  }, []);

  const toggleMode = useCallback(() => {
    const paired = getPairedThemeId(themeId);
    if (paired === themeId) return;
    setTheme(paired);
  }, [themeId, setTheme]);

  return { themeId, theme: THEMES[themeId], themeList: THEME_LIST, setTheme, toggleMode };
}
