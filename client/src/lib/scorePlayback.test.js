import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseScore, parsePitch } from './scoreNotation.js';
import {
  buildSchedule,
  midiToFreq,
  pitchToMidi,
  noteToFrequency,
  createScorePlayer,
  DEFAULT_BPM,
} from './scorePlayback.js';

// --- Pitch → frequency ------------------------------------------------------
describe('pitch → frequency', () => {
  it('maps A4 to exactly 440 Hz (the tuning reference)', () => {
    expect(pitchToMidi(parsePitch('A4'))).toBe(69);
    expect(midiToFreq(69)).toBe(440);
    expect(noteToFrequency(parsePitch('A4'))).toBe(440);
  });

  it('maps middle C (C4) to MIDI 60 ≈ 261.63 Hz', () => {
    expect(pitchToMidi(parsePitch('C4'))).toBe(60);
    expect(noteToFrequency(parsePitch('C4'))).toBeCloseTo(261.626, 2);
  });

  it('applies accidentals as semitone shifts (F#4 = MIDI 66)', () => {
    expect(pitchToMidi(parsePitch('F#4'))).toBe(66);
    expect(noteToFrequency(parsePitch('F#4'))).toBeCloseTo(369.994, 2);
    expect(pitchToMidi(parsePitch('Bb3'))).toBe(58);
  });

  it('octaves double the frequency (A5 = 880)', () => {
    expect(noteToFrequency(parsePitch('A5'))).toBe(880);
    expect(noteToFrequency(parsePitch('A3'))).toBe(220);
  });

  it('returns null for non-pitches', () => {
    expect(noteToFrequency(null)).toBeNull();
    expect(pitchToMidi(undefined)).toBeNull();
  });
});

// --- Schedule building (pure) ----------------------------------------------
describe('buildSchedule', () => {
  it('schedules one event per note with correct onsets, durations and frequencies', () => {
    const score = parseScore('time: 4/4\ntempo: 120\n| C4q D4q E4h |');
    const { events, totalSec, secPerQuarter } = buildSchedule(score);
    // tempo 120, quarter-beat = (60/120)·(4/4) = 0.5 s.
    expect(secPerQuarter).toBeCloseTo(0.5, 6);
    expect(events.map((e) => e.index)).toEqual([0, 1, 2]);
    expect(events.map((e) => e.startSec)).toEqual([0, 0.5, 1.0]);
    expect(events.map((e) => e.durSec)).toEqual([0.5, 0.5, 1.0]);
    expect(events[0].freq).toBeCloseTo(261.626, 2); // C4
    expect(events[1].freq).toBeCloseTo(293.665, 2); // D4
    expect(events[2].freq).toBeCloseTo(329.628, 2); // E4
    expect(totalSec).toBeCloseTo(2.0, 6);
  });

  it('advances time through rests but carries no frequency', () => {
    const score = parseScore('time: 4/4\ntempo: 60\n| C4q rq C4h |');
    const { events, totalSec } = buildSchedule(score);
    expect(events).toHaveLength(3);
    expect(events[1].rest).toBe(true);
    expect(events[1].freq).toBeNull();
    expect(events[1].startSec).toBeCloseTo(1.0, 6); // after the first quarter (60 bpm → 1 s)
    expect(events[2].startSec).toBeCloseTo(2.0, 6); // after the rest
    expect(totalSec).toBeCloseTo(4.0, 6);
  });

  it('honors the time signature denominator (6/8 counts the eighth as the beat)', () => {
    const score = parseScore('time: 6/8\ntempo: 120\n| C4e D4e E4e |');
    const { events, secPerQuarter } = buildSchedule(score);
    // beatValue 8: quarter-beat = (60/120)·(8/4) = 1.0 s, so an eighth = 0.5 s.
    expect(secPerQuarter).toBeCloseTo(1.0, 6);
    expect(events.map((e) => e.durSec)).toEqual([0.5, 0.5, 0.5]);
    expect(events.map((e) => e.startSec)).toEqual([0, 0.5, 1.0]);
  });

  it('falls back to the score tempo, then DEFAULT_BPM, then a bpm override', () => {
    const noTempo = parseScore('time: 4/4\n| C4q |');
    expect(buildSchedule(noTempo).bpm).toBe(DEFAULT_BPM);
    const withTempo = parseScore('time: 4/4\ntempo: 68\n| C4q |');
    expect(buildSchedule(withTempo).bpm).toBe(68);
    expect(buildSchedule(withTempo, 140).bpm).toBe(140); // override wins
  });
});

// --- Player (stubbed Web Audio) --------------------------------------------
// jsdom has no Web Audio. A minimal fake AudioContext records created
// oscillators and exposes a controllable clock so we can drive the lookahead
// scheduler deterministically with fake timers.
const audio = { now: 0, oscillators: [] };
const fakeParam = () => ({ setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} });
function FakeAudioContext() {
  return {
    state: 'running',
    resume: () => Promise.resolve(),
    get currentTime() { return audio.now; },
    destination: { id: 'destination' },
    createOscillator() {
      const osc = {
        type: '', frequency: fakeParam(), onended: null, started: null, stopped: null,
        connect: (t) => t, start(t) { this.started = t; }, stop(t) { this.stopped = t; },
      };
      audio.oscillators.push(osc);
      return osc;
    },
    createGain() { return { gain: fakeParam(), connect: (t) => t }; },
  };
}

const drive = (toSec) => {
  for (let t = 0; t <= toSec; t += 0.1) { audio.now = Number(t.toFixed(3)); vi.advanceTimersByTime(100); }
};

describe('createScorePlayer', () => {
  beforeEach(() => {
    audio.now = 0;
    audio.oscillators = [];
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  const SCORE = parseScore('time: 4/4\ntempo: 120\n| C4q D4q E4q rq |');

  it('schedules an oscillator per pitched note (rests make no tone)', async () => {
    const player = createScorePlayer(SCORE, { bpm: 120 });
    await player.play();
    drive(3); // run past totalSec (2 s) so every note schedules
    expect(audio.oscillators).toHaveLength(3); // C, D, E — the rest is silent
    player.stop();
  });

  it('emits the now-sounding note index, then null at the end', async () => {
    const seen = [];
    const ended = vi.fn();
    const player = createScorePlayer(SCORE, { bpm: 120, onNote: (i) => seen.push(i), onEnded: ended });
    await player.play();
    drive(3);
    expect(seen).toContain(0);
    expect(seen).toContain(2);
    expect(seen[seen.length - 1]).toBeNull(); // playhead cleared at finish
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('stop() cancels the lookahead interval and stops live nodes', async () => {
    const player = createScorePlayer(SCORE, { bpm: 120 });
    await player.play();
    expect(audio.oscillators.length).toBeGreaterThan(0);
    const first = audio.oscillators[0];
    const scheduledSoFar = audio.oscillators.length;
    player.stop();
    expect(first.stopped).not.toBeNull(); // the live node was stopped
    drive(3); // interval is cleared → no further notes get scheduled
    expect(audio.oscillators).toHaveLength(scheduledSoFar);
    expect(player.isPlaying()).toBe(false);
  });

  it('does nothing (and reports ended) for a score with no notes', async () => {
    const ended = vi.fn();
    const player = createScorePlayer(parseScore('time: 4/4\n|  |'), { onEnded: ended });
    await player.play();
    expect(audio.oscillators).toHaveLength(0);
    expect(ended).toHaveBeenCalled();
  });
});
