/**
 * Synthesized Web Audio transceiver cues (squelch chirps, roger beeps, tactile key ticks).
 * Zero external audio assets; silently no-ops when muted, disabled, or AudioContext is unavailable.
 */

import { safeReadStorage, safeWriteStorage } from './safeStorage';

const SFX_KEY = 'portos.voice.sfx';
export const SFX_EVENT = 'portos:voice:sfx';

let sfxCtx = null;

export const readTransceiverSfx = () => safeReadStorage(SFX_KEY) !== '0';

export const writeTransceiverSfx = (enabled) => {
  safeWriteStorage(SFX_KEY, enabled ? '1' : '0');
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SFX_EVENT));
};

export const isTransceiverSfxStorageEvent = (event) =>
  !event || event.key === SFX_KEY || event.key === null;

const getSfxContext = () => {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  if (!sfxCtx || sfxCtx.state === 'closed') sfxCtx = new Ctor();
  if (sfxCtx.state === 'suspended') sfxCtx.resume?.().catch(() => {});
  return sfxCtx;
};

const CUES = {
  // Subtle two-tone squelch open when starting TX
  'tx-start': [
    { freq: 780, endFreq: 1120, duration: 0.048, delay: 0, gain: 0.14, type: 'triangle' },
  ],
  // Short roger-beep when closing TX / sending voice
  'tx-end': [
    { freq: 1080, endFreq: 840, duration: 0.055, delay: 0, gain: 0.13, type: 'sine' },
  ],
  // Soft warm telemetry ping when assistant reply starts playing
  'rx-start': [
    { freq: 620, endFreq: 740, duration: 0.042, delay: 0, gain: 0.1, type: 'sine' },
  ],
  // Ultra-brief mechanical micro-tick for hardware keys and rotary steps
  click: [
    { freq: 1350, endFreq: 920, duration: 0.016, delay: 0, gain: 0.07, type: 'triangle' },
  ],
};

export function playRadioCue(cue, { volume = 0.85, muted = false, enabled } = {}) {
  const active = typeof enabled === 'boolean' ? enabled : readTransceiverSfx();
  if (!active || muted || volume <= 0) return;
  const tones = CUES[cue];
  if (!tones) return;
  try {
    const ctx = getSfxContext();
    if (!ctx || typeof ctx.createOscillator !== 'function' || typeof ctx.createGain !== 'function') return;
    const now = ctx.currentTime;
    const scale = Math.max(0, Math.min(1, volume));
    for (const tone of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const start = now + tone.delay;
      const peak = tone.gain * scale;
      osc.type = tone.type;
      osc.frequency.setValueAtTime(tone.freq, start);
      osc.frequency.exponentialRampToValueAtTime(tone.endFreq, start + tone.duration);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(peak, start + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + tone.duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + tone.duration + 0.01);
    }
  } catch {
    // Audio feedback is strictly best-effort and must never interrupt voice flows.
  }
}
