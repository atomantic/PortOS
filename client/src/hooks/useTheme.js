import { useState, useCallback, useEffect, useRef } from 'react';
import {
  THEMES,
  THEME_LIST,
  getTheme,
  normalizeThemeId,
} from '../themes/portosThemes';

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
  document.documentElement.style.colorScheme = theme.colorScheme ?? 'dark';
  return theme.id;
};

const loadTheme = () => {
  const saved = localStorage.getItem(STORAGE_KEY);
  const normalized = normalizeThemeId(saved);
  if (saved && saved !== normalized) localStorage.setItem(STORAGE_KEY, normalized);
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
    fetch('/api/settings')
      .then(r => r.ok ? r.json() : null)
      .then(settings => {
        if (userPickedRef.current) return;
        const serverTheme = settings?.theme ? normalizeThemeId(settings.theme) : null;
        const currentSaved = normalizeThemeId(localStorage.getItem(STORAGE_KEY));
        if (serverTheme && serverTheme !== currentSaved) {
          localStorage.setItem(STORAGE_KEY, serverTheme);
          applyTheme(serverTheme);
          setThemeId(serverTheme);
        }
      })
      .catch(() => console.log('Theme fetch failed, using localStorage fallback'));
  }, []);

  const setTheme = useCallback((id) => {
    userPickedRef.current = true;
    const normalized = normalizeThemeId(id);
    localStorage.setItem(STORAGE_KEY, normalized);
    applyTheme(normalized);
    setThemeId(normalized);
    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: normalized }),
    }).catch(() => console.warn('Theme sync to server failed'));
  }, []);

  return { themeId, theme: THEMES[themeId], themeList: THEME_LIST, setTheme };
}
