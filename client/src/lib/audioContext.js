// The shared lazy Web Audio AudioContext for the song-system playback stack
// (songPlayback, scorePlayback, metronome, midiPlayback). Browsers cap the
// number of live contexts (~6), and modules sharing one context also share
// one sample clock — so features that sound together (metronome + score
// synth, MIDI preview) stay aligned for free. New audio features should
// import this instead of growing another module-level singleton.
//
// Known holdouts, on purpose: components/city/audio/cityAudioEngine.js keeps
// its own context (it owns a persistent gain graph and its own — differently
// contracted — getAudioContext export); MorseTrainer creates a per-mount
// context it close()s on unmount, which would kill a shared one for everyone
// else; and pages/Security.jsx builds one per stream around a
// createMediaElementSource graph it tears down with the stream. Migrate those
// only with their graphs/lifecycles in mind. They are holdouts on the CONTEXT
// only — each now claims the iOS audio session below via `useAudioSessionClaim`,
// so none of them is a holdout on the session any more.
//
// The constructor is resolved lazily so importing this module never touches
// audio APIs at load time (node-env test runs import it cleanly). Tests
// inject a fake via vi.stubGlobal('AudioContext', …) before the first call;
// the singleton then caches that fake for the test file's module registry.

let sharedCtx = null;

// --- iOS audio session ------------------------------------------------------
//
// iOS puts a page's Web Audio on the `auto` session, which behaves as *ambient*
// while no media element is playing — and an ambient session is SILENCED by the
// hardware ring/silent switch. A pure-synth page therefore looks like it is
// playing (the clock runs, the playhead scrolls) while the phone makes no sound
// at all, with nothing on screen to explain why. Declaring `playback` is the
// fix: that session ignores the switch, which is what every other platform
// already does for a backing track or a metronome.
//
// The catch: the session belongs to the DOCUMENT, not to an AudioContext, and
// `playback` declares the page output-only — it REFUSES capture. PortOS is a
// single-page app with a globally-mounted VoiceWidget (`Layout.jsx`), so the
// naive "set it when you start playing" is wrong twice over: it outlives the
// route that set it, and it collides head-on with a mic that can open at any
// moment on any page. Either way the user loses `getUserMedia` — voice, the
// Songs training views, `audioRecorder` — with nothing to explain it.
//
// So the session is ARBITRATED, not assigned. Each feature acquires the session
// it needs for exactly as long as it needs it, and the arbiter declares the
// union: a live capture always wins, because `play-and-record` satisfies BOTH
// sides (it ignores the ring/silent switch just like `playback`, so a play-along
// stays audible through it) while `playback` satisfies only one. When the last
// holder releases, the document goes back to `auto` — the platform default,
// deliberately not a remembered previous value, which would just re-pin whatever
// the last feature happened to want.
//
// Callers rarely reach for this directly: an output-only player passes
// `audioSession: 'playback'` to `createLookaheadTransport`, which acquires on
// play and releases on teardown. Capture surfaces acquire `'play-and-record'`
// around the window their `getUserMedia` stream is open. A React surface that
// owns its own context or stream (so neither of those applies) uses
// `hooks/useAudioSessionClaim.js`, which wraps one claim with the
// release-on-unmount backstop rather than hand-rolling the ref dance.
//
// Safari 16.4+ only; `navigator.audioSession` is absent everywhere else and
// those browsers need nothing. Assignment is guarded because it runs from the
// play handler — a partial WebKit implementation rejecting the value must not
// take playback down with it.

// Most-capable first: the first type any live holder wants is what gets declared.
const SESSION_PRECEDENCE = ['play-and-record', 'playback'];

// Live holders, one per un-released acquire. A LIST rather than a count per type
// because two features can hold the same type independently (push-to-talk over
// hands-free listening) and each must be able to release only its own claim.
const sessionHolders = [];

const declareSession = (type) => {
  const session = globalThis.navigator?.audioSession;
  if (!session) return;
  try { session.type = type; } catch { /* older/partial WebKit */ }
};

const applyEffectiveSession = () => {
  declareSession(SESSION_PRECEDENCE.find(
    (type) => sessionHolders.some((h) => h.type === type),
  ) || 'auto');
};

/**
 * Claim the document's iOS audio session as `type` (`'playback'` for output-only,
 * `'play-and-record'` while a mic stream is open) until the returned release
 * function is called. Release is idempotent, so a caller with several teardown
 * paths can call it from all of them.
 */
export function acquireAudioSession(type) {
  const holder = { type };
  sessionHolders.push(holder);
  applyEffectiveSession();
  return () => {
    const i = sessionHolders.indexOf(holder);
    if (i < 0) return;            // already released
    sessionHolders.splice(i, 1);
    applyEffectiveSession();
  };
}

/**
 * The shared AudioContext. Autoplay policies start it suspended until a user
 * gesture — callers `resumeAudioContext()` it on play, not here.
 */
export function getAudioContext() {
  if (!sharedCtx) {
    const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    sharedCtx = new Ctor();
  }
  return sharedCtx;
}

/**
 * Bring `c` to `running`, awaited so the caller can schedule against a live
 * clock. Call it from a user gesture (autoplay policy) — every playback entry
 * point should go through this rather than resuming by hand.
 *
 * Gated on `state !== 'running'`, NOT on `state === 'suspended'`: iOS Safari
 * also parks a context in the non-standard `'interrupted'` state — a phone
 * call, Siri, the screen locking, another tab or app taking the audio session.
 * A suspended-only check leaves an interrupted context exactly where it is, so
 * the transport arms its scheduler against a clock that never advances and
 * "plays" in silence until the page is reloaded.
 *
 * `'closed'` is excluded on purpose: resuming a closed context rejects, and a
 * per-mount context that has already been close()d has nothing to bring back.
 */
export async function resumeAudioContext(c) {
  if (!c || c.state === 'running' || c.state === 'closed') return;
  await c.resume?.();
}

// One second of white noise, shared by every synth that needs a noise source
// (chiptune drums, the drum-kit snare/hats/cymbals). It lives beside the shared
// context for the same reason the context does: each copy is a megabyte of
// Float32 that every noise voice can read from instead of re-generating.
// Re-generated only if the sample rate changes — which for the shared context
// means never, but a per-mount context (MorseTrainer) may differ.
let noiseBuffer = null;

/** The shared white-noise buffer for `c`. Loop an AudioBufferSourceNode over it. */
export function getNoiseBuffer(c) {
  if (!noiseBuffer || noiseBuffer.sampleRate !== c.sampleRate) {
    noiseBuffer = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
  }
  return noiseBuffer;
}
