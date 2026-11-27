import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SFX_EVENT,
  readTransceiverSfx,
  writeTransceiverSfx,
  isTransceiverSfxStorageEvent,
  playRadioCue,
} from './voiceTransceiverSfx';

describe('voiceTransceiverSfx', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to enabled and persists toggles with cross-tab event', () => {
    expect(readTransceiverSfx()).toBe(true);
    const onEvent = vi.fn();
    window.addEventListener(SFX_EVENT, onEvent);
    try {
      writeTransceiverSfx(false);
      expect(readTransceiverSfx()).toBe(false);
      expect(localStorage.getItem('portos.voice.sfx')).toBe('0');
      expect(onEvent).toHaveBeenCalledTimes(1);

      writeTransceiverSfx(true);
      expect(readTransceiverSfx()).toBe(true);
      expect(localStorage.getItem('portos.voice.sfx')).toBe('1');
      expect(isTransceiverSfxStorageEvent({ key: 'portos.voice.sfx' })).toBe(true);
      expect(isTransceiverSfxStorageEvent({ key: 'other' })).toBe(false);
    } finally {
      window.removeEventListener(SFX_EVENT, onEvent);
    }
  });

  it('skips oscillator synthesis when disabled or muted and plays when enabled', () => {
    const start = vi.fn();
    const stop = vi.fn();
    const Ctor = vi.fn(function FakeCtx() {
      this.state = 'running';
      this.currentTime = 0;
      this.destination = {};
      this.createOscillator = () => ({
        type: 'sine',
        frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
        connect: vi.fn(),
        start,
        stop,
      });
      this.createGain = () => ({
        gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
        connect: vi.fn(),
      });
    });
    const prev = window.AudioContext;
    window.AudioContext = Ctor;
    try {
      playRadioCue('tx-start', { enabled: false, volume: 0.8, muted: false });
      playRadioCue('tx-start', { enabled: true, volume: 0.8, muted: true });
      expect(start).not.toHaveBeenCalled();

      playRadioCue('tx-start', { enabled: true, volume: 0.8, muted: false });
      expect(start).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      window.AudioContext = prev;
    }
  });
});
