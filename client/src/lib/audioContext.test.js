// @vitest-environment node

// The shared-context helpers, with an emphasis on the two iOS Safari failures
// they exist for: a context parked in `'interrupted'` and an audio session left
// ambient (silenced by the hardware ring/silent switch).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { acquireAudioSession, resumeAudioContext } from './audioContext.js';

const stubNavigator = (audioSession) => {
  vi.stubGlobal('navigator', audioSession ? { audioSession } : {});
};

// A local stub rather than `createFakeAudio`: that one binds a single starting
// state per module instance (it backs a memoized shared context), and these
// tests need a different state per case.
const fakeCtx = (state) => {
  const c = { state, resumeCalls: 0 };
  c.resume = () => { c.resumeCalls += 1; c.state = 'running'; return Promise.resolve(); };
  return c;
};

describe('audio session arbiter', () => {
  // The arbiter's holder list is module state that outlives a test — by design,
  // since the session it tracks belongs to the document. So every claim a test
  // takes has to be handed back, or the next test starts with a stale holder
  // pinning the session. `acquire` records the releases; afterEach drains them.
  let releases = [];
  const acquire = (type) => {
    const release = acquireAudioSession(type);
    releases.push(release);
    return release;
  };

  beforeEach(() => { vi.unstubAllGlobals(); releases = []; });
  afterEach(() => {
    for (const release of releases) release();
    vi.unstubAllGlobals();
  });

  it('declares the claimed session so the silent switch cannot mute the synth', () => {
    const audioSession = { type: 'auto' };
    stubNavigator(audioSession);
    acquire('playback');
    expect(audioSession.type).toBe('playback');
  });

  it('goes back to auto when the last holder releases', () => {
    const audioSession = { type: 'auto' };
    stubNavigator(audioSession);
    const release = acquire('playback');
    release();
    expect(audioSession.type).toBe('auto');
  });

  // The whole reason this is arbitrated: the VoiceWidget is mounted on every
  // page, so a mic can open while a play-along is sounding. `playback` REFUSES
  // capture, so a naive last-writer-wins would kill the mic — `play-and-record`
  // satisfies both (it ignores the ring/silent switch too).
  it('lets a live capture outrank a play-along holding playback', () => {
    const audioSession = { type: 'auto' };
    stubNavigator(audioSession);
    const releasePlayer = acquire('playback');
    const releaseMic = acquire('play-and-record');
    expect(audioSession.type).toBe('play-and-record');
    // The play-along stopping must not drop the still-open mic to a weaker session.
    releasePlayer();
    expect(audioSession.type).toBe('play-and-record');
    releaseMic();
    expect(audioSession.type).toBe('auto');
  });

  it('keeps playback while a player is still sounding after the mic closes', () => {
    const audioSession = { type: 'auto' };
    stubNavigator(audioSession);
    const releasePlayer = acquire('playback');
    acquire('play-and-record')();
    expect(audioSession.type).toBe('playback');
    releasePlayer();
    expect(audioSession.type).toBe('auto');
  });

  // Push-to-talk over hands-free listening: two independent claims of the same
  // type, so a count would be wrong and the first release must not free both.
  it('tracks same-type holders independently', () => {
    const audioSession = { type: 'auto' };
    stubNavigator(audioSession);
    const releaseA = acquire('play-and-record');
    const releaseB = acquire('play-and-record');
    releaseA();
    expect(audioSession.type).toBe('play-and-record');
    releaseB();
    expect(audioSession.type).toBe('auto');
  });

  it("ignores a double release rather than freeing someone else's claim", () => {
    const audioSession = { type: 'auto' };
    stubNavigator(audioSession);
    const releaseA = acquire('playback');
    releaseA();
    const releaseB = acquire('playback');
    releaseA(); // idempotent — must not drop B's claim
    expect(audioSession.type).toBe('playback');
    releaseB();
    expect(audioSession.type).toBe('auto');
  });

  it('is a no-op where navigator.audioSession does not exist (every non-Safari browser)', () => {
    stubNavigator(null);
    expect(() => acquire('playback')()).not.toThrow();
  });

  it('swallows a throwing setter — a partial WebKit must not take playback down', () => {
    stubNavigator({ set type(_v) { throw new TypeError('unsupported'); } });
    expect(() => acquire('playback')()).not.toThrow();
  });
});

describe('resumeAudioContext', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('resumes a suspended context (autoplay policy)', async () => {
    const c = fakeCtx('suspended');
    await resumeAudioContext(c);
    expect(c.resumeCalls).toBe(1);
    expect(c.state).toBe('running');
  });

  // The regression this whole helper exists for: iOS Safari parks the context in
  // `'interrupted'` after a call / Siri / the screen locking, and a gate written
  // as `state === 'suspended'` leaves it there — playback then runs silently.
  it("resumes an iOS-Safari 'interrupted' context", async () => {
    const c = fakeCtx('interrupted');
    await resumeAudioContext(c);
    expect(c.resumeCalls).toBe(1);
    expect(c.state).toBe('running');
  });

  it('leaves a running context alone', async () => {
    const c = fakeCtx('running');
    await resumeAudioContext(c);
    expect(c.resumeCalls).toBe(0);
  });

  it('never resumes a closed context (resume() would reject)', async () => {
    const c = fakeCtx('closed');
    await resumeAudioContext(c);
    expect(c.resumeCalls).toBe(0);
    expect(c.state).toBe('closed');
  });

  // The session declaration is document-wide and marks the page output-only, so
  // the shared resume must NOT make it for everyone — a capture page (sing-to-
  // score, the voice client) would lose its microphone. Output-only players opt
  // in through the transport's `audioSession` option instead.
  it('does not declare an audio session — that stays opt-in per player', async () => {
    const audioSession = { type: 'auto' };
    stubNavigator(audioSession);
    await resumeAudioContext(fakeCtx('interrupted'));
    expect(audioSession.type).toBe('auto');
  });
});
