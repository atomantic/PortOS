import { describe, expect, it } from 'vitest';
import { captureTimeMs, createPlaybackReference, deviceTimeMs, inputLatencyOf, supportsPlaybackReference } from './voicePlaybackReference';

const OUT_RATE = 24000;
const MIC_RATE = 16000;
const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
const block = (level, n = 480) => new Float32Array(n).fill(level); // 20 ms at 24 kHz

describe('createPlaybackReference', () => {
  it('returns what reached the speaker during a mic window, resampled to the mic rate', () => {
    const ref = createPlaybackReference({ outRate: OUT_RATE, micRate: MIC_RATE });
    ref.push(block(0.3), 1000);
    ref.push(block(0.1), 1020);
    expect(rms(ref.frame(1000, 320))).toBeCloseTo(0.3, 5);
    expect(rms(ref.frame(1020, 320))).toBeCloseTo(0.1, 5);
    const straddle = ref.frame(1010, 320);
    expect(straddle[0]).toBeCloseTo(0.3, 5);
    expect(straddle[319]).toBeCloseTo(0.1, 5);
  });

  it('reads silence where nothing has reached the speaker yet, so queued audio is not playback', () => {
    const ref = createPlaybackReference({ outRate: OUT_RATE, micRate: MIC_RATE });
    // Audio the tap has not rendered (still queued, or waiting on the avatar) is simply absent from the timeline.
    ref.push(block(0.3), 1100);
    expect(rms(ref.frame(1000, 320))).toBe(0);
    expect(rms(ref.frame(1080, 320))).toBe(0);
    const partial = ref.frame(1090, 320);
    expect(partial[0]).toBe(0);
    expect(partial[319]).toBeCloseTo(0.3, 5);
    expect(rms(ref.frame(1200, 320))).toBe(0);
  });

  it('carries muted output as silence: the tap sees post-volume audio', () => {
    const ref = createPlaybackReference({ outRate: OUT_RATE, micRate: MIC_RATE });
    ref.push(block(0), 1000);
    expect(rms(ref.frame(1000, 320))).toBe(0);
  });

  it('forgets playback older than its window', () => {
    const ref = createPlaybackReference({ outRate: OUT_RATE, micRate: MIC_RATE, keepMs: 100 });
    ref.push(block(0.3), 1000);
    ref.push(block(0.2), 1200);
    expect(rms(ref.frame(1000, 320))).toBe(0);
    expect(rms(ref.frame(1200, 320))).toBeCloseTo(0.2, 5);
  });

  it('ignores blocks without a known time and returns silence for an unknown window', () => {
    const ref = createPlaybackReference({ outRate: OUT_RATE, micRate: MIC_RATE });
    ref.push(block(0.3), null);
    ref.push(block(0.3), Number.NaN);
    expect(rms(ref.frame(1000, 320))).toBe(0);
    ref.push(block(0.3), 1000);
    expect(rms(ref.frame(null, 320))).toBe(0);
  });
});

describe('playback reference clocks', () => {
  it('maps output context time to the device clock, including output delay', () => {
    const ctx = { getOutputTimestamp: () => ({ contextTime: 2, performanceTime: 5000 }) };
    expect(deviceTimeMs(ctx, 2.05)).toBeCloseTo(5050, 6);
    expect(deviceTimeMs({ getOutputTimestamp: () => ({ contextTime: 0, performanceTime: 0 }) }, 1)).toBeNull();
    expect(deviceTimeMs({}, 1)).toBeNull();
  });

  it('maps mic context time to capture time, behind the render position and the input latency', () => {
    expect(captureTimeMs({ currentTime: 3 }, 2.99, 0.01, 8000)).toBeCloseTo(7980, 6);
    expect(captureTimeMs({}, 1, 0, 8000)).toBeNull();
  });

  it('needs both contexts to place samples on the wall clock', () => {
    const withTs = { getOutputTimestamp: () => ({}) };
    expect(supportsPlaybackReference(withTs, withTs)).toBe(true);
    expect(supportsPlaybackReference(withTs, {})).toBe(false);
  });

  it('reads the input latency the browser reports, else none', () => {
    const stream = (latency) => ({ getAudioTracks: () => [{ getSettings: () => ({ latency }) }] });
    expect(inputLatencyOf(stream(0.012))).toBe(0.012);
    expect(inputLatencyOf(stream(undefined))).toBe(0);
    expect(inputLatencyOf({ getTracks: () => [] })).toBe(0);
  });
});
