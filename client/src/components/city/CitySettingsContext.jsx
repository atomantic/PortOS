import { createContext, useContext, useMemo } from 'react';
import useCitySettings from '../../hooks/useCitySettings';

const CitySettingsContext = createContext(null);

export function CitySettingsProvider({ children }) {
  const [settings, updateSetting, resetSettings, resetNonce] = useCitySettings();

  const value = useMemo(
    () => ({ settings, updateSetting, resetSettings, resetNonce }),
    [settings, updateSetting, resetSettings, resetNonce]
  );

  return (
    <CitySettingsContext.Provider value={value}>
      {children}
    </CitySettingsContext.Provider>
  );
}

export function useCitySettingsContext() {
  const ctx = useContext(CitySettingsContext);
  if (!ctx) return { settings: null, updateSetting: () => {}, resetSettings: () => {}, resetNonce: 0 };
  return ctx;
}
