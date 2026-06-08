// Resume-window race guard for the score players. Lives in its own file because
// the module memoizes one shared AudioContext on first use — a fresh module
// registry (per Vitest file) lets the first play() create a *suspended* context
// whose resume() we can leave pending, reproducing the teardown-during-await race
// that the playToken guard fixes. See createScorePlayer / createMultiScorePlayer.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseScore } from './scoreNotation.js';
import { createScorePlayer, createMultiScorePlayer } from './scorePlayback.js';

const audio = { now: 0, oscillators: [] };
const fakeParam = () => ({ setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} });

// A context that starts suspended and only resumes when we resolve the deferred
// returned by resume() — so a test can interleave a stop()/pause() between play()'s
// `await ctx.resume()` and its continuation.
let resolveResume;
function SuspendedAudioContext() {
  return {
    state: 'suspended',
    resume() { return new Promise((r) => { resolveResume = r; }); },
    get currentTime() { return audio.now; },
    destination: { id: 'destination' },
    createOscillator() {
      const osc = { type: '', frequency: fakeParam(), onended: null, started: null, stopped: null,
        connect: (t) => t, start(t) { this.started = t; }, stop(t) { this.stopped = t; } };
      audio.oscillators.push(osc);
      return osc;
    },
    createGain() { return { gain: fakeParam(), connect: (t) => t }; },
  };
}

describe('resume-window teardown race', () => {
  beforeEach(() => {
    audio.now = 0;
    audio.oscillators = [];
    resolveResume = undefined;
    vi.stubGlobal('AudioContext', SuspendedAudioContext);
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  const SCORE = parseScore('time: 4/4\ntempo: 120\n| C4q D4q E4q F4q |');

  it('createScorePlayer: stop() during the resume await aborts play() (no scheduler armed)', async () => {
    const player = createScorePlayer(SCORE, { bpm: 120 });
    const playing = player.play(); // suspends on ctx.resume()
    player.stop();                 // teardown lands mid-await — bumps the token
    resolveResume();               // resume resolves; play() must see the stale token and bail
    await playing;
    audio.now = 5; vi.advanceTimersByTime(5000); // no interval should be running
    expect(player.isPlaying()).toBe(false);
    expect(audio.oscillators).toHaveLength(0); // nothing scheduled by the aborted play
  });

  it('createMultiScorePlayer: stop() during the resume await aborts play() (no orphaned interval)', async () => {
    const player = createMultiScorePlayer([{ id: 'melody', score: SCORE }], { bpm: 120 });
    const playing = player.play();
    player.stop();
    resolveResume();
    await playing;
    audio.now = 5; vi.advanceTimersByTime(5000);
    expect(player.isPlaying()).toBe(false);
    expect(audio.oscillators).toHaveLength(0);
  });
});
