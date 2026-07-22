import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { renderScoreToPcm, pcmToWavBuffer, renderScoreToWav, CHIPTUNE_SAMPLE_RATE } from './chiptuneRender.js';

// 120 BPM, 4 steps/beat, 1 bar of 4/4 → 16 steps · 0.125s = 2s loop.
const score = () => ({
  version: 1,
  bpm: 120,
  stepsPerBeat: 4,
  beatsPerBar: 4,
  channels: [
    { id: 'pulse1', wave: 'square', duty: 0.25, gain: 0.5 },
    { id: 'triangle', wave: 'triangle', gain: 0.6 },
    { id: 'noise', wave: 'noise', gain: 0.4 },
  ],
  patterns: {
    A: {
      bars: 1,
      notes: {
        pulse1: [{ step: 0, pitch: 'C5', len: 8, vel: 0.9 }],
        triangle: [{ step: 0, pitch: 'C3', len: 16 }],
        noise: [
          { step: 0, pitch: 'kick', len: 2 },
          { step: 4, pitch: 'snare', len: 2 },
          { step: 8, pitch: 'hat', len: 1 },
          { step: 12, pitch: 'open-hat', len: 4 },
        ],
      },
    },
  },
  order: ['A'],
});

describe('renderScoreToPcm', () => {
  it('produces a loop-exact sample count', () => {
    const pcm = renderScoreToPcm(score());
    expect(pcm.length).toBe(Math.round(2 * CHIPTUNE_SAMPLE_RATE));
  });

  it('is deterministic — the same score renders byte-identical PCM', () => {
    const a = renderScoreToPcm(score());
    const b = renderScoreToPcm(score());
    const hash = (arr) => createHash('sha256').update(Buffer.from(arr.buffer)).digest('hex');
    expect(hash(a)).toBe(hash(b));
  });

  it('actually produces sound, bounded to [-1, 1]', () => {
    const pcm = renderScoreToPcm(score());
    let peak = 0;
    for (const s of pcm) {
      peak = Math.max(peak, Math.abs(s));
      expect(s).toBeGreaterThanOrEqual(-1);
      expect(s).toBeLessThanOrEqual(1);
    }
    expect(peak).toBeGreaterThan(0.1);
  });

  it('note envelopes stay inside the note — the loop boundary is silent-safe', () => {
    // The last audible event (open-hat) ends at step 16 = the loop end; nothing
    // may write past the buffer, and the final samples should be decaying, not
    // clipped mid-waveform at full scale.
    const pcm = renderScoreToPcm(score());
    const tail = Math.abs(pcm[pcm.length - 1]);
    expect(tail).toBeLessThan(0.2);
  });
});

describe('pcmToWavBuffer', () => {
  it('writes a well-formed 16-bit mono WAV header', () => {
    const pcm = new Float32Array([0, 0.5, -0.5, 1]);
    const wav = pcmToWavBuffer(pcm, { sampleRate: 44100 });
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt16LE(22)).toBe(1);        // mono
    expect(wav.readUInt32LE(24)).toBe(44100);    // sample rate
    expect(wav.readUInt16LE(34)).toBe(16);       // bit depth
    expect(wav.readUInt32LE(40)).toBe(pcm.length * 2);
    expect(wav.length).toBe(44 + pcm.length * 2);
    expect(wav.readInt16LE(44 + 6)).toBe(32767); // 1.0 → full scale
  });
});

describe('renderScoreToWav', () => {
  it('renders a complete WAV whose data length matches the loop', () => {
    const wav = renderScoreToWav(score());
    expect(wav.readUInt32LE(40)).toBe(Math.round(2 * CHIPTUNE_SAMPLE_RATE) * 2);
  });
});
