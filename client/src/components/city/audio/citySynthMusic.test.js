import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CHORD_SETS } from '../../../utils/citySoundscape';
import { SYNTH_TIMING } from '../../../lib/lookaheadTransport';

// Minimal fake Web Audio graph for citySynthMusic.js. The module pulls its
// context/output gain from cityAudioEngine's getAudioContext()/getMusicGain()
// (module-level singleton getters, not a constructor call or a param it
// receives) and drives: a convolver reverb, a feedback delay, a lowpass bass
// filter, a bandpass arp filter, and several gain-ramped oscillators.
//
// Mirrors the connectable()/fakeParam() idiom from
// src/test/fakeAudioContext.js, extended with createConvolver/createDelay —
// nodes that shared fake doesn't cover but this module actually touches.
const fakeParam = (initial) => {
  const values = [];
  return {
    value: initial,
    values,
    // Records (v, when, timeConstant) so a test can assert the exact ramp the
    // source schedules, not just "some call happened".
    setTargetAtTime: (v, when, tc) => { values.push({ v, when, tc }); },
  };
};

const connectable = () => ({
  connections: [],
  connect(target) { this.connections.push(target); return target; },
  disconnect: vi.fn(),
});

const makeFakeContext = () => {
  const ctx = {
    now: 0,
    get currentTime() { return ctx.now; },
    sampleRate: 48000,
    oscillators: [],
    gains: [],
    createConvolver() {
      return { buffer: null, ...connectable() };
    },
    createBuffer(channels, length, rate) {
      const chans = Array.from({ length: channels }, () => new Float32Array(length));
      return { length, sampleRate: rate, getChannelData: (ch) => chans[ch] };
    },
    createGain() {
      const gain = { gain: fakeParam(1), ...connectable() };
      ctx.gains.push(gain);
      return gain;
    },
    createDelay() {
      return { delayTime: fakeParam(0), ...connectable() };
    },
    createBiquadFilter() {
      return { type: '', frequency: fakeParam(0), Q: { value: 1 }, ...connectable() };
    },
    createOscillator() {
      const osc = {
        type: '',
        frequency: fakeParam(0),
        detune: fakeParam(0),
        started: null,
        stopped: null,
        ...connectable(),
        start(t) { this.started = t; },
        stop: vi.fn(function stop(t) { this.stopped = t; }),
      };
      ctx.oscillators.push(osc);
      return osc;
    },
  };
  return ctx;
};

// Constants read straight from citySynthMusic.js (not exported, so pinned
// here as literals): STOP_RAMP_TC = 0.02 (gain fade time constant),
// STOP_SETTLE = 0.08 (delay before the hard oscillator stop).
const STOP_RAMP_TC = 0.02;
const STOP_SETTLE = 0.08;
// The note grid, likewise pinned from the source: one 16th every ARP_SEC, with
// a chord change every CHORD_STEPS of them.
const ARP_SEC = 0.15;
const CHORD_STEPS = 16;
const { LOOKAHEAD_MS } = SYNTH_TIMING;

// The bass is the only sawtooth oscillator and the arp the only gain that
// starts at 0 — identify both by that rather than by creation order, so
// re-ordering the graph build can't silently point these assertions at the
// wrong node.
const bassOsc = () => fakeCtx.oscillators.find(o => o.type === 'sawtooth');
const arpGain = () => fakeCtx.gains.find(g => g.gain.value === 0);

// Drive both clocks forward together the way a browser does: every lookahead
// tick also advances the audio clock. Scheduling asserts are meaningless if the
// audio clock stands still while the timer fires.
const runAudio = (seconds) => {
  const ticks = Math.round((seconds * 1000) / LOOKAHEAD_MS);
  for (let i = 0; i < ticks; i += 1) {
    fakeCtx.now += LOOKAHEAD_MS / 1000;
    vi.advanceTimersByTime(LOOKAHEAD_MS);
  }
};

// Same, but with the timer firing at irregular points on the audio clock —
// main-thread jank. This is the condition the old scheduling drifted under: a
// note written at "whatever currentTime is right now" lands off the grid, while
// a note written at an absolute grid time does not. The multipliers average
// 1.0, so the two clocks stay in sync across each cycle and only the sampling
// points jitter.
const runAudioJanky = (seconds) => {
  const jitter = [0.9, 1.6, 0.4, 1.3, 0.8];
  let elapsed = 0;
  for (let i = 0; elapsed < seconds; i += 1) {
    const delta = (LOOKAHEAD_MS / 1000) * jitter[i % jitter.length];
    fakeCtx.now += delta;
    elapsed += delta;
    vi.advanceTimersByTime(LOOKAHEAD_MS);
  }
};

let fakeCtx;
let fakeOutput;

vi.mock('./cityAudioEngine', () => ({
  getAudioContext: () => fakeCtx,
  getMusicGain: () => fakeOutput,
}));

let synth;

beforeEach(async () => {
  vi.resetModules();
  fakeCtx = makeFakeContext();
  fakeOutput = { ...connectable() };
  synth = await import('./citySynthMusic.js');
});

afterEach(() => {
  // citySynthMusic schedules real setInterval timers on startMusic(); stop
  // whatever's running so a test that never called stopMusic doesn't leak
  // intervals into later tests. stopMusic() is a documented no-op when
  // already stopped, so this is always safe to call.
  synth.stopMusic();
});

describe('citySynthMusic', () => {
  it('startMusic is a no-op when already playing', () => {
    synth.startMusic();
    const oscCount = fakeCtx.oscillators.length;
    const gainCount = fakeCtx.gains.length;
    expect(oscCount).toBeGreaterThan(0);

    synth.startMusic();
    // No new nodes created — the second call returns before building anything.
    expect(fakeCtx.oscillators.length).toBe(oscCount);
    expect(fakeCtx.gains.length).toBe(gainCount);
  });

  it('stopMusic ramps each audible layer gain to 0 with the settle time constant', () => {
    synth.startMusic();
    fakeCtx.now = 5;
    synth.stopMusic();

    // liveBassGain/livePadGain/liveArpGain are the three layer gains ramped
    // in stopMusic() — identify them by the ramp-to-0 call they each receive.
    const ramped = fakeCtx.gains.filter(g => g.gain.values.some(entry => entry.v === 0));
    expect(ramped).toHaveLength(3);
    for (const g of ramped) {
      expect(g.gain.values.at(-1)).toEqual({ v: 0, when: 5, tc: STOP_RAMP_TC });
    }
  });

  it('stopMusic schedules oscillator stop at a future time, not immediately', () => {
    synth.startMusic();
    fakeCtx.now = 10;
    synth.stopMusic();

    expect(fakeCtx.oscillators.length).toBeGreaterThan(0);
    for (const osc of fakeCtx.oscillators) {
      expect(osc.stop).toHaveBeenCalledTimes(1);
      // A fade-out, not an abrupt cut: stop lands STOP_SETTLE after "now".
      expect(osc.stopped).toBeCloseTo(10 + STOP_SETTLE, 10);
      expect(osc.stopped).toBeGreaterThan(10);
    }
  });

  it('stopMusic returns the settle/fade duration in ms', () => {
    synth.startMusic();
    const settleMs = synth.stopMusic();
    expect(settleMs).toBe((STOP_SETTLE + STOP_RAMP_TC) * 1000);
  });

  it('defers node disconnects until the ramp settles (the pop-fix contract)', () => {
    vi.useFakeTimers();
    try {
      synth.startMusic();
      const settleMs = synth.stopMusic();

      // An immediate disconnect would cut the fade short — nothing may
      // disconnect at stopMusic() return time.
      const disconnects = () =>
        fakeCtx.oscillators.filter(o => o.disconnect.mock.calls.length > 0).length;
      expect(disconnects()).toBe(0);

      vi.advanceTimersByTime(settleMs + 1);
      expect(disconnects()).toBe(fakeCtx.oscillators.length);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears is-playing state so a later startMusic creates fresh nodes', () => {
    synth.startMusic();
    const firstOscCount = fakeCtx.oscillators.length;
    synth.stopMusic();

    synth.startMusic();
    // Not a no-op this time: a fresh set of oscillators was built.
    expect(fakeCtx.oscillators.length).toBe(firstOscCount * 2);
  });

  describe('lookahead scheduling (#3396)', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('schedules arp notes at absolute future times on the 16th grid, despite jank', () => {
      synth.startMusic(); // gridOrigin = 0
      runAudioJanky(0.5);

      // Every pluck is a (peak, when) pair; the peak ramps are the note onsets.
      const onsets = arpGain().gain.values
        .filter(e => e.v !== 0)
        .map(e => e.when);
      expect(onsets.length).toBeGreaterThan(0);
      // Exactly on the grid — n * ARP_SEC, never "whatever currentTime was".
      onsets.forEach((when, i) => {
        expect(when).toBeCloseTo((i + 1) * ARP_SEC, 10);
      });
      // And scheduled ahead of the clock, not at it.
      expect(Math.max(...onsets)).toBeGreaterThan(fakeCtx.now);
    });

    it('changes chord exactly on the CHORD_STEPS boundary, phase-locked to the arp', () => {
      synth.startMusic();
      runAudioJanky(2.6); // just past step 16 (2.4s)

      const chordChanges = bassOsc().frequency.values;
      expect(chordChanges).toHaveLength(1);
      expect(chordChanges[0].when).toBeCloseTo(CHORD_STEPS * ARP_SEC, 10);
      // Walked to the next chord of the active (bright) set, not re-derived.
      expect(chordChanges[0].v).toBe(CHORD_SETS.bright[1][0]);

      // An arp pluck lands on that same instant — the two grids share one counter.
      const onsets = arpGain().gain.values.filter(e => e.v !== 0).map(e => e.when);
      expect(onsets.some(w => Math.abs(w - CHORD_STEPS * ARP_SEC) < 1e-9)).toBe(true);
    });

    it('stops scheduling once stopMusic clears the lookahead timer', () => {
      synth.startMusic();
      runAudio(0.5);
      const scheduled = arpGain().gain.values.length;
      expect(scheduled).toBeGreaterThan(0);

      synth.stopMusic();
      const afterStop = arpGain().gain.values.length; // includes the stop ramp
      runAudio(2.0);
      expect(arpGain().gain.values).toHaveLength(afterStop);
    });

    it('re-anchors instead of bursting after the tab is backgrounded', () => {
      synth.startMusic();
      runAudio(0.5);
      const before = arpGain().gain.values.length;

      // A throttled tab: 30s of audio clock passes with no timer tick.
      fakeCtx.now += 30;
      vi.advanceTimersByTime(LOOKAHEAD_MS);

      // One window's worth of notes (a couple), not the ~200 missed steps.
      const scheduledInBurst = arpGain().gain.values.length - before;
      expect(scheduledInBurst).toBeLessThan(10);
      // Still on the original grid phase, so the arp/chord lock survives.
      const last = arpGain().gain.values.filter(e => e.v !== 0).at(-1).when;
      expect(last / ARP_SEC).toBeCloseTo(Math.round(last / ARP_SEC), 6);
    });
  });

  it('double-stop is safe: no throw and no double-schedule', () => {
    synth.startMusic();
    fakeCtx.now = 3;
    const first = synth.stopMusic();
    expect(first).toBeGreaterThan(0);
    const stopCallCounts = fakeCtx.oscillators.map(o => o.stop.mock.calls.length);

    // stopMusic() guards on `if (!isPlaying) return 0` — the second call is a
    // no-op, matching the guard actually present in the source.
    expect(() => { synth.stopMusic(); }).not.toThrow();
    const second = synth.stopMusic();
    expect(second).toBe(0);
    expect(fakeCtx.oscillators.map(o => o.stop.mock.calls.length)).toEqual(stopCallCounts);
  });
});
