import { useEffect, useState, useCallback } from 'react';

// Exported so useTheme can reset the city's time-of-day override without
// re-declaring these magic strings (a typo there would silently break the reset).
export const STORAGE_KEY = 'portos-city-settings';
export const TIME_OF_DAY_AUTO_EVENT = 'portos-city-timeofday-auto';

const QUALITY_PRESETS = {
  low: {
    bloomEnabled: false, bloomStrength: 0,
    reflectionsEnabled: false, chromaticAberration: false,
    filmGrain: false, colorGrading: false,
    particleDensity: 0.5, scanlineOverlay: false,
    ambientBrightness: 1.0,
    neonBrightness: 1.0,
    sceneExposure: 1.0,
    dpr: [1, 1],
  },
  medium: {
    bloomEnabled: true, bloomStrength: 0.3,
    reflectionsEnabled: true, chromaticAberration: false,
    filmGrain: false, colorGrading: true,
    particleDensity: 0.75, scanlineOverlay: true,
    ambientBrightness: 1.0,
    neonBrightness: 1.0,
    sceneExposure: 1.0,
    dpr: [1, 1.25],
  },
  high: {
    bloomEnabled: true, bloomStrength: 0.5,
    reflectionsEnabled: true, chromaticAberration: true,
    filmGrain: true, colorGrading: true,
    particleDensity: 1.0, scanlineOverlay: true,
    ambientBrightness: 1.2,
    neonBrightness: 1.2,
    sceneExposure: 1.0,
    dpr: [1, 1.5],
  },
  ultra: {
    bloomEnabled: true, bloomStrength: 0.7,
    reflectionsEnabled: true, chromaticAberration: true,
    filmGrain: true, colorGrading: true,
    particleDensity: 1.5, scanlineOverlay: true,
    ambientBrightness: 1.5,
    neonBrightness: 1.5,
    sceneExposure: 1.2,
    dpr: [1, 2],
  },
};

const DEFAULT_SETTINGS = {
  musicEnabled: false,
  musicVolume: 0.3,
  sfxEnabled: true,
  sfxVolume: 0.5,
  qualityPreset: 'high',
  skyTheme: 'cyberpunk',
  timeOfDay: 'auto', // 'auto' follows the active theme's day/night mode; 'day'/'night' force it
  explorationMode: false,
  ...QUALITY_PRESETS.high,
};

const loadSettings = () => {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return DEFAULT_SETTINGS;
  return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
};

export { QUALITY_PRESETS };

export default function useCitySettings() {
  const [settings, setSettings] = useState(loadSettings);

  useEffect(() => {
    const handleTimeOfDayAuto = () => {
      setSettings(prev => {
        if (prev.timeOfDay === 'auto') return prev;
        const next = { ...prev, timeOfDay: 'auto' };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        return next;
      });
    };
    window.addEventListener(TIME_OF_DAY_AUTO_EVENT, handleTimeOfDayAuto);
    return () => window.removeEventListener(TIME_OF_DAY_AUTO_EVENT, handleTimeOfDayAuto);
  }, []);

  const updateSetting = useCallback((key, value) => {
    setSettings(prev => {
      // If changing quality preset, apply bulk changes
      if (key === 'qualityPreset' && QUALITY_PRESETS[value]) {
        const next = { ...prev, qualityPreset: value, ...QUALITY_PRESETS[value] };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        return next;
      }
      const next = { ...prev, [key]: value };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const resetSettings = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setSettings(DEFAULT_SETTINGS);
  }, []);

  return [settings, updateSetting, resetSettings];
}
