import { useState, useCallback } from 'react';

const STORAGE_KEY = 'portos-city-settings';

const QUALITY_PRESETS = {
  low: {
    bloomEnabled: false, bloomStrength: 0,
    reflectionsEnabled: false, chromaticAberration: false,
    filmGrain: false, colorGrading: false,
    particleDensity: 0.5, scanlineOverlay: false,
    ambientBrightness: 1.0,
    neonBrightness: 1.0,
    dpr: [1, 1],
  },
  medium: {
    bloomEnabled: true, bloomStrength: 0.3,
    reflectionsEnabled: true, chromaticAberration: false,
    filmGrain: false, colorGrading: true,
    particleDensity: 0.75, scanlineOverlay: true,
    ambientBrightness: 1.0,
    neonBrightness: 1.0,
    dpr: [1, 1.25],
  },
  high: {
    bloomEnabled: true, bloomStrength: 0.5,
    reflectionsEnabled: true, chromaticAberration: true,
    filmGrain: true, colorGrading: true,
    particleDensity: 1.0, scanlineOverlay: true,
    ambientBrightness: 1.2,
    neonBrightness: 1.2,
    dpr: [1, 1.5],
  },
  ultra: {
    bloomEnabled: true, bloomStrength: 0.7,
    reflectionsEnabled: true, chromaticAberration: true,
    filmGrain: true, colorGrading: true,
    particleDensity: 1.5, scanlineOverlay: true,
    ambientBrightness: 1.5,
    neonBrightness: 1.5,
    dpr: [1, 2],
  },
};

const DEFAULT_SETTINGS = {
  musicEnabled: false,
  musicVolume: 0.3,
  sfxEnabled: true,
  sfxVolume: 0.5,
  qualityPreset: 'high',
  timeOfDay: 'sunset',
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
