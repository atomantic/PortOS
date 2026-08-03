import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../components/city/audio/cityAudioEngine', () => ({
  initAudio: vi.fn(() => ({})),
  setMusicVolume: vi.fn(),
  setSfxVolume: vi.fn(),
  scheduleCleanup: vi.fn(),
}));
vi.mock('../components/city/audio/citySynthMusic', () => ({
  startMusic: vi.fn(),
  stopMusic: vi.fn(() => 0),
  setSoundscape: vi.fn(),
}));
vi.mock('../components/city/audio/citySoundEffects', () => ({
  playSfx: vi.fn(),
}));

import useCityAudio from './useCityAudio.js';
import { setSoundscape } from '../components/city/audio/citySynthMusic';
import { computeSoundscape } from '../utils/citySoundscape';

// A healthy, moderately busy city — the live mood is `bright`, so a `tense` override is an
// observable change and clearing it back to auto is observable in the other direction.
const LIVE = computeSoundscape({ systemHealth: { overallHealth: 'healthy' }, agentCount: 3 });

const baseSettings = {
  musicEnabled: true,
  musicVolume: 0.3,
  sfxEnabled: true,
  sfxVolume: 0.5,
  soundscapeOverride: null,
};

// The AudioContext only comes up on a user gesture; without it the hook never applies anything.
const primeAudio = () => act(() => { window.dispatchEvent(new Event('click')); });

const lastSoundscape = () => setSoundscape.mock.calls.at(-1)?.[0];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useCityAudio soundscape override', () => {
  it('applies the live soundscape when no override is set', () => {
    renderHook(() => useCityAudio(baseSettings, LIVE));
    primeAudio();
    expect(lastSoundscape()).toMatchObject({ mood: 'bright', chordSet: 'bright' });
  });

  it('applies the forced chord set while the override is set', () => {
    const { rerender } = renderHook(
      ({ settings }) => useCityAudio(settings, LIVE),
      { initialProps: { settings: baseSettings } },
    );
    primeAudio();

    rerender({ settings: { ...baseSettings, soundscapeOverride: 'tense' } });
    expect(lastSoundscape()).toMatchObject({ mood: 'tense', chordSet: 'tense' });
    expect(lastSoundscape().filterBase).toBeLessThan(LIVE.filterBase);
  });

  it('keeps the forced mood when live system state changes underneath it', () => {
    const { rerender } = renderHook(
      ({ settings, soundscape }) => useCityAudio(settings, soundscape),
      { initialProps: { settings: { ...baseSettings, soundscapeOverride: 'bright' }, soundscape: LIVE } },
    );
    primeAudio();
    expect(lastSoundscape()).toMatchObject({ chordSet: 'bright' });

    // The system goes critical — auto would swap to the tense table; the override must not.
    const stressed = computeSoundscape({ systemHealth: { overallHealth: 'critical' }, agentCount: 3 });
    rerender({ settings: { ...baseSettings, soundscapeOverride: 'bright' }, soundscape: stressed });
    expect(lastSoundscape()).toMatchObject({ mood: 'bright', chordSet: 'bright' });
  });

  it('resumes live computation immediately when the override is cleared to Auto', () => {
    const { rerender } = renderHook(
      ({ settings }) => useCityAudio(settings, LIVE),
      { initialProps: { settings: { ...baseSettings, soundscapeOverride: 'tense' } } },
    );
    primeAudio();
    expect(lastSoundscape()).toMatchObject({ chordSet: 'tense' });

    rerender({ settings: { ...baseSettings, soundscapeOverride: null } });
    expect(lastSoundscape()).toMatchObject({ mood: LIVE.mood, chordSet: LIVE.chordSet });
    expect(lastSoundscape().filterBase).toBeCloseTo(LIVE.filterBase, 5);
  });

  it('ignores an unknown stored override value and stays on live state', () => {
    renderHook(() => useCityAudio({ ...baseSettings, soundscapeOverride: 'stale-mood' }, LIVE));
    primeAudio();
    expect(lastSoundscape()).toMatchObject({ mood: LIVE.mood, chordSet: LIVE.chordSet });
  });

  it('does not re-apply when a poll recomputes an identical soundscape', () => {
    const { rerender } = renderHook(
      ({ soundscape }) => useCityAudio(baseSettings, soundscape),
      { initialProps: { soundscape: LIVE } },
    );
    primeAudio();
    const callsAfterInit = setSoundscape.mock.calls.length;

    // A fresh object with identical fields — the graph must not re-ramp.
    rerender({ soundscape: { ...LIVE } });
    expect(setSoundscape.mock.calls.length).toBe(callsAfterInit);
  });
});
