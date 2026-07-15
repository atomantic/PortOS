import { useEffect, useState, useCallback } from 'react';
import { safeReadStorage, safeWriteStorage, safeRemoveStorage } from '../lib/safeStorage.js';

// Exported so useTheme can reset the city's time-of-day override without
// re-declaring these magic strings (a typo there would silently break the reset).
export const STORAGE_KEY = 'portos-city-settings';
export const TIME_OF_DAY_AUTO_EVENT = 'portos-city-timeofday-auto';

const QUALITY_PRESETS = {
  low: {
    reflectionsEnabled: false,
    particleDensity: 0.5, scanlineOverlay: false,
    ambientBrightness: 1.0,
    neonBrightness: 1.0,
    dpr: [1, 1],
  },
  medium: {
    reflectionsEnabled: true,
    particleDensity: 0.75, scanlineOverlay: true,
    ambientBrightness: 1.0,
    neonBrightness: 1.0,
    dpr: [1, 1.25],
  },
  high: {
    reflectionsEnabled: true,
    particleDensity: 1.0, scanlineOverlay: true,
    ambientBrightness: 1.2,
    neonBrightness: 1.2,
    dpr: [1, 1.25],
  },
  ultra: {
    reflectionsEnabled: true,
    particleDensity: 1.5, scanlineOverlay: true,
    ambientBrightness: 1.5,
    neonBrightness: 1.5,
    dpr: [1, 1.5],
  },
};

const DEFAULT_SETTINGS = {
  musicEnabled: false,
  musicVolume: 0.3,
  sfxEnabled: true,
  sfxVolume: 0.5,
  // Auto quality (issue #2592): new installs adapt at runtime, always beginning at High
  // (see CyberCity's autoStartTier). `qualityPreset` names the *Manual* preset only.
  qualityMode: 'auto', // 'auto' = adaptive render budget; 'manual' = fixed preset
  qualityPreset: 'high',
  timeOfDay: 'auto', // 'auto' follows the active theme's day/night mode; 'day'/'night' force it
  explorationMode: false,
  cameraView: 'third', // exploration camera: 'third' follows the cyber-runner; 'first' is classic FPS (V toggles)
  ...QUALITY_PRESETS.high,
};

const loadSettings = () => {
  const saved = safeReadStorage(STORAGE_KEY);
  if (!saved) return DEFAULT_SETTINGS;
  let parsed;
  try {
    parsed = JSON.parse(saved);
  } catch {
    return DEFAULT_SETTINGS; // Corrupt stored JSON — fall back to defaults.
  }
  if (!parsed || typeof parsed !== 'object') return DEFAULT_SETTINGS;
  const merged = { ...DEFAULT_SETTINGS, ...parsed };
  // Migration: an existing payload predating Auto mode has no `qualityMode` key.
  // Such installs keep their chosen fixed preset — Manual — rather than being
  // silently opted into adaptation. Presence of the key (even 'auto') is honored;
  // this is the "absent vs. present" distinction, so a stored 'auto' survives.
  if (!Object.prototype.hasOwnProperty.call(parsed, 'qualityMode')) {
    merged.qualityMode = 'manual';
  }
  return merged;
};

export { QUALITY_PRESETS };

export default function useCitySettings() {
  const [settings, setSettings] = useState(loadSettings);

  useEffect(() => {
    const handleTimeOfDayAuto = () => {
      setSettings(prev => {
        if (prev.timeOfDay === 'auto') return prev;
        const next = { ...prev, timeOfDay: 'auto' };
        safeWriteStorage(STORAGE_KEY, JSON.stringify(next));
        return next;
      });
    };
    window.addEventListener(TIME_OF_DAY_AUTO_EVENT, handleTimeOfDayAuto);
    return () => window.removeEventListener(TIME_OF_DAY_AUTO_EVENT, handleTimeOfDayAuto);
  }, []);

  const updateSetting = useCallback((key, value) => {
    setSettings(prev => {
      // If changing quality preset, apply bulk changes. Explicitly picking a preset
      // also pins Manual mode — the user has chosen a fixed tier over adaptation.
      if (key === 'qualityPreset' && QUALITY_PRESETS[value]) {
        const next = { ...prev, qualityPreset: value, qualityMode: 'manual', ...QUALITY_PRESETS[value] };
        safeWriteStorage(STORAGE_KEY, JSON.stringify(next));
        return next;
      }
      const next = { ...prev, [key]: value };
      safeWriteStorage(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const resetSettings = useCallback(() => {
    safeRemoveStorage(STORAGE_KEY);
    setSettings(DEFAULT_SETTINGS);
  }, []);

  return [settings, updateSetting, resetSettings];
}
