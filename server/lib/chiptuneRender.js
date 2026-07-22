/**
 * Chiptune offline renderer (#2911) — deterministic score → PCM → WAV, pure
 * Node (no audio deps). The OGG encode happens in services/chiptune.js via the
 * system ffmpeg; this module never shells out, so the same score always
 * produces byte-identical PCM (unit-tested by hash).
 *
 * Synthesis mirrors the client preview (client/src/lib/chiptunePlayback.js):
 * naive square (with duty) / triangle oscillators — aliasing is part of the
 * 8-bit aesthetic — plus an NES-style 15-bit LFSR noise lane with four drum
 * presets. Every note's envelope (attack/sustain/release) lives inside the
 * note's own duration, so nothing rings past the loop boundary and the loop
 * is seamless by construction.
 */

import { buildScoreEvents } from './chiptuneScore.js';

export const CHIPTUNE_SAMPLE_RATE = 44100;

// Keep the sum of four channels inside [-1, 1] without pumping: per-voice
// headroom plus a hard clamp (deterministic, unlike a compressor).
const MASTER_GAIN = 0.55;
const ATTACK_SEC = 0.005;

// Drum presets for the noise lane. `updateEvery` is how many output samples
// each LFSR value holds (bigger = darker noise); `decaySec` shapes the hit.
// The kick is a descending sine sweep — the classic chiptune trick — not noise.
const NOISE_PRESETS = {
  kick: { kind: 'sweep', fromHz: 160, toHz: 45, decaySec: 0.11 },
  snare: { kind: 'noise', updateEvery: 4, decaySec: 0.12 },
  hat: { kind: 'noise', updateEvery: 1, decaySec: 0.04 },
  'open-hat': { kind: 'noise', updateEvery: 1, decaySec: 0.2 },
};

// NES-style 15-bit LFSR (taps 0 and 1). Re-seeded per note so a note's noise
// is independent of render order — determinism without shared mutable state.
function makeLfsr() {
  let reg = 0x7fff;
  return () => {
    const bit = (reg ^ (reg >> 1)) & 1;
    reg = (reg >> 1) | (bit << 14);
    return (reg & 1) ? 1 : -1;
  };
}

function oscSample(wave, duty, phase) {
  const p = phase - Math.floor(phase);
  if (wave === 'square') return p < duty ? 1 : -1;
  // Triangle: 0 → 1 → −1 → 0 across one period.
  if (p < 0.25) return 4 * p;
  if (p < 0.75) return 2 - 4 * p;
  return 4 * p - 4;
}

/**
 * Render a validated score to mono Float32 PCM. Sample count is
 * round(totalSec · sampleRate) — whole-loop exact for seamless looping.
 */
export function renderScoreToPcm(score, { sampleRate = CHIPTUNE_SAMPLE_RATE } = {}) {
  const { events, totalSec } = buildScoreEvents(score);
  const totalSamples = Math.max(1, Math.round(totalSec * sampleRate));
  const out = new Float32Array(totalSamples);

  for (const ev of events) {
    const start = Math.floor(ev.startSec * sampleRate);
    const end = Math.min(totalSamples, Math.round((ev.startSec + ev.durSec) * sampleRate));
    const durSamples = end - start;
    if (durSamples <= 0) continue;
    const peak = MASTER_GAIN * ev.gain * ev.vel;

    if (ev.noise) {
      const preset = NOISE_PRESETS[ev.noise];
      const lfsr = makeLfsr();
      let held = 0;
      let heldFor = Infinity; // force a fresh LFSR value on the first sample
      // Sweep constants are per-preset, not per-sample — hoist out of the loop.
      const k = preset.kind === 'sweep' ? Math.log(preset.toHz / preset.fromHz) / preset.decaySec : 0;
      const fromOverK = k ? preset.fromHz / k : 0;
      // End-of-note release taper: exponential decay alone can leave a hit
      // near the loop boundary audibly non-zero at its final sample (a click
      // on loop restart). Mirror the tonal branch's inside-the-note release.
      const noteDurSec = durSamples / sampleRate;
      const release = Math.min(0.01, noteDurSec * 0.25);
      for (let i = 0; i < durSamples; i += 1) {
        const t = i / sampleRate;
        let env = Math.exp(-t / preset.decaySec) * (t < ATTACK_SEC ? t / ATTACK_SEC : 1);
        if (t > noteDurSec - release) env *= Math.max(0, (noteDurSec - t) / release);
        let s;
        if (preset.kind === 'sweep') {
          // Exponential pitch sweep integrated in closed form keeps phase smooth.
          const phase = fromOverK * (Math.exp(k * t) - 1);
          s = Math.sin(2 * Math.PI * phase);
        } else {
          if (heldFor >= preset.updateEvery) { held = lfsr(); heldFor = 0; }
          heldFor += 1;
          s = held;
        }
        out[start + i] += s * env * peak;
      }
    } else {
      const attack = Math.min(ATTACK_SEC, ev.durSec * 0.25);
      const release = Math.min(0.05, ev.durSec * 0.3);
      const durSec = durSamples / sampleRate;
      for (let i = 0; i < durSamples; i += 1) {
        const t = i / sampleRate;
        let env = 1;
        if (t < attack) env = t / attack;
        else if (t > durSec - release) env = Math.max(0, (durSec - t) / release);
        out[start + i] += oscSample(ev.wave, ev.duty, t * ev.freq) * env * peak;
      }
    }
  }

  for (let i = 0; i < totalSamples; i += 1) {
    if (out[i] > 1) out[i] = 1;
    else if (out[i] < -1) out[i] = -1;
  }
  return out;
}

/** Encode mono Float32 PCM as a 16-bit little-endian WAV file buffer. */
export function pcmToWavBuffer(pcm, { sampleRate = CHIPTUNE_SAMPLE_RATE } = {}) {
  const dataBytes = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);          // fmt chunk size
  buf.writeUInt16LE(1, 20);           // PCM
  buf.writeUInt16LE(1, 22);           // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);           // block align
  buf.writeUInt16LE(16, 34);          // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.length; i += 1) {
    buf.writeInt16LE(Math.round(pcm[i] * 32767), 44 + i * 2);
  }
  return buf;
}

/** Render a validated score straight to a WAV buffer. */
export function renderScoreToWav(score, options = {}) {
  return pcmToWavBuffer(renderScoreToPcm(score, options), options);
}
