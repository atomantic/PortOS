import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseDrumChart } from './drumNotation.js';
import { createDrumPlayer } from './drumPlayback.js';
import { createFakeAudio } from '../test/fakeAudioContext.js';

// The AUDIBLE half of drumPlayback.js — buildDrumSchedule's pure math is covered
// in drumPlayback.test.js with no Web Audio at all. This suite drives the real
// lookahead transport against the shared Web Audio fake, so the wiring (voices
// actually scheduled, playhead callbacks, loop rebase, teardown) is pinned.
//
// One fake pair for the whole file — lib/audioContext.js caches the context.
const { FakeAudioContext, audio } = createFakeAudio();

// Advance the audio clock relatively, ticking the lookahead interval alongside.
const drive = (deltaSec) => {
  const target = audio.now + deltaSec;
  for (let t = audio.now + 0.05; t <= target + 1e-9; t += 0.05) {
    audio.now = Number(t.toFixed(4));
    vi.advanceTimersByTime(50);
  }
};

// Invented groove (privacy convention): 2 bars, subdivision 1 (one cell/beat) at
// 240 bpm → 0.25s/beat, 1s/bar, so the whole chart is 2s.
const CHART = parseDrumChart(`time: 4/4
tempo: 240
subdivision: 1

# A
HH: xxxx
K: o-o-

# B
S: x-x-`);

describe('createDrumPlayer', () => {
  beforeEach(() => {
    audio.reset();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('sounds a voice per hit and finishes with onEnded', async () => {
    const ended = vi.fn();
    const player = createDrumPlayer(CHART, { onEnded: ended });
    await player.play();
    drive(3);
    // 4 hats + 2 kicks + 2 snares = 8 hits. The snare voice layers a body tone,
    // so voices ≥ hits — what matters is that every hit sounded.
    expect(audio.oscillators.length).toBeGreaterThanOrEqual(8);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(player.isPlaying()).toBe(false);
  });

  it('uses bandpassed noise for cymbals/snare and a pitched sweep for the kick', async () => {
    const player = createDrumPlayer(parseDrumChart('tempo: 240\nsubdivision: 1\n\nHH: x---\nK: -o--'), {});
    await player.play();
    drive(2);
    // The hat is a filtered noise burst; the kick is a sine sweep (no filter).
    expect(audio.filters.length).toBe(1);
    expect(audio.filters[0].type).toBe('bandpass');
    expect(audio.oscillators.some((o) => o.noise)).toBe(true);
    expect(audio.oscillators.some((o) => !o.noise)).toBe(true);
  });

  it('scales voice gain by the glyph velocity (accent louder than ghost)', async () => {
    const player = createDrumPlayer(parseDrumChart('tempo: 240\nsubdivision: 1\n\nHH: X-g-'), {});
    await player.play();
    drive(2);
    const peaks = audio.gains.map((g) => Math.max(...g.gain.values, 0));
    // [master, accent, ghost] in creation order — the accent must be louder.
    expect(peaks[1]).toBeGreaterThan(peaks[2]);
    player.stop();
  });

  it('reports the playhead per grid position, once per bar+step', async () => {
    const steps = [];
    const player = createDrumPlayer(CHART, { onStep: (info) => steps.push(info) });
    await player.play();
    drive(3);
    const positions = steps.filter(Boolean).map((s) => `${s.bar}:${s.step}`);
    // Simultaneous hats+kick at bar 1 step 0 collapse to ONE callback.
    expect(positions[0]).toBe('1:0');
    expect(new Set(positions).size).toBe(positions.length);
    expect(positions).toContain('2:0');
    // The final callback clears the playhead.
    expect(steps.at(-1)).toBeNull();
  });

  it('reports count-in beats as countIn with no bar/step', async () => {
    const steps = [];
    const player = createDrumPlayer(CHART, { countInBars: 1, onStep: (i) => steps.push(i) });
    await player.play();
    drive(0.6); // still inside the 1s count-in bar
    const counted = steps.filter((s) => s?.countIn);
    expect(counted.length).toBeGreaterThan(0);
    expect(counted[0]).toMatchObject({ bar: null, step: null, countIn: true });
    player.stop();
  });

  it('loops a bar range without ending and without re-counting-in', async () => {
    const ended = vi.fn();
    const steps = [];
    const player = createDrumPlayer(CHART, {
      loopBars: { from: 2, to: 2 }, countInBars: 1, onEnded: ended, onStep: (i) => steps.push(i),
    });
    await player.play();
    drive(6); // several passes over a 1-bar loop
    expect(ended).not.toHaveBeenCalled();
    expect(player.isPlaying()).toBe(true);
    // Only bar 2 ever sounds; the count-in happens exactly once.
    const music = steps.filter((s) => s && !s.countIn);
    expect(new Set(music.map((s) => s.bar))).toEqual(new Set([2]));
    expect(music.length).toBeGreaterThan(3); // looped, not a single pass
    player.stop();
  });

  it('layers a click when enabled and not when disabled', async () => {
    const quiet = createDrumPlayer(CHART, {});
    await quiet.play();
    drive(2.5);
    const withoutClick = audio.oscillators.length;
    quiet.stop();

    audio.reset();
    const clicked = createDrumPlayer(CHART, { clickEnabled: true });
    await clicked.play();
    drive(2.5);
    // 8 beats of click over the two bars.
    expect(audio.oscillators.length).toBeGreaterThan(withoutClick);
    clicked.stop();
  });

  it('stop() clears the interval, silences live voices and clears the playhead', async () => {
    const steps = [];
    const player = createDrumPlayer(CHART, { onStep: (i) => steps.push(i) });
    await player.play();
    drive(0.5);
    const scheduled = audio.oscillators.length;
    expect(scheduled).toBeGreaterThan(0);
    player.stop();
    expect(steps.at(-1)).toBeNull();
    // Every voice was stopped, and nothing further schedules.
    expect(audio.oscillators.every((o) => o.stopped !== null)).toBe(true);
    drive(3);
    expect(audio.oscillators).toHaveLength(scheduled);
    expect(player.isPlaying()).toBe(false);
  });

  it('setBpm while idle re-times the schedule; a faster tempo is shorter', async () => {
    const player = createDrumPlayer(CHART, {});
    expect(player.schedule().totalSec).toBeCloseTo(2, 5); // 240 bpm written
    player.setBpm(120);
    expect(player.schedule().totalSec).toBeCloseTo(4, 5);
    player.setBpm(240);
    expect(player.schedule().totalSec).toBeCloseTo(2, 5);
  });

  it('setLoop while idle narrows the schedule to the range', () => {
    const player = createDrumPlayer(CHART, {});
    expect(player.schedule().bars).toHaveLength(2);
    player.setLoop({ from: 2, to: 2 });
    expect(player.schedule().bars.map((b) => b.index)).toEqual([2]);
    player.setLoop(null);
    expect(player.schedule().bars).toHaveLength(2);
  });

  it('setCountIn while idle prepends the lead-in', () => {
    const player = createDrumPlayer(CHART, {});
    expect(player.schedule().countInSec).toBe(0);
    player.setCountIn(2);
    expect(player.schedule().countInSec).toBeCloseTo(2, 5); // two 1s bars
  });

  it('an empty chart reports ended immediately and schedules nothing', async () => {
    const ended = vi.fn();
    const player = createDrumPlayer(parseDrumChart(''), { onEnded: ended });
    await player.play();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(audio.oscillators).toHaveLength(0);
    expect(player.isPlaying()).toBe(false);
  });

  it('loops a single-bar range without spinning', async () => {
    const player = createDrumPlayer(parseDrumChart('subdivision: 1\n\nHH: x---'), {
      loopBars: { from: 1, to: 1 }, countInBars: 0,
    });
    await player.play();
    drive(2);
    expect(player.isPlaying()).toBe(true);
    player.stop();
  });

  it('finishes (never wedges) when the looped bar is all rests', async () => {
    // Two coupled guards, both keyed on canLoop(): the scheduler must not spin its
    // pass-rebase branch on a range with no music events (a rest-only bar has real
    // duration but nothing to repeat), AND the transport must not report an
    // Infinite length for it — otherwise playback sits "playing" forever after the
    // count-in. The chart's OTHER bar has hits, so Play is enabled.
    const ended = vi.fn();
    const chart = parseDrumChart('tempo: 240\nsubdivision: 1\n\n# A\nK: o---\n\n# B\nK: ----');
    const player = createDrumPlayer(chart, {
      loopBars: { from: 2, to: 2 }, countInBars: 1, onEnded: ended,
    });
    await player.play();
    drive(3); // would never return if the rebase spun
    expect(audio.oscillators.length).toBeGreaterThan(0); // the count-in still sounds
    expect(ended).toHaveBeenCalledTimes(1);
    expect(player.isPlaying()).toBe(false);
  });
});
