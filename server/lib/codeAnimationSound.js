/** Bounded, deterministic offline sound; no browser clock or authored code execution. */
import { createHash } from 'crypto';
import { canonicalStringify } from './objects.js';
import { pcmToWavBuffer } from './chiptuneRender.js';

export const CODE_ANIMATION_SAMPLE_RATE = 48000;
export const soundHash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Quantize seconds through whole film frames, then into a fixed PCM sample grid. */
export function soundTimeline(manifest) {
  const { fps, durationSeconds } = manifest.format;
  const frames = Math.round(durationSeconds * fps);
  const samples = Math.round(frames / fps * CODE_ANIMATION_SAMPLE_RATE);
  const events = manifest.audio.kind === 'procedural' && manifest.audio.version === 1
    ? manifest.audio.events.map(event => {
      const frame = Math.round(event.atSeconds * fps);
      const startSample = Math.round(frame / fps * CODE_ANIMATION_SAMPLE_RATE);
      return { ...event, frame, startSample, sampleCount: Math.round(event.durationSeconds * CODE_ANIMATION_SAMPLE_RATE) };
    }) : [];
  const timeline = { version: 1, sampleRate: CODE_ANIMATION_SAMPLE_RATE, fps, frames, samples, events };
  return { ...timeline, hash: soundHash(canonicalStringify({ timeline, audio: manifest.audio })) };
}

/** Original impact/reveal tones with fixed envelopes and pitch sweeps. */
export function synthesizeSoundtrack(timeline) {
  const pcm = new Float32Array(timeline.samples);
  for (const event of timeline.events) {
    for (let i = 0; i < event.sampleCount && event.startSample + i < pcm.length; i += 1) {
      const t = i / timeline.sampleRate;
      const duration = event.sampleCount / timeline.sampleRate;
      const attack = Math.min(0.005, duration / 4);
      const release = Math.min(0.03, duration / 4);
      const envelope = Math.min(1, t / attack, (duration - t) / release);
      const from = event.effect === 'impact' ? 160 : 300;
      const to = event.effect === 'impact' ? 45 : 900;
      const phase = from * t + (to - from) * t * t / (2 * duration);
      const decay = event.effect === 'impact' ? Math.exp(-t * 6 / duration) : 1;
      pcm[event.startSample + i] += 0.7 * event.gain * envelope * decay * Math.sin(2 * Math.PI * phase);
    }
  }
  for (let i = 0; i < pcm.length; i += 1) pcm[i] = Math.max(-1, Math.min(1, pcm[i]));
  return pcmToWavBuffer(pcm, { sampleRate: timeline.sampleRate });
}

/** Measure event windows in decoded mono s16 PCM (WAV or MP4 decode). */
export function measureSoundEvents(bytes, timeline) {
  return timeline.events.map(event => {
    let firstSample = null;
    let peak = 0;
    let squares = 0;
    const end = Math.min(bytes.length / 2, event.startSample + event.sampleCount);
    for (let i = Math.max(0, event.startSample - Math.round(0.05 * timeline.sampleRate)); i < end; i += 1) {
      const sample = bytes.readInt16LE(i * 2) / 32768;
      const magnitude = Math.abs(sample);
      if (firstSample === null && magnitude > 0.001) firstSample = i;
      peak = Math.max(peak, magnitude);
      squares += sample * sample;
    }
    return { label: event.label, frame: event.frame, startSample: event.startSample,
      firstSample, firstSeconds: firstSample === null ? null : firstSample / timeline.sampleRate,
      peak, rms: end > event.startSample ? Math.sqrt(squares / (end - event.startSample)) : 0 };
  });
}
