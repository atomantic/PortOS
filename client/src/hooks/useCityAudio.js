import { useState, useEffect, useCallback, useRef } from 'react';
import { initAudio, setMusicVolume, setSfxVolume, cleanup as cleanupAudio } from '../components/city/audio/cityAudioEngine';
import { startMusic, stopMusic } from '../components/city/audio/citySynthMusic';
import { playSfx as playSfxFn } from '../components/city/audio/citySoundEffects';

export default function useCityAudio(settings) {
  const [isAudioReady, setIsAudioReady] = useState(false);
  const initedRef = useRef(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Init AudioContext on first user gesture
  useEffect(() => {
    const handleGesture = () => {
      if (initedRef.current) return;
      initedRef.current = true;
      const ctx = initAudio();
      if (ctx) {
        setIsAudioReady(true);
        // Start music if enabled at init time
        if (settingsRef.current?.musicEnabled) {
          startMusic();
          setMusicVolume(settingsRef.current.musicVolume);
        }
      }
      window.removeEventListener('click', handleGesture);
      window.removeEventListener('keydown', handleGesture);
    };
    window.addEventListener('click', handleGesture);
    window.addEventListener('keydown', handleGesture);
    return () => {
      window.removeEventListener('click', handleGesture);
      window.removeEventListener('keydown', handleGesture);
    };
  }, []);

  // Toggle music on/off based on settings
  useEffect(() => {
    if (!isAudioReady || !settings) return;
    if (settings.musicEnabled) {
      startMusic();
      setMusicVolume(settings.musicVolume);
    } else {
      stopMusic();
    }
  }, [isAudioReady, settings?.musicEnabled]);

  // Update music volume
  useEffect(() => {
    if (!isAudioReady || !settings?.musicEnabled) return;
    setMusicVolume(settings.musicVolume);
  }, [isAudioReady, settings?.musicVolume]);

  // Update SFX volume
  useEffect(() => {
    if (!isAudioReady || !settings) return;
    setSfxVolume(settings.sfxVolume);
  }, [isAudioReady, settings?.sfxVolume]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopMusic();
      cleanupAudio();
    };
  }, []);

  const playSfx = useCallback((name) => {
    if (!isAudioReady || !settingsRef.current?.sfxEnabled) return;
    playSfxFn(name);
  }, [isAudioReady]);

  return { playSfx, isAudioReady };
}
