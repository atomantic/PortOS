// @vitest-environment node

// Schedule + audio-session tests for the chiptune preview (#2911). Most of this
// file exercises the Web-Audio-free exports (buildChiptuneSchedule /
// parseChiptunePitch); the timing semantics there MUST agree with
// server/lib/chiptuneScore.test.js — the two flatteners are mirrors of the same
// contract. The last block drives the real player over the shared Web Audio
// fake, purely to pin the iOS audio-session claim (#4131).
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { buildChiptuneSchedule, parseChiptunePitch, createChiptunePlayer } from './chiptunePlayback.js';
import { acquireAudioSession } from './audioContext.js';
import { createFakeAudio } from '../test/fakeAudioContext.js';

const score = () => ({
  version: 1,
  bpm: 120,
  stepsPerBeat: 4,
  beatsPerBar: 4,
  channels: [
    { id: 'pulse1', wave: 'square', duty: 0.25, gain: 0.5 },
    { id: 'noise', wave: 'noise', gain: 0.3 },
  ],
  patterns: {
    A: {
      bars: 1,
      notes: {
        pulse1: [{ step: 0, pitch: 'C5', len: 4, vel: 0.9 }],
        noise: [{ step: 8, pitch: 'snare', len: 1 }],
      },
    },
  },
  order: ['A', 'A'],
});

describe('parseChiptunePitch', () => {
  it('parses scientific pitch strings to MIDI', () => {
    expect(parseChiptunePitch('C4')).toBe(60);
    expect(parseChiptunePitch('A4')).toBe(69);
    expect(parseChiptunePitch('F#3')).toBe(54);
    expect(parseChiptunePitch('Bb2')).toBe(46);
    expect(parseChiptunePitch('snare')).toBeNull();
    expect(parseChiptunePitch('')).toBeNull();
  });
});

describe('buildChiptuneSchedule', () => {
  it('mirrors the server flatten: step-exact timing, back-to-back order', () => {
    const { events, stepSec, totalSec } = buildChiptuneSchedule(score());
    expect(stepSec).toBeCloseTo(0.125);
    expect(totalSec).toBeCloseTo(4); // 2 × 16 steps × 0.125s
    const tones = events.filter((e) => e.freq);
    expect(tones.map((e) => e.startSec)).toEqual([0, 2]);
    expect(tones[0].durSec).toBeCloseTo(0.5);
    expect(tones[0].duty).toBe(0.25);
    const drums = events.filter((e) => e.noise);
    expect(drums.map((e) => e.noise)).toEqual(['snare', 'snare']);
    expect(drums[0].startSec).toBeCloseTo(1);
  });

  it('drops out-of-pattern notes, clamps overhang, skips unresolvable pitches', () => {
    const s = score();
    s.patterns.A.notes.pulse1 = [
      { step: 20, pitch: 'C5', len: 2 },   // past the 16-step pattern → dropped
      { step: 14, pitch: 'D5', len: 8 },   // overhang → clamped to 2 steps
      { step: 2, pitch: 'xyz', len: 2 },   // unparseable → dropped
    ];
    s.patterns.A.notes.noise = [{ step: 0, pitch: 'C2', len: 1 }]; // not a preset → dropped
    const { events } = buildChiptuneSchedule(s);
    expect(events.filter((e) => e.noise)).toHaveLength(0);
    const tones = events.filter((e) => e.freq);
    expect(tones).toHaveLength(2); // the clamped D5, once per order entry
    expect(tones[0].durSec).toBeCloseTo(0.25);
  });

  it('degrades to an empty schedule on a missing/garbage score', () => {
    expect(buildChiptuneSchedule(null).events).toEqual([]);
    expect(buildChiptuneSchedule({}).events).toEqual([]);
    expect(buildChiptuneSchedule({ channels: [], order: [] }).totalSec).toBe(0);
  });
});

// The preview is pure synth with no media element, so on iOS the document's
// default `auto` session behaves as *ambient* — the hardware ring/silent switch
// silences it while the panel's playhead keeps scrolling, with nothing on screen
// to explain the silence. The player opts into `playback` through the shared
// transport; these pin that it claims while sounding and hands it back.
describe('createChiptunePlayer on iOS Safari', () => {
  const { FakeAudioContext, audio } = createFakeAudio();

  beforeEach(() => {
    audio.reset();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('navigator', { audioSession: { type: 'auto' } });
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  const player = () => createChiptunePlayer(() => score());

  it('holds the playback session while looping so the silent switch cannot mute it', async () => {
    const p = player();
    await p.play();
    expect(p.isPlaying()).toBe(true);
    expect(globalThis.navigator.audioSession.type).toBe('playback');
    p.stop();
  });

  it('hands the session back on stop', async () => {
    const p = player();
    await p.play();
    p.stop();
    expect(globalThis.navigator.audioSession.type).toBe('auto');
  });

  // The VoiceWidget is mounted on every page (Layout.jsx), so push-to-talk can
  // open the mic mid-preview. `playback` REFUSES capture, so the arbiter has to
  // promote — otherwise fixing the silence here would kill the mic instead.
  it('yields to a mic opened mid-preview, then takes playback back', async () => {
    const p = player();
    await p.play();
    const releaseMic = acquireAudioSession('play-and-record');
    expect(globalThis.navigator.audioSession.type).toBe('play-and-record');
    releaseMic();
    expect(globalThis.navigator.audioSession.type).toBe('playback');
    p.stop();
    expect(globalThis.navigator.audioSession.type).toBe('auto');
  });

  // An empty/garbage score aborts in prepare() and never sounds a note, so it
  // must not leave the document pinned output-only either.
  it('does not keep the session when there is nothing to play', async () => {
    const p = createChiptunePlayer(() => null);
    await p.play();
    expect(p.isPlaying()).toBe(false);
    expect(globalThis.navigator.audioSession.type).toBe('auto');
  });
});
