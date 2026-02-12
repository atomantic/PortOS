import { createContext, useContext } from 'react';
import useCitySettings from '../../hooks/useCitySettings';

const CitySettingsContext = createContext(null);

export function CitySettingsProvider({ children }) {
  const [settings, updateSetting, resetSettings] = useCitySettings();

  return (
    <CitySettingsContext.Provider value={{ settings, updateSetting, resetSettings }}>
      {children}
    </CitySettingsContext.Provider>
  );
}

export function useCitySettingsContext() {
  const ctx = useContext(CitySettingsContext);
  if (!ctx) return { settings: null, updateSetting: () => {}, resetSettings: () => {} };
  return ctx;
}
