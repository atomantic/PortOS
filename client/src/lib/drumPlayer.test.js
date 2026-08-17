// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseDrumChart } from './drumNotation.js';
import { createDrumPlayer } from './drumPlayback.js';
import { parseScore } from './scoreNotation.js';
import { createScorePlayer } from './scorePlayback.js';
import { acquireAudioSession } from './audioContext.js';
import { createFakeAudio } from '../test/fakeAudioContext.js';

// The AUDIBLE half of drumPlayback.js — buildDrumSchedule's pure math is covered
// in drumPlayback.test.js with no Web Audio at all. This suite drives the real
// lookahead transport against the shared Web Audio fake, so the wiring (voices
// actually scheduled, playhead callbacks, loop rebase, teardown) is pinned.
//
// One fake pair for the whole file — lib/audioContext.js caches the context.
const { FakeAudioContext, audio } = createFakeAudio();

// GainNodes the player builds before any voice: the drum master and the
// metronome's own click bus. Every later gain in `audio.gains` is a voice
// envelope, so tests that reason about voices skip these two.
const BUS_GAINS = 2;

// Metronome blips that actually sounded: CLICK_VOICE is a lone square starting
// at 1600 Hz, a frequency no kit voice uses (noise sources carry no `frequency`).
const clickBlips = () => audio.oscillators.filter((o) => o.frequency?.values[0] === 1600);

// A bus's current level: set outright when the bus is built, then glided with
// setTargetAtTime on a live change (which the fake records into `values`).
const busLevel = (bus) => (bus.gain.values.length ? bus.gain.values.at(-1) : bus.gain.value);

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

  it('uses filtered noise for the hat and a pitched sweep for the kick', async () => {
    const player = createDrumPlayer(parseDrumChart('tempo: 240\nsubdivision: 1\n\nHH: x---\nK: -o--'), {});
    await player.play();
    drive(2);
    // The hat is a filtered noise burst; the kick's body is a pitched oscillator.
    expect(audio.oscillators.some((o) => o.noise)).toBe(true);
    expect(audio.filters.length).toBeGreaterThan(0);
    const swept = audio.oscillators.filter((o) => !o.noise && o.frequency.values.length > 1);
    expect(swept.length).toBeGreaterThan(0);
    // Every sweep DROPS in pitch — a membrane falling to its fundamental.
    expect(swept.every((o) => o.frequency.values[1] < o.frequency.values[0])).toBe(true);
  });

  it('drops the kick pitch far faster than its amplitude decays', async () => {
    // The punch fix: the pitch envelope and the amplitude envelope are separate.
    // A kick whose sweep runs the full length of its tail is the weak-sounding
    // recipe this replaced, so the two are pinned apart here rather than left to
    // whichever numbers a kit happens to carry.
    const player = createDrumPlayer(parseDrumChart('tempo: 240\nsubdivision: 1\n\nK: o---'), {});
    await player.play();
    drive(0.2);
    const body = audio.oscillators.find((o) => !o.noise && o.frequency.values.length > 1);
    expect(body).toBeDefined();
    // stop() is scheduled at attack + decay + 0.02 — a proxy for the amp tail.
    const ampTail = body.stopped - body.started;
    expect(ampTail).toBeGreaterThan(0.3);
    // …and the sweep lands in the first tenth of it (~30–60ms in every kit).
    expect(body.frequency.values[1]).toBeLessThan(body.frequency.values[0] / 2);
    player.stop();
  });

  it('routes the kick body through a drive shaper, and the bus through a clipper', async () => {
    // A sub-50Hz sine is inaudible on a phone speaker; the drive shaper supplies
    // the harmonics that make it read. Both shapers are load-bearing for the
    // "the kick sounds weak" fix, so both are pinned — structurally, off the
    // fake's recorded connections rather than off node creation order.
    const player = createDrumPlayer(parseDrumChart('tempo: 240\nsubdivision: 1\n\nK: o---'), {});
    await player.play();
    drive(0.2);
    const body = audio.oscillators.find((o) => !o.noise && o.frequency.values.length > 1);
    expect(audio.shapers).toContain(body.connections[0]);
    // The master gain feeds a shaper, which feeds the destination.
    const busShaper = audio.shapers.find((s) => s.connections.some((t) => t?.id === 'destination'));
    expect(busShaper).toBeDefined();
    expect(audio.gains.some((g) => g.connections.includes(busShaper))).toBe(true);
    // Every curve is a real saturation curve: bounded to ±1 and monotonic.
    for (const shaper of audio.shapers) {
      expect(shaper.curve.length).toBeGreaterThan(0);
      expect(Math.max(...shaper.curve)).toBeLessThanOrEqual(1);
      expect(Math.min(...shaper.curve)).toBeGreaterThanOrEqual(-1);
      expect(shaper.curve.every((v, i, a) => i === 0 || v >= a[i - 1])).toBe(true);
    }
    player.stop();
  });

  it('scales voice gain by the glyph velocity (accent louder than ghost)', async () => {
    const player = createDrumPlayer(parseDrumChart('tempo: 240\nsubdivision: 1\n\nHH: X-g-'), {});
    await player.play();
    drive(2);
    // Creation order is [master, click bus, ...accent layers, ...ghost layers] —
    // the two buses are built up front in prepare(), and a voice can be several
    // layers (the 808 hat is a six-oscillator cluster), so compare the two halves
    // rather than two fixed indices.
    const peaks = audio.gains.slice(BUS_GAINS).map((g) => Math.max(...g.gain.values, 0));
    const half = peaks.length / 2;
    expect(Number.isInteger(half)).toBe(true);
    expect(Math.max(...peaks.slice(0, half))).toBeGreaterThan(Math.max(...peaks.slice(half)));
    player.stop();
  });

  it('setKit swaps the voices live, without stopping playback', async () => {
    const player = createDrumPlayer(parseDrumChart('tempo: 120\nsubdivision: 1\n\nHH: xxxx'), {});
    await player.play();
    drive(0.5);
    // The default 909 hat is one noise burst.
    expect(audio.oscillators.every((o) => o.noise)).toBe(true);
    player.setKit('808');
    drive(1);
    // The 808's is a square cluster — so the swap shows up as pitched sources
    // appearing mid-run, and playback never stopped to do it.
    expect(audio.oscillators.some((o) => !o.noise)).toBe(true);
    expect(player.isPlaying()).toBe(true);
    player.stop();
  });

  it('shares one filter and envelope across a square cluster', async () => {
    // The 808 hat is six oscillators; they must sum into ONE filter + gain (a
    // biquad is linear, so per-partial filters would be six times the nodes for
    // an identical signal) while each partial stays individually stoppable.
    const player = createDrumPlayer(parseDrumChart('tempo: 240\nsubdivision: 1\n\nHH: x---'), {
      kit: '808',
    });
    await player.play();
    drive(0.2);
    expect(audio.oscillators.length).toBeGreaterThan(1);
    expect(audio.filters).toHaveLength(1);
    expect(audio.gains).toHaveLength(BUS_GAINS + 1); // the buses + one voice envelope
    for (const osc of audio.oscillators) expect(osc.connections).toEqual([audio.filters[0]]);
    player.stop();
    // Every partial was stopped — one tracked entry per oscillator, so an open
    // hat or a 1.2s crash can't ring on after Stop.
    expect(audio.oscillators.every((o) => o.stopped !== null)).toBe(true);
  });

  it('falls back to the default kit for an unknown id rather than going silent', async () => {
    const player = createDrumPlayer(parseDrumChart('tempo: 240\nsubdivision: 1\n\nK: o---'), {
      kit: 'roland-tr-nope',
    });
    await player.play();
    drive(2);
    expect(audio.oscillators.length).toBeGreaterThan(0);
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

  it('sounds the click on its own bus, at the level it was built with', async () => {
    const player = createDrumPlayer(CHART, { clickEnabled: true, clickVolume: 0.4 });
    await player.play();
    drive(1);
    const [master, clickBus] = audio.gains;
    // The bus hangs off the drum master (so it still goes through the master
    // soft-clipper) and carries the level.
    expect(clickBus.connections).toEqual([master]);
    expect(busLevel(clickBus)).toBe(0.4);
    // Every click envelope feeds the bus, and no KIT voice does.
    const clickVoices = audio.gains.filter((g) => g.connections.includes(clickBus));
    expect(clickVoices.length).toBeGreaterThan(0);
    // Nothing on the master is also on the click bus — a kit voice riding the
    // click bus would duck with the metronome slider.
    const masterVoices = audio.gains.filter((g) => g.connections.includes(master));
    expect(masterVoices.some((g) => clickVoices.includes(g))).toBe(false);
    player.stop();
  });

  it('setClickVolume moves the bus live, without stopping playback', async () => {
    const player = createDrumPlayer(CHART, { clickEnabled: true });
    await player.play();
    drive(0.5);
    const clickBus = audio.gains[1];
    expect(busLevel(clickBus)).toBe(1); // default: unchanged from before
    // A bus move reaches clicks ALREADY scheduled in the lookahead window — that
    // is the whole reason the level isn't folded into each click's velocity.
    player.setClickVolume(0.25);
    expect(busLevel(clickBus)).toBe(0.25);
    expect(player.isPlaying()).toBe(true);
    // A garbled level is ignored rather than silencing the click.
    player.setClickVolume('nope');
    expect(busLevel(clickBus)).toBe(0.25);
    player.stop();
  });

  it('schedules no click voice at all once the level is zero', async () => {
    // Dragging the slider to 0 deliberately does NOT flip the mute toggle, and
    // the level persists — so a silent click that still built a voice per beat
    // would do that forever, on every chart, for nothing.
    const muted = createDrumPlayer(CHART, { clickEnabled: false });
    await muted.play();
    drive(2.5);
    const kitOnly = audio.oscillators.length;
    muted.stop();

    audio.reset();
    const zeroed = createDrumPlayer(CHART, { clickEnabled: true, clickVolume: 0 });
    await zeroed.play();
    drive(2.5);
    // Level 0 costs exactly what muting costs: not one extra node, and not one
    // click blip.
    expect(audio.oscillators).toHaveLength(kitOnly);
    expect(clickBlips()).toHaveLength(0);
    zeroed.stop();

    // Turning it back up mid-run resumes the click without a restart.
    audio.reset();
    const raised = createDrumPlayer(CHART, { clickEnabled: true, clickVolume: 0 });
    await raised.play();
    drive(0.5);
    expect(clickBlips()).toHaveLength(0);
    raised.setClickVolume(1);
    drive(1);
    expect(clickBlips().length).toBeGreaterThan(0);
    raised.stop();
  });

  it('counts in with the metronome click, not with the kit snare', async () => {
    // `sound: 'click'` is not a kit piece — left to kitVoiceLayers it falls
    // through to the SNARE, which made a count-in four snare hits.
    const player = createDrumPlayer(parseDrumChart('tempo: 240\nsubdivision: 1\n\nK: o---'), {
      countInBars: 1, clickEnabled: false, clickVolume: 0.5,
    });
    await player.play();
    drive(1.2); // the 1s count-in bar, then the kick on bar 1
    const clickBus = audio.gains[1];
    // Four click blips, one per count-in beat, each routed through the bus.
    const blips = clickBlips();
    expect(blips).toHaveLength(4);
    expect(audio.gains.filter((g) => g.connections.includes(clickBus))).toHaveLength(4);
    // The count-in sounds even with the through-music click muted ("just count
    // me in"), and the kick still lands on the kit master.
    expect(audio.oscillators.length).toBeGreaterThan(blips.length);
    player.stop();
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

  // The two iOS Safari failures that made the whole play-along silent on an
  // iPhone while the transport counted and the playhead scrolled.
  describe('on iOS Safari', () => {
    beforeEach(() => { vi.stubGlobal('navigator', { audioSession: { type: 'auto' } }); });

    it("resumes an 'interrupted' context instead of playing against a dead clock", async () => {
      // A call / Siri / the screen locking parks the context here. The old gate
      // read `state === 'suspended'`, walked past this, and armed the scheduler
      // against a clock that never advanced.
      audio.state = 'interrupted';
      const player = createDrumPlayer(CHART, {});
      const playing = player.play(); // parks on ctx.resume()
      expect(audio.resumeCalls).toBe(1);
      audio.flushResume();
      await playing;

      expect(player.isPlaying()).toBe(true);
      drive(1.5);
      expect(audio.oscillators.length).toBeGreaterThan(0);
      player.stop();
    });

    it('holds the playback audio session while sounding so the silent switch cannot mute it', async () => {
      const player = createDrumPlayer(CHART, {});
      await player.play();
      expect(globalThis.navigator.audioSession.type).toBe('playback');
      player.stop();
    });

    // The declaration is document-wide and marks the page output-only, so
    // holding it past playback would follow the user (SPA — no reload) onto the
    // Songs training views and kill their microphone.
    it('hands the session back on stop', async () => {
      const player = createDrumPlayer(CHART, {});
      await player.play();
      player.stop();
      expect(globalThis.navigator.audioSession.type).toBe('auto');
    });

    // The VoiceWidget is mounted on every page (Layout.jsx), so push-to-talk can
    // open the mic while a chart is playing. `playback` REFUSES capture, so the
    // arbiter has to promote — otherwise the fix for this page's silence would
    // have made the mic dead on it instead.
    it('yields to a mic opened mid-playback, then takes playback back', async () => {
      const player = createDrumPlayer(CHART, {});
      await player.play();
      const releaseMic = acquireAudioSession('play-and-record');
      expect(globalThis.navigator.audioSession.type).toBe('play-and-record');
      releaseMic();
      expect(globalThis.navigator.audioSession.type).toBe('playback');
      player.stop();
      expect(globalThis.navigator.audioSession.type).toBe('auto');
    });

    it('hands the session back when the chart ends on its own', async () => {
      const player = createDrumPlayer(CHART, {});
      await player.play();
      drive(3); // CHART is 2s — runs to its natural end
      expect(player.isPlaying()).toBe(false);
      expect(globalThis.navigator.audioSession.type).toBe('auto');
    });
  });
});

// Players hosted on pages that ALSO record must not declare an output-only
// session — the mic would go dead. Only a player that opts in via the
// transport's `audioSession` option touches it.
describe('players that do not opt into an audio session', () => {
  beforeEach(() => {
    audio.reset();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('navigator', { audioSession: { type: 'auto' } });
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('leaves the document audio session alone', async () => {
    const player = createScorePlayer(parseScore('tempo: 120\n| C4q D4q |'), { bpm: 120 });
    await player.play();
    expect(globalThis.navigator.audioSession.type).toBe('auto');
    player.stop();
  });
});
