/**
 * Dark/light theme + paired-theme switching.
 *
 * Cold boot applies cached theme variables synchronously (or relies on default
 * CSS in index.css) and defers importing full palette tables in portosThemes.js
 * until an uncached non-default theme or a theme change needs them.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  DEFAULT_THEME_ID,
  THEME_LIST,
  THEME_METADATA,
  getPairedThemeId,
  getThemeMeta,
  loadFullThemes,
  normalizeThemeId,
} from '../themes/themeCatalog';
import {
  safeReadJsonStorage,
  safeReadStorage,
  safeWriteJsonStorage,
  safeWriteStorage,
} from '../lib/safeStorage.js';
import { readShellBootstrap } from '../services/shellBootstrap.js';
import { getSettings, updateSettings } from '../services/apiSystem.js';

const STORAGE_KEY = 'portos-theme';
const CACHE_KEY = 'portos-theme-cache';
const CACHE_VERSION = typeof __BUILD_STAMP__ !== 'undefined' && __BUILD_STAMP__?.builtAt
  ? __BUILD_STAMP__.builtAt
  : null;

let cachedThemesModule = null;

const applyAttributes = (meta) => {
  const root = document.documentElement;
  root.dataset.portTheme = meta.id;
  root.dataset.portThemeFamily = meta.family;
  root.dataset.portThemeDensity = meta.density;
  root.dataset.portThemeMode = meta.mode;
  // Space-separated so index.css can key on html[data-port-theme-effects~="x"].
  if (meta.effects?.length) root.dataset.portThemeEffects = meta.effects.join(' ');
  else delete root.dataset.portThemeEffects;
  root.style.colorScheme = meta.colorScheme ?? 'dark';
};

const applyVars = (vars) => {
  const style = document.documentElement.style;
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
};

const clearThemeInlineVars = () => {
  const style = document.documentElement.style;
  for (const prop of Array.from(style)) {
    if (prop.startsWith('--port-')) style.removeProperty(prop);
  }
};

const readThemeCache = (id) => {
  const cached = safeReadJsonStorage(CACHE_KEY, null);
  if (
    !cached
    || typeof cached !== 'object'
    || cached.id !== id
    || !cached.vars
    || typeof cached.vars !== 'object'
    || Array.isArray(cached.vars)
  ) {
    return null;
  }
  return { vars: cached.vars, fresh: cached.version === CACHE_VERSION };
};

const writeThemeCache = (theme) => {
  const vars = { ...theme.colors, ...theme.tokens };
  safeWriteJsonStorage(CACHE_KEY, { id: theme.id, version: CACHE_VERSION, vars });
};

const applyThemeObject = (theme) => {
  applyVars({ ...theme.colors, ...theme.tokens });
  applyAttributes(theme);
  writeThemeCache(theme);
  return theme.id;
};

const applyCachedOrLoadTheme = (id, { skipDefaultLoad = false, shouldApply }) => {
  if (cachedThemesModule) {
    applyThemeObject(cachedThemesModule.getTheme(id));
    return;
  }
  const cached = readThemeCache(id);
  const meta = getThemeMeta(id);
  if (cached) {
    applyVars(cached.vars);
    applyAttributes(meta);
    if (cached.fresh) return;
  } else {
    if (id === DEFAULT_THEME_ID) clearThemeInlineVars();
    applyAttributes(meta);
    if (skipDefaultLoad && id === DEFAULT_THEME_ID) return;
  }
  void loadFullThemes().then((mod) => {
    cachedThemesModule = mod;
    if (!shouldApply()) return;
    applyThemeObject(mod.getTheme(id));
  }).catch(() => {});
};

const loadStoredThemeId = () => {
  const saved = safeReadStorage(STORAGE_KEY);
  const normalized = normalizeThemeId(saved);
  if (saved && saved !== normalized) safeWriteStorage(STORAGE_KEY, normalized);
  return normalized;
};

export default function useTheme() {
  const initialCacheFreshRef = useRef(true);
  const [themeId, setThemeId] = useState(() => {
    const id = loadStoredThemeId();
    const meta = getThemeMeta(id);
    const cached = readThemeCache(id);
    if (cached) {
      applyVars(cached.vars);
      applyAttributes(meta);
      initialCacheFreshRef.current = cached.fresh;
    } else {
      if (id === DEFAULT_THEME_ID) clearThemeInlineVars();
      applyAttributes(meta);
      initialCacheFreshRef.current = id === DEFAULT_THEME_ID;
    }
    return id;
  });
  const initialThemeIdRef = useRef(themeId);
  const userPickedRef = useRef(false);
  const applySeqRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const initialSeq = applySeqRef.current;

    if (!initialCacheFreshRef.current) {
      void loadFullThemes().then((mod) => {
        cachedThemesModule = mod;
        if (cancelled || userPickedRef.current || applySeqRef.current !== initialSeq) return;
        applyThemeObject(mod.getTheme(initialThemeIdRef.current));
      }).catch(() => {});
    }

    readShellBootstrap('settings', () => getSettings({ silent: true }))
      .then((settings) => {
        if (cancelled || userPickedRef.current) return;
        const serverTheme = settings?.theme ? normalizeThemeId(settings.theme) : null;
        const currentSaved = normalizeThemeId(safeReadStorage(STORAGE_KEY));
        if (serverTheme && serverTheme !== currentSaved) {
          const targetSeq = ++applySeqRef.current;
          safeWriteStorage(STORAGE_KEY, serverTheme);
          setThemeId(serverTheme);
          applyCachedOrLoadTheme(serverTheme, {
            skipDefaultLoad: true,
            shouldApply: () => !cancelled && !userPickedRef.current && applySeqRef.current === targetSeq,
          });
        }
      })
      .catch((err) => {
        if (cancelled || err.code === 'AUTH_REQUIRED') return;
        console.warn(`⚠️ Theme fetch failed, using localStorage fallback: ${err.message}`);
      });
    return () => { cancelled = true; };
  }, []);

  const setTheme = useCallback((id) => {
    userPickedRef.current = true;
    const targetSeq = ++applySeqRef.current;
    const normalized = normalizeThemeId(id);
    setThemeId(normalized);
    safeWriteStorage(STORAGE_KEY, normalized);

    applyCachedOrLoadTheme(normalized, {
      shouldApply: () => applySeqRef.current === targetSeq,
    });

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

  return { themeId, theme: THEME_METADATA[themeId], themeList: THEME_LIST, setTheme, toggleMode };
}
