import { useState, useCallback, useEffect } from 'react';

const STORAGE_KEY = 'portos-theme';

// RGB channel values (space-separated) for Tailwind opacity modifier compatibility
const THEMES = {
  midnight: {
    label: 'Midnight',
    accent: '#3b82f6',
    colors: {
      '--port-bg': '15 15 15',
      '--port-card': '26 26 26',
      '--port-border': '42 42 42',
      '--port-accent': '59 130 246',
      '--port-success': '34 197 94',
      '--port-warning': '245 158 11',
      '--port-error': '239 68 68',
      '--port-text': '229 229 229',
      '--port-text-muted': '163 163 163',
      '--port-focus-ring': '59 130 246',
    },
  },
  phosphor: {
    label: 'Phosphor',
    accent: '#22c55e',
    colors: {
      '--port-bg': '10 15 10',
      '--port-card': '18 28 18',
      '--port-border': '30 50 30',
      '--port-accent': '34 197 94',
      '--port-success': '74 222 128',
      '--port-warning': '250 204 21',
      '--port-error': '248 113 113',
      '--port-text': '200 230 200',
      '--port-text-muted': '130 170 130',
      '--port-focus-ring': '34 197 94',
    },
  },
  ember: {
    label: 'Ember',
    accent: '#f97316',
    colors: {
      '--port-bg': '18 12 10',
      '--port-card': '30 22 18',
      '--port-border': '55 38 28',
      '--port-accent': '249 115 22',
      '--port-success': '34 197 94',
      '--port-warning': '251 191 36',
      '--port-error': '239 68 68',
      '--port-text': '235 220 210',
      '--port-text-muted': '180 150 130',
      '--port-focus-ring': '249 115 22',
    },
  },
  arctic: {
    label: 'Arctic',
    accent: '#38bdf8',
    colors: {
      '--port-bg': '12 15 20',
      '--port-card': '20 26 35',
      '--port-border': '35 45 60',
      '--port-accent': '56 189 248',
      '--port-success': '34 197 94',
      '--port-warning': '245 158 11',
      '--port-error': '248 113 113',
      '--port-text': '210 225 240',
      '--port-text-muted': '140 160 185',
      '--port-focus-ring': '56 189 248',
    },
  },
  synthwave: {
    label: 'Synthwave',
    accent: '#c084fc',
    colors: {
      '--port-bg': '16 10 20',
      '--port-card': '28 18 35',
      '--port-border': '50 32 60',
      '--port-accent': '192 132 252',
      '--port-success': '74 222 128',
      '--port-warning': '251 191 36',
      '--port-error': '251 113 133',
      '--port-text': '230 215 240',
      '--port-text-muted': '170 140 190',
      '--port-focus-ring': '192 132 252',
    },
  },
};

const applyTheme = (id) => {
  const theme = THEMES[id] ?? THEMES.midnight;
  const style = document.documentElement.style;
  for (const [prop, value] of Object.entries(theme.colors)) {
    style.setProperty(prop, value);
  }
};

const loadTheme = () => {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved && THEMES[saved] ? saved : 'midnight';
};

export { THEMES, applyTheme };

export default function useTheme() {
  const [themeId, setThemeId] = useState(() => {
    const id = loadTheme();
    applyTheme(id);
    return id;
  });

  // On mount, fetch server-side theme and apply if different from localStorage
  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.ok ? r.json() : null)
      .then(settings => {
        const serverTheme = settings?.theme;
        if (serverTheme && THEMES[serverTheme] && serverTheme !== themeId) {
          localStorage.setItem(STORAGE_KEY, serverTheme);
          applyTheme(serverTheme);
          setThemeId(serverTheme);
        }
      })
      .catch(() => {}); // Server unreachable — use localStorage fallback
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setTheme = useCallback((id) => {
    if (!THEMES[id]) return;
    localStorage.setItem(STORAGE_KEY, id);
    applyTheme(id);
    setThemeId(id);
    // Persist to server (fire-and-forget)
    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: id }),
    }).catch(() => {});
  }, []);

  return { themeId, theme: THEMES[themeId], themes: THEMES, setTheme };
}
