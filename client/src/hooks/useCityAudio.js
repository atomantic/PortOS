import { useState, useEffect, useCallback, useRef } from 'react';
import { initAudio, setMusicVolume, setSfxVolume, cleanup as cleanupAudio } from '../components/city/audio/cityAudioEngine';
import { startMusic, stopMusic, setSoundscape } from '../components/city/audio/citySynthMusic';
import { playSfx as playSfxFn } from '../components/city/audio/citySoundEffects';

// `soundscape` is the computeSoundscape() view-model (roadmap 3.4): the live mood/energy the
// ambient music should reflect. Optional — when omitted the music plays its default progression.
export default function useCityAudio(settings, soundscape) {
  const [isAudioReady, setIsAudioReady] = useState(false);
  const initedRef = useRef(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // Mirror the latest soundscape so deferred starts (gesture-init, music-toggle) apply it without
  // depending on render timing.
  const soundscapeRef = useRef(soundscape);
  soundscapeRef.current = soundscape;
  const musicEnabled = settings?.musicEnabled;
  const musicVolume = settings?.musicVolume;
  const sfxVolume = settings?.sfxVolume;

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
          if (soundscapeRef.current) setSoundscape(soundscapeRef.current);
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

  // Toggle music on/off based on settings. Apply the current soundscape right after starting so
  // the music opens in the right mood rather than the default progression for a beat.
  useEffect(() => {
    if (!isAudioReady || musicEnabled == null) return;
    if (musicEnabled) {
      startMusic();
      if (soundscapeRef.current) setSoundscape(soundscapeRef.current);
    } else {
      stopMusic();
    }
  }, [isAudioReady, musicEnabled]);

  // Drive the ambient soundscape from live system state. The deps are the individual field
  // values (not the `soundscape` object), so a poll that recomputes an equal snapshot — a new
  // object with identical fields — doesn't re-ramp the graph; only an actual mood/energy change
  // does. The effect reads the freshest snapshot from the ref at run time.
  const chordSet = soundscape?.chordSet;
  const filterBase = soundscape?.filterBase;
  const arpGain = soundscape?.arpGain;
  const padDetune = soundscape?.padDetune;
  useEffect(() => {
    const s = soundscapeRef.current;
    if (!isAudioReady || !musicEnabled || !s) return;
    setSoundscape(s);
  }, [isAudioReady, musicEnabled, chordSet, filterBase, arpGain, padDetune]);

  // Update music volume
  useEffect(() => {
    if (!isAudioReady || !musicEnabled) return;
    setMusicVolume(musicVolume);
  }, [isAudioReady, musicEnabled, musicVolume]);

  // Update SFX volume
  useEffect(() => {
    if (!isAudioReady || sfxVolume == null) return;
    setSfxVolume(sfxVolume);
  }, [isAudioReady, sfxVolume]);

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
