// @vitest-environment node

// Resume-window race guard for the score players. Lives in its own file because
// the module memoizes one shared AudioContext on first use — a fresh module
// registry (per Vitest file) lets the first play() create a *suspended* context
// whose resume() we can leave pending, reproducing the teardown-during-await race
// that the playToken guard fixes. See createScorePlayer / createMultiScorePlayer.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseScore } from './scoreNotation.js';
import { createScorePlayer, createMultiScorePlayer } from './scorePlayback.js';
import { createLookaheadTransport } from './lookaheadTransport.js';
import { createFakeAudio } from '../test/fakeAudioContext.js';

// The shared fake started suspended only resolves resume() when we call
// audio.flushResume() — so a test can interleave a stop()/pause() between
// play()'s `await ctx.resume()` and its continuation, reproducing the
// teardown-during-await race the playToken guard fixes. One pair for the whole
// file (lib/audioContext.js caches the context).
const { FakeAudioContext, audio } = createFakeAudio({ state: 'suspended' });

describe('resume-window teardown race', () => {
  beforeEach(() => {
    audio.reset();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  const SCORE = parseScore('time: 4/4\ntempo: 120\n| C4q D4q E4q F4q |');

  it('createScorePlayer: stop() during the resume await aborts play() (no scheduler armed)', async () => {
    const player = createScorePlayer(SCORE, { bpm: 120 });
    const playing = player.play(); // suspends on ctx.resume()
    player.stop();                 // teardown lands mid-await — bumps the token
    audio.flushResume();           // resume resolves; play() must see the stale token and bail
    await playing;
    audio.now = 5; vi.advanceTimersByTime(5000); // no interval should be running
    expect(player.isPlaying()).toBe(false);
    expect(audio.oscillators).toHaveLength(0); // nothing scheduled by the aborted play
  });

  it('createMultiScorePlayer: stop() during the resume await aborts play() (no orphaned interval)', async () => {
    const player = createMultiScorePlayer([{ id: 'melody', score: SCORE }], { bpm: 120 });
    const playing = player.play();
    player.stop();
    audio.flushResume();
    await playing;
    audio.now = 5; vi.advanceTimersByTime(5000);
    expect(player.isPlaying()).toBe(false);
    expect(audio.oscillators).toHaveLength(0);
  });
});

// The audio-session declaration rides the same resume window, and the document
// is shared with the views that open the microphone — so a declaration that
// outlives the sound it was made for is a dead mic, not just a stray flag.
describe('audio session across the resume window', () => {
  beforeEach(() => {
    audio.reset();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('navigator', { audioSession: { type: 'auto' } });
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  const transport = () => createLookaheadTransport({
    getTotalSec: () => 10, scheduleWindow: () => {}, audioSession: 'playback',
  });

  it('releases when pause() cancels a play still awaiting its resume', async () => {
    // pause() short-circuits on `!playing`, so no teardown runs for the play it
    // just cancelled — without an explicit release there, tapping Play then Pause
    // leaves the whole document pinned output-only.
    const t = transport();
    const playing = t.play();
    expect(globalThis.navigator.audioSession.type).toBe('playback');
    t.pause();
    audio.flushResume();
    await playing;
    expect(t.isPlaying()).toBe(false);
    expect(globalThis.navigator.audioSession.type).toBe('auto');
  });

  it('releases when the resume itself rejects', async () => {
    // Autoplay policy (or a session iOS won't hand back) rejects the resume, and
    // that exits play() before any teardown — so without an explicit release the
    // failed play leaves the document pinned output-only for good. The rejection
    // must still reach the caller, which resets its Play button on it.
    audio.resumeRejection = new Error('not allowed');
    const t = transport();
    await expect(t.play()).rejects.toThrow('not allowed');
    expect(t.isPlaying()).toBe(false);
    expect(globalThis.navigator.audioSession.type).toBe('auto');
  });

  it('does not release out from under a newer play that took over mid-await', async () => {
    // The superseded play() must bail WITHOUT releasing: the newer one already
    // re-declared the session and is about to sound against it.
    const t = transport();
    const first = t.play();
    const second = t.play();   // supersedes the first (playing is still false)
    audio.flushResume();
    await Promise.all([first, second]);
    expect(t.isPlaying()).toBe(true);
    expect(globalThis.navigator.audioSession.type).toBe('playback');
    t.stop();
    expect(globalThis.navigator.audioSession.type).toBe('auto');
  });
});
