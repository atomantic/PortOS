import { useState, useCallback, useEffect, useRef } from 'react';
import {
  THEMES,
  THEME_LIST,
  getTheme,
  getPairedThemeId,
  normalizeThemeId,
} from '../themes/portosThemes';
import { safeReadStorage, safeWriteStorage } from '../lib/safeStorage.js';
import { getSettings, updateSettings } from '../services/apiSystem.js';

const STORAGE_KEY = 'portos-theme';

const applyTheme = (id) => {
  const theme = getTheme(id);
  const style = document.documentElement.style;
  const vars = { ...theme.colors, ...theme.tokens };
  // A theme only declares the tokens it uses (the optional --port-fx-* effect
  // tokens especially), and an inline property on <html> outlives a theme
  // switch — so drop every --port-* the next theme does not declare, or Kestrel
  // Neon's multiply-blend scanlines would still tint Classic Midnight after the
  // user switched away. Read off the DOM rather than remembered, so it also
  // clears what an earlier bundle left behind.
  for (const prop of Array.from(style)) {
    if (prop.startsWith('--port-') && !(prop in vars)) style.removeProperty(prop);
  }
  for (const [prop, value] of Object.entries(vars)) {
    style.setProperty(prop, value);
  }
  const root = document.documentElement;
  root.dataset.portTheme = theme.id;
  root.dataset.portThemeFamily = theme.family;
  root.dataset.portThemeDensity = theme.density;
  root.dataset.portThemeMode = theme.mode;
  // Space-separated so index.css can key on html[data-port-theme-effects~="x"].
  if (theme.effects?.length) root.dataset.portThemeEffects = theme.effects.join(' ');
  else delete root.dataset.portThemeEffects;
  root.style.colorScheme = theme.colorScheme ?? 'dark';
  return theme.id;
};

const loadTheme = () => {
  const saved = safeReadStorage(STORAGE_KEY);
  const normalized = normalizeThemeId(saved);
  if (saved && saved !== normalized) safeWriteStorage(STORAGE_KEY, normalized);
  return normalized;
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
    // Silent — a failed read just falls back to localStorage (handled below),
    // so the request() helper must not toast on top of our own warn.
    getSettings({ silent: true, signal: controller.signal })
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
        }
      })
      .catch((err) => {
        // request() collapses an aborted fetch into a generic error, so check
        // the controller too — an unmount/StrictMode remount isn't a failure.
        // The unauthenticated login screen also mounts ThemeProvider. Its
        // AUTH_REQUIRED response is the expected gate, not a theme failure.
        if (controller.signal.aborted || err.name === 'AbortError' || err.code === 'AUTH_REQUIRED') return;
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
    // Silent — the theme is already applied locally; a failed sync only warrants
    // a console warning, not a toast on every theme switch.
    updateSettings({ theme: normalized }, { silent: true })
      .catch(() => console.warn('⚠️ Theme sync to server failed'));
  }, []);

  const toggleMode = useCallback(() => {
    const paired = getPairedThemeId(themeId);
    if (paired === themeId) return;
    setTheme(paired);
  }, [themeId, setTheme]);

  return { themeId, theme: THEMES[themeId], themeList: THEME_LIST, setTheme, toggleMode };
}
