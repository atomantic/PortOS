import { createContext, useContext } from 'react';
import useTheme from './useTheme';
import { DEFAULT_THEME_ID, THEME_LIST, THEME_METADATA } from '../themes/themeCatalog';

const FALLBACK_CONTEXT = {
  themeId: DEFAULT_THEME_ID,
  theme: THEME_METADATA[DEFAULT_THEME_ID],
  themeList: THEME_LIST,
  setTheme: () => {},
  toggleMode: () => {},
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
