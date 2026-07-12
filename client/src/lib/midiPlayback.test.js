import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMidiPlayer } from './midiPlayback.js';
import { createFakeAudio } from '../test/fakeAudioContext.js';

// Shared Web Audio fake (controllable clock + recorded oscillators/gains) so
// the lookahead scheduler can be driven deterministically with fake timers.
// One pair for the whole file — lib/audioContext.js caches the context.
const { FakeAudioContext, audio } = createFakeAudio();

// Advance the audio clock RELATIVELY (unlike scorePlayback.test.js's absolute
// drive) — several cases here pause/seek and drive again, and an absolute
// drive would rewind currentTime.
const drive = (deltaSec) => {
  const target = audio.now + deltaSec;
  for (let t = audio.now + 0.1; t <= target + 1e-9; t += 0.1) {
    audio.now = Number(t.toFixed(3));
    vi.advanceTimersByTime(100);
  }
};

// C-E-G in sequence, then a long sustained C3 under the last note — 2 s total.
const DATA = {
  durationSec: 2,
  notes: [
    { id: 'a', midi: 60, startSec: 0, durationSec: 0.5, velocity: 1.0, track: 0 },
    { id: 'b', midi: 64, startSec: 0.5, durationSec: 0.5, velocity: 0.0, track: 0 },
    { id: 'c', midi: 48, startSec: 0.5, durationSec: 1.5, velocity: 0.8, track: 0 },
    { id: 'd', midi: 67, startSec: 1.0, durationSec: 1.0, velocity: 0.8, track: 0 },
  ],
};

describe('createMidiPlayer', () => {
  beforeEach(() => {
    audio.reset();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('schedules an oscillator per note and finishes with onEnded + position reset', async () => {
    const ended = vi.fn();
    const player = createMidiPlayer(DATA, { onEnded: ended });
    await player.play();
    drive(3); // run past durationSec (2 s)
    expect(audio.oscillators).toHaveLength(4);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(player.isPlaying()).toBe(false);
    expect(player.position()).toBe(0); // natural end resets to the top
  });

  it('scales the tone peak by velocity (louder note ramps to a higher gain)', async () => {
    const player = createMidiPlayer(DATA);
    await player.play();
    drive(1);
    // Per-tone gains follow the per-play master gain in creation order. The
    // envelope's peak value appears in the recorded param values.
    const [, loud, quiet] = audio.gains; // [master, note a (vel 1.0), note b (vel 0.0), ...]
    expect(Math.max(...loud.gain.values)).toBeGreaterThan(Math.max(...quiet.gain.values));
    player.stop();
  });

  it('pause remembers the position and play resumes from it', async () => {
    const player = createMidiPlayer(DATA);
    await player.play();
    drive(1.0);
    player.pause();
    expect(player.isPlaying()).toBe(false);
    const at = player.position();
    expect(at).toBeGreaterThan(0.5);
    const before = audio.oscillators.length;
    drive(2.0); // interval cleared — nothing further schedules
    expect(audio.oscillators).toHaveLength(before);
    await player.play();
    // Right after resume the position sits at the pause point minus the LEAD
    // pre-roll (position() is deliberately not clamped during the lead-in).
    expect(player.position()).toBeGreaterThan(at - 0.12);
    expect(player.position()).toBeLessThanOrEqual(at);
    player.stop();
  });

  it('stop() cancels the lookahead interval and silences live nodes', async () => {
    const player = createMidiPlayer(DATA);
    await player.play();
    const first = audio.oscillators[0];
    const scheduledSoFar = audio.oscillators.length;
    player.stop();
    expect(first.stopped).not.toBeNull();
    drive(3);
    expect(audio.oscillators).toHaveLength(scheduledSoFar);
    expect(player.position()).toBe(0);
  });

  it('seek while idle moves the resume point; play sounds the sustaining tails', async () => {
    const player = createMidiPlayer(DATA);
    player.seek(1.2); // mid-way through notes c (0.5–2.0) and d (1.0–2.0)
    expect(player.position()).toBeCloseTo(1.2, 6);
    await player.play();
    // Tails of c and d sound immediately even though their onsets are past.
    expect(audio.oscillators.length).toBeGreaterThanOrEqual(2);
    drive(0.1);
    // Notes a and b (fully before the seek point) never schedule.
    const freqs = audio.oscillators.flatMap((o) => o.frequency.values);
    expect(freqs.some((f) => Math.abs(f - 261.626) < 0.01)).toBe(false); // C4 (note a)
    player.stop();
  });

  it('seek while playing re-anchors the transport at the new position', async () => {
    const player = createMidiPlayer(DATA);
    await player.play();
    drive(0.3);
    player.seek(1.5);
    expect(player.position()).toBeCloseTo(1.5, 3);
    expect(player.isPlaying()).toBe(true);
    drive(1.0); // 0.5 s of playback left → natural finish
    expect(player.isPlaying()).toBe(false);
  });

  it('clamps a seek beyond the file to its duration', () => {
    const player = createMidiPlayer(DATA);
    player.seek(99);
    expect(player.position()).toBe(2);
    player.seek(-5);
    expect(player.position()).toBe(0);
  });

  it('backs the master bus off for dense polyphony so the sum cannot clip', async () => {
    const chord = {
      durationSec: 1,
      notes: Array.from({ length: 8 }, (_, i) => (
        { id: String(i), midi: 60 + i, startSec: 0, durationSec: 1, velocity: 1, track: 0 }
      )),
    };
    const player = createMidiPlayer(chord);
    await player.play();
    const masterLevel = audio.gains[0].gain.values[0];
    // 8 simultaneous full-velocity tones at TONE_PEAK 0.16 each: the summed
    // peak must stay under the 0.9 headroom ceiling (a fixed master gain
    // would put it at 8 × 0.16 × 0.9 ≈ 1.15 — audible clipping).
    expect(masterLevel * 8 * 0.16).toBeLessThanOrEqual(0.91);
    player.stop();

    // A sparse file keeps the full level — no needless quieting.
    audio.reset();
    const sparse = createMidiPlayer(DATA); // peak polyphony 2
    await sparse.play();
    expect(audio.gains[0].gain.values[0]).toBe(0.9);
    sparse.stop();
  });

  it('reports ended immediately for an empty view-model', async () => {
    const ended = vi.fn();
    const player = createMidiPlayer({ durationSec: 0, notes: [] }, { onEnded: ended });
    await player.play();
    expect(audio.oscillators).toHaveLength(0);
    expect(ended).toHaveBeenCalledTimes(1);
  });
});
