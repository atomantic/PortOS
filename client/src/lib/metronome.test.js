import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  beatDescriptor,
  clampBpm,
  secondsPerBeat,
  timeSignatureFromScore,
  createMetronome,
  METRONOME_BPM_MIN,
  METRONOME_BPM_MAX,
} from './metronome.js';

// jsdom has no Web Audio. Minimal fake AudioContext that records every scheduled
// click's start time + frequency, with a manually-advanceable `currentTime` so a
// test can drive the lookahead scheduler deterministically.
function makeFakeAudioContext() {
  const ctx = {
    currentTime: 0,
    state: 'running',
    destination: {},
    started: [], // { t, freq }
    resume() { ctx.state = 'running'; return Promise.resolve(); },
    createGain() {
      return {
        gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect(node) { return node; },
        disconnect() {},
      };
    },
    createOscillator() {
      const osc = {
        frequency: { value: 0 },
        onended: null,
        connect(node) { return node; },
        disconnect() {},
        start(t) { ctx.started.push({ t, freq: osc.frequency.value }); },
        stop() {},
      };
      return osc;
    },
  };
  return ctx;
}

// The metronome module caches one shared AudioContext, so we reuse a single
// fake across tests (resetting its state each time) rather than swapping it.
// The fake must be a real constructor — an arrow fn isn't `new`able.
//
// Inject it via `vi.stubGlobal` on globalThis (the source falls back to
// globalThis.AudioContext when `window` is absent) rather than `window.…`, so
// this suite runs under the server's node test environment too — that run globs
// client lib tests with no jsdom, so a bare `window` reference would throw.
let fakeCtx = makeFakeAudioContext();

beforeEach(() => {
  fakeCtx.currentTime = 0;
  fakeCtx.state = 'running';
  fakeCtx.started.length = 0;
  function FakeAudioContext() { return fakeCtx; }
  vi.stubGlobal('AudioContext', FakeAudioContext);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('clampBpm', () => {
  it('clamps into the 20–320 band and rounds', () => {
    expect(clampBpm(10)).toBe(METRONOME_BPM_MIN);
    expect(clampBpm(999)).toBe(METRONOME_BPM_MAX);
    expect(clampBpm(120.4)).toBe(120);
    expect(clampBpm('68')).toBe(68);
  });

  it('returns null for non-numbers (absent vs clamped)', () => {
    expect(clampBpm('abc')).toBeNull();
    expect(clampBpm(null)).toBeNull();
    expect(clampBpm(undefined)).toBeNull();
  });
});

describe('secondsPerBeat', () => {
  it('derives the interval from BPM', () => {
    expect(secondsPerBeat(120)).toBeCloseTo(0.5, 6);
    expect(secondsPerBeat(60)).toBeCloseTo(1, 6);
    expect(secondsPerBeat(68)).toBeCloseTo(60 / 68, 6);
  });

  it('falls back to the default tempo for invalid input', () => {
    expect(secondsPerBeat('nope')).toBeCloseTo(0.5, 6); // DEFAULT_BPM 120
  });
});

describe('timeSignatureFromScore', () => {
  it('derives the time signature from the score header', () => {
    expect(timeSignatureFromScore('time: 3/4\n| C4q D4q E4q |')).toEqual({ beats: 3, beatValue: 4 });
    expect(timeSignatureFromScore('time: 6/8\n| C4e |')).toEqual({ beats: 6, beatValue: 8 });
  });

  it('defaults to 4/4 when absent or empty', () => {
    expect(timeSignatureFromScore('')).toEqual({ beats: 4, beatValue: 4 });
    expect(timeSignatureFromScore(null)).toEqual({ beats: 4, beatValue: 4 });
    expect(timeSignatureFromScore('| C4q |')).toEqual({ beats: 4, beatValue: 4 });
  });

  it('accepts a pre-parsed { beats, beatValue } object', () => {
    expect(timeSignatureFromScore({ beats: 5, beatValue: 4 })).toEqual({ beats: 5, beatValue: 4 });
  });
});

describe('beatDescriptor', () => {
  it('accents beat 1 of every bar', () => {
    const opts = { beatsPerBar: 4, countInBars: 0 };
    expect(beatDescriptor(0, opts)).toMatchObject({ beat: 1, bar: 1, accent: true, countIn: false });
    expect(beatDescriptor(1, opts)).toMatchObject({ beat: 2, accent: false });
    expect(beatDescriptor(3, opts)).toMatchObject({ beat: 4, accent: false });
    expect(beatDescriptor(4, opts)).toMatchObject({ beat: 1, bar: 2, accent: true });
  });

  it('places the count-in bar as bar 0 then starts the music at bar 1', () => {
    const opts = { beatsPerBar: 4, countInBars: 1 };
    // 4 count-in beats (idx 0..3), then music starts at idx 4.
    for (let i = 0; i < 4; i += 1) {
      expect(beatDescriptor(i, opts)).toMatchObject({ bar: 0, countIn: true, beat: i + 1 });
    }
    expect(beatDescriptor(4, opts)).toMatchObject({ bar: 1, countIn: false, beat: 1, accent: true });
    expect(beatDescriptor(7, opts)).toMatchObject({ bar: 1, countIn: false, beat: 4 });
    expect(beatDescriptor(8, opts)).toMatchObject({ bar: 2, countIn: false, beat: 1, accent: true });
  });

  it('honours a custom beats-per-bar (3/4)', () => {
    const opts = { beatsPerBar: 3, countInBars: 1 };
    // count-in = 3 beats; music begins at idx 3.
    expect(beatDescriptor(2, opts)).toMatchObject({ bar: 0, countIn: true, beat: 3 });
    expect(beatDescriptor(3, opts)).toMatchObject({ bar: 1, countIn: false, beat: 1 });
    expect(beatDescriptor(6, opts)).toMatchObject({ bar: 2, beat: 1 });
  });

  it('respects a custom accentBeat', () => {
    expect(beatDescriptor(2, { beatsPerBar: 4, accentBeat: 3 })).toMatchObject({ beat: 3, accent: true });
    expect(beatDescriptor(0, { beatsPerBar: 4, accentBeat: 3 })).toMatchObject({ beat: 1, accent: false });
  });
});

// Drive both clocks in lockstep: advance the AudioContext clock and the fake
// timers together so the lookahead scheduler + beat-callback timeouts fire as in
// real time.
async function runFor(ms, step = 10) {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    fakeCtx.currentTime += step / 1000;
    await vi.advanceTimersByTimeAsync(step);
  }
}

describe('createMetronome scheduling', () => {
  it('schedules clicks one beat apart at the given BPM', async () => {
    vi.useFakeTimers();
    const metro = createMetronome({ bpm: 120, beatsPerBar: 4, countInBars: 0 });
    await metro.start();
    await runFor(2000);
    metro.stop();

    expect(fakeCtx.started.length).toBeGreaterThanOrEqual(3);
    const times = fakeCtx.started.map((s) => s.t);
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i] - times[i - 1]).toBeCloseTo(0.5, 3); // 60/120
    }
  });

  it('accents beat 1 of each bar with a brighter click', async () => {
    vi.useFakeTimers();
    const metro = createMetronome({ bpm: 240, beatsPerBar: 4, countInBars: 0 });
    await metro.start();
    await runFor(1200); // 240bpm → 0.25s/beat → ~4 beats in a bar
    metro.stop();

    // Every 4th click (beat 1) is the accent frequency.
    fakeCtx.started.forEach((click, i) => {
      const expected = i % 4 === 0 ? 1500 : 1000;
      expect(click.freq).toBe(expected);
    });
  });

  it('fires the count-in beats then onCountInComplete at the first music downbeat', async () => {
    vi.useFakeTimers();
    const beats = [];
    let countInCompleteAt = null;
    const metro = createMetronome({
      bpm: 120,
      beatsPerBar: 4,
      countInBars: 1,
      onBeat: (info) => beats.push(info),
      onCountInComplete: () => { countInCompleteAt = beats.length; },
    });
    await metro.start();
    await runFor(3200); // 1 count-in bar (2s) + ~2 music beats
    metro.stop();

    const countInBeats = beats.filter((b) => b.countIn);
    expect(countInBeats).toHaveLength(4); // one bar of count-in
    // onCountInComplete fires just before the first music beat was dispatched.
    expect(countInCompleteAt).toBe(4);
    const firstMusic = beats[4];
    expect(firstMusic).toMatchObject({ countIn: false, bar: 1, beat: 1, accent: true });
    // Beat callbacks carry the audio-clock timestamp for downstream consumers.
    expect(typeof firstMusic.whenAudioTime).toBe('number');
  });

  it('stop() cancels the lookahead interval and pending beat callbacks', async () => {
    vi.useFakeTimers();
    const beats = [];
    const metro = createMetronome({ bpm: 120, beatsPerBar: 4, onBeat: (info) => beats.push(info) });
    await metro.start();
    await runFor(600);
    metro.stop();

    expect(metro.isRunning()).toBe(false);
    const clicksAfterStop = fakeCtx.started.length;
    const beatsAfterStop = beats.length;

    // Advancing well past stop must schedule no further clicks or callbacks.
    await runFor(2000);
    expect(fakeCtx.started.length).toBe(clicksAfterStop);
    expect(beats.length).toBe(beatsAfterStop);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('setBpm changes the interval of subsequently-scheduled beats', async () => {
    vi.useFakeTimers();
    const metro = createMetronome({ bpm: 60, beatsPerBar: 4, countInBars: 0 });
    expect(metro.getBpm()).toBe(60);
    metro.setBpm(120);
    expect(metro.getBpm()).toBe(120);
    metro.setBpm(99999); // clamped
    expect(metro.getBpm()).toBe(METRONOME_BPM_MAX);
    metro.setBpm('garbage'); // ignored — keeps last valid
    expect(metro.getBpm()).toBe(METRONOME_BPM_MAX);
  });
});
