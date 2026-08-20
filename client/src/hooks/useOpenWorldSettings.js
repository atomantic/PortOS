import { useEffect, useState, useCallback } from 'react';
import { safeReadStorage, safeWriteStorage, safeRemoveStorage } from '../lib/safeStorage.js';

// Exported so useTheme can reset the city's time-of-day override without
// re-declaring these magic strings (a typo there would silently break the reset).
export const STORAGE_KEY = 'portos-city-settings';
export const TIME_OF_DAY_AUTO_EVENT = 'portos-city-timeofday-auto';

const DEFAULT_SETTINGS = {
  musicEnabled: false,
  musicVolume: 0.3,
  sfxEnabled: true,
  sfxVolume: 0.5,
  // Manual soundscape override (issue #3395). `null` is the explicit "auto" sentinel: the music's
  // mood follows live system state. A mood name from SOUNDSCAPE_MOODS pins it instead.
  soundscapeOverride: null,
  timeOfDay: 'auto', // 'auto' follows the active theme's day/night mode; 'day'/'night' force it
  // Art direction: 'vibes' is the low-poly bright open world (default); 'cyber' restores
  // the original neon-night OpenWorld look. Existing installs have no stored value and so
  // land on the new default — deliberate, this IS the world's new look — and the picker in
  // the Visual tab switches back with no migration.
  worldStyle: 'vibes',
  // OpenWorld opens as a game, not an orbital dashboard. Users can still press Tab (or the
  // HUD control) to pull back to the planning view, while V / settings can switch to first person.
  explorationMode: true,
  cameraView: 'third', // the rover is the default actor; first person remains an explicit option
};

// Old releases persisted renderer controls alongside player choices. They are intentionally
// ignored on read so a saved payload cannot resurrect removed settings in the live state.
const LEGACY_RENDER_KEYS = new Set([
  'qualityMode',
  'qualityPreset',
  'reflectionsEnabled',
  'particleDensity',
  'scanlineOverlay',
  'ambientBrightness',
  'neonBrightness',
  'dpr',
]);

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
  const persistedChoices = Object.fromEntries(
    Object.entries(parsed).filter(([key]) => !LEGACY_RENDER_KEYS.has(key)),
  );
  return { ...DEFAULT_SETTINGS, ...persistedChoices };
};

export default function useOpenWorldSettings() {
  const [settings, setSettings] = useState(loadSettings);
  // Monotonic counter bumped on every reset. The runtime render budget (Auto mode) lives
  // outside `settings`, so RESET DEFAULTS must still re-arm it even though renderer tiers
  // are no longer persisted — consumers watch this token to reset the budget too.
  const [resetNonce, setResetNonce] = useState(0);

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
      const next = { ...prev, [key]: value };
      safeWriteStorage(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const resetSettings = useCallback(() => {
    safeRemoveStorage(STORAGE_KEY);
    setSettings(DEFAULT_SETTINGS);
    setResetNonce(n => n + 1);
  }, []);

  return [settings, updateSetting, resetSettings, resetNonce];
}
