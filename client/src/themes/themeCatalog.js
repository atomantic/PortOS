// Lightweight theme metadata catalog and lazy full-palette loader.
//
// Keeps the ~35 KB CSS-variable palette tables in `portosThemes.js` out of the
// cold-load bundle until a non-default uncached theme or ThemeSwitcher needs them.

export const DEFAULT_THEME_ID = 'kestrel-neon';

// Full-screen effects a theme composes by listing them in `effects`; each is
// a shared block in index.css ("Theme effects layer") tuned by --port-fx-*
// tokens declared in portosThemes.js.
export const THEME_EFFECTS = Object.freeze(['scanlines', 'vignette', 'sweep', 'grid-floor', 'glitch', 'aurora', 'grain']);

export const THEME_METADATA = {
  'classic-midnight': {
    id: 'classic-midnight',
    label: 'Classic Midnight',
    shortLabel: 'Classic',
    family: 'classic',
    mode: 'night',
    accent: '#2563eb',
    colorScheme: 'dark',
    density: 'comfortable',
    swatches: ['#0f0f0f', '#1e1e1e', '#2563eb', '#22c55e'],
  },
  'classic-noon': {
    id: 'classic-noon',
    label: 'Classic Noon',
    shortLabel: 'Classic',
    family: 'classic',
    mode: 'day',
    accent: '#2563eb',
    colorScheme: 'light',
    density: 'comfortable',
    swatches: ['#f0f0f0', '#ffffff', '#2563eb', '#166534'],
  },
  'lumen-glass': {
    id: 'lumen-glass',
    label: 'Lumen Glass',
    shortLabel: 'Glass',
    family: 'glass',
    mode: 'night',
    accent: '#67e8f9',
    colorScheme: 'dark',
    density: 'spacious',
    effects: ['aurora', 'vignette'],
    swatches: ['#071016', '#1c2e37', '#67e8f9', '#fb7185'],
  },
  'lumen-glass-day': {
    id: 'lumen-glass-day',
    label: 'Lumen Glass Day',
    shortLabel: 'Glass',
    family: 'glass',
    mode: 'day',
    accent: '#155e75',
    colorScheme: 'light',
    density: 'spacious',
    effects: ['grain'],
    swatches: ['#eae4db', '#ffffff', '#155e75', '#fb7185'],
  },
  'black-ice-terminal': {
    id: 'black-ice-terminal',
    label: 'Black ICE Terminal',
    shortLabel: 'Terminal',
    family: 'terminal',
    mode: 'night',
    accent: '#00f5a0',
    colorScheme: 'dark',
    density: 'compact',
    effects: ['scanlines', 'vignette', 'sweep', 'glitch'],
    swatches: ['#020403', '#151c19', '#00f5a0', '#ff2bd6'],
  },
  'black-ice-terminal-day': {
    id: 'black-ice-terminal-day',
    label: 'Phosphor Paper',
    shortLabel: 'Terminal',
    family: 'terminal',
    mode: 'day',
    accent: '#086c43',
    colorScheme: 'light',
    density: 'compact',
    effects: ['scanlines', 'vignette', 'grain'],
    swatches: ['#ece6d5', '#fbf6e8', '#086c43', '#b91d6a'],
  },
  'blueprint-ops': {
    id: 'blueprint-ops',
    label: 'Blueprint Ops',
    shortLabel: 'Blueprint',
    family: 'blueprint',
    mode: 'night',
    accent: '#60a5fa',
    colorScheme: 'dark',
    density: 'compact',
    effects: ['vignette'],
    swatches: ['#0b1020', '#1b2231', '#60a5fa', '#f59e0b'],
  },
  'blueprint-ops-day': {
    id: 'blueprint-ops-day',
    label: 'Drafting Paper',
    shortLabel: 'Blueprint',
    family: 'blueprint',
    mode: 'day',
    accent: '#1d4ed8',
    colorScheme: 'light',
    density: 'compact',
    effects: ['grain'],
    swatches: ['#eaeef2', '#ffffff', '#1d4ed8', '#d97706'],
  },
  'kestrel-neon': {
    id: 'kestrel-neon',
    label: 'Kestrel Neon',
    shortLabel: 'Kestrel',
    family: 'kestrel',
    mode: 'night',
    accent: '#00f0ff',
    colorScheme: 'dark',
    density: 'compact',
    effects: ['scanlines', 'vignette', 'sweep', 'grid-floor', 'glitch'],
    swatches: ['#05060a', '#161a32', '#00f0ff', '#ff2bd6'],
  },
  'kestrel-neon-day': {
    id: 'kestrel-neon-day',
    label: 'Kestrel Dawn',
    shortLabel: 'Kestrel',
    family: 'kestrel',
    mode: 'day',
    accent: '#0e7c8c',
    colorScheme: 'light',
    density: 'compact',
    effects: ['scanlines', 'grid-floor'],
    swatches: ['#eaecf6', '#ffffff', '#0e7c8c', '#b5178f'],
  },
};

export const THEME_IDS = Object.keys(THEME_METADATA);
export const THEME_LIST = THEME_IDS.map((id) => THEME_METADATA[id]);

// Fallback color for user-pickable swatches (agent avatars, calendar sources).
// A native <input type="color"> only accepts a literal `#rrggbb` and cannot read
// a CSS custom property, so this mirrors the default theme's accent instead of
// `rgb(var(--port-accent))`. Single definition — every swatch site imports it.
export const DEFAULT_AVATAR_COLOR = THEME_METADATA[DEFAULT_THEME_ID].accent;

export const LEGACY_THEME_ALIASES = {
  midnight: 'classic-midnight',
  phosphor: 'black-ice-terminal',
  ember: 'blueprint-ops',
  arctic: 'lumen-glass',
  synthwave: 'black-ice-terminal',
  'pastel-dawn': 'lumen-glass-day',
  'pastel-paper': 'classic-noon',
  'pastel-void': 'classic-midnight',
  'pastel-submarine': 'lumen-glass',
};

export function normalizeThemeId(id) {
  if (!id || typeof id !== 'string') return DEFAULT_THEME_ID;
  if (THEME_METADATA[id]) return id;
  return LEGACY_THEME_ALIASES[id] ?? DEFAULT_THEME_ID;
}

export function getThemeMeta(id) {
  return THEME_METADATA[normalizeThemeId(id)];
}

export function getPairedThemeId(id) {
  const theme = getThemeMeta(id);
  const opposite = theme.mode === 'day' ? 'night' : 'day';
  return THEME_LIST.find((t) => t.family === theme.family && t.mode === opposite)?.id ?? theme.id;
}

let fullThemesPromise = null;
export function loadFullThemes() {
  fullThemesPromise ??= import('./portosThemes.js');
  return fullThemesPromise;
}
