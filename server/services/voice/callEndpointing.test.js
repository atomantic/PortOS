import { describe, expect, it } from 'vitest';
import {
  CALL_AUDIO_SAMPLE_RATE,
  ENDPOINTING_DEFAULTS,
  createCallEndpointer,
  pcmRms,
  pcmToFloat,
} from './callEndpointing.js';

// 20 ms frames, the size the call host ships.
const FRAME = Math.round(CALL_AUDIO_SAMPLE_RATE * 0.02);

const frame = (amplitude) => {
  const pcm = new Int16Array(FRAME);
  // A square wave keeps RMS equal to the amplitude, so a case can state the
  // level it means instead of a number that happens to work.
  for (let index = 0; index < FRAME; index += 1) pcm[index] = index % 2 ? amplitude : -amplitude;
  return pcm;
};
const speech = () => frame(8000);
const silence = () => frame(0);
const framesFor = (ms) => Math.ceil(ms / 20);

const feed = (endpointer, chunks) => {
  const results = [];
  for (const chunk of chunks) {
    const utterance = endpointer.push(chunk);
    if (utterance) results.push(utterance);
  }
  return results;
};

describe('call endpointing', () => {
  it('measures level and converts to the float PCM the WAV encoder takes', () => {
    expect(pcmRms(silence())).toBe(0);
    expect(pcmRms(speech())).toBeCloseTo(8000 / 32768, 4);
    expect(pcmRms(new Int16Array(0))).toBe(0);

    const floats = pcmToFloat(Int16Array.from([0, 16384, -16384]));
    expect(Array.from(floats)).toEqual([0, 0.5, -0.5]);
  });

  it('ends a turn after the configured trailing silence, not before', () => {
    const endpointer = createCallEndpointer();
    const speechFrames = Array.from({ length: framesFor(600) }, speech);

    // One frame short of the silence window: still listening.
    const early = feed(endpointer, [...speechFrames, ...Array.from({ length: framesFor(ENDPOINTING_DEFAULTS.silenceMs) - 1 }, silence)]);
    expect(early).toHaveLength(0);
    expect(endpointer.speaking).toBe(true);

    const [utterance] = feed(endpointer, [silence()]);
    expect(utterance.reason).toBe('silence');
    expect(endpointer.speaking).toBe(false);
    // The trailing silence is dropped, the leading pre-roll is kept.
    expect(utterance.durationMs).toBeGreaterThanOrEqual(600);
    expect(utterance.durationMs).toBeLessThan(600 + ENDPOINTING_DEFAULTS.silenceMs);
  });

  it('keeps pre-roll so the first consonant is not clipped', () => {
    const endpointer = createCallEndpointer();
    // A long idle stretch must not grow the buffer beyond the pre-roll window.
    feed(endpointer, Array.from({ length: framesFor(10_000) }, silence));
    const [utterance] = feed(endpointer, [
      ...Array.from({ length: framesFor(400) }, speech),
      ...Array.from({ length: framesFor(ENDPOINTING_DEFAULTS.silenceMs) }, silence),
    ]);

    expect(utterance.durationMs).toBeGreaterThan(400);
    expect(utterance.durationMs).toBeLessThanOrEqual(400 + ENDPOINTING_DEFAULTS.preRollMs + 20);
  });

  it('caps one utterance so a held-open line cannot buffer without bound', () => {
    const endpointer = createCallEndpointer();
    const [utterance] = feed(endpointer, Array.from({ length: framesFor(30_000) }, speech));

    expect(utterance.reason).toBe('max-duration');
    expect(utterance.durationMs).toBeGreaterThanOrEqual(ENDPOINTING_DEFAULTS.maxUtteranceMs);
    expect(utterance.durationMs).toBeLessThan(ENDPOINTING_DEFAULTS.maxUtteranceMs + 100);
  });

  it('drops a click too short to be speech', () => {
    const endpointer = createCallEndpointer({ preRollMs: 0 });
    const results = feed(endpointer, [
      speech(),
      ...Array.from({ length: framesFor(ENDPOINTING_DEFAULTS.silenceMs) }, silence),
    ]);

    expect(results).toHaveLength(0);
    expect(endpointer.speaking).toBe(false);
  });

  it('endpoints identically whether audio arrives smoothly or in one burst', () => {
    // A delayed socket flush must not move the turn boundary — the reason the
    // decision is driven by sample count rather than arrival time.
    const chunks = [
      ...Array.from({ length: framesFor(500) }, speech),
      ...Array.from({ length: framesFor(ENDPOINTING_DEFAULTS.silenceMs) }, silence),
    ];
    const smooth = feed(createCallEndpointer(), chunks);
    const burst = feed(createCallEndpointer(), [
      new Int16Array(chunks.slice(0, framesFor(500)).flatMap((c) => Array.from(c))),
      new Int16Array(chunks.slice(framesFor(500)).flatMap((c) => Array.from(c))),
    ]);

    expect(burst[0].durationMs).toBe(smooth[0].durationMs);
    expect(burst[0].reason).toBe(smooth[0].reason);
  });

  it('flushes buffered speech when the call drops mid-sentence', () => {
    const endpointer = createCallEndpointer();
    feed(endpointer, Array.from({ length: framesFor(500) }, speech));

    const flushed = endpointer.flush();
    expect(flushed.reason).toBe('flush');
    expect(endpointer.speaking).toBe(false);
    // A second flush has nothing left to report.
    expect(endpointer.flush()).toBeNull();
  });

  it('reports nothing for an idle line', () => {
    const endpointer = createCallEndpointer();
    expect(feed(endpointer, Array.from({ length: framesFor(5_000) }, silence))).toHaveLength(0);
    expect(endpointer.flush()).toBeNull();
    expect(endpointer.push(new Int16Array(0))).toBeNull();
  });
});
