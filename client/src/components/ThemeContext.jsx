import { createContext, useContext } from 'react';
import useTheme from '../hooks/useTheme';
import { DEFAULT_THEME_ID, THEMES, THEME_LIST } from '../themes/portosThemes';

const FALLBACK_CONTEXT = {
  themeId: DEFAULT_THEME_ID,
  theme: THEMES[DEFAULT_THEME_ID],
  themeList: THEME_LIST,
  setTheme: () => {},
};

const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const value = useTheme();

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useThemeContext() {
  return useContext(ThemeContext) ?? FALLBACK_CONTEXT;
}
