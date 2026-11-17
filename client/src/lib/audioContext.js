// The shared lazy Web Audio AudioContext for the song-system playback stack (songPlayback, scorePlayback, metronome, midiPlayback).
//
// Browsers cap live contexts (~6), and modules sharing one context share one sample clock, so features that sound together stay aligned. New audio features
// should import this instead of growing another module-level singleton.
// Holdouts on the CONTEXT, on purpose: openWorldAudioEngine.js (persistent gain graph, its own differently-contracted getAudioContext), MorseTrainer
// (per-mount context it close()s on unmount) and pages/Security.jsx (per-stream createMediaElementSource graph); each still claims the iOS audio session
// below via `useAudioSessionClaim`.
// The constructor is resolved lazily so importing never touches audio APIs at load time. Tests inject a fake via vi.stubGlobal('AudioContext', …) before the first call;
// the singleton then caches it for that file's module registry.

let sharedCtx = null;

// --- iOS audio session ---
//
// iOS puts Web Audio on the `auto` session, which acts as *ambient* while no media element plays, and an ambient session is SILENCED by the
// hardware ring/silent switch: a pure-synth page looks like it plays while the phone is silent. Declaring `playback` ignores the switch.
//
// The session belongs to the DOCUMENT, and `playback` makes the page output-only: it REFUSES capture. With a globally-mounted VoiceWidget (`Layout.jsx`),
// "set it when you start playing" outlives the route and collides with a mic that can open on any page, breaking `getUserMedia` silently.
//
// So the session is ARBITRATED: each feature acquires what it needs for as long as it needs it and the arbiter declares the union. A live capture wins
// because `play-and-record` satisfies both sides (it also ignores the ring/silent switch). When the last holder releases the document returns to `auto`,
// the platform default, not a remembered previous value.
//
// Callers rarely use this directly: `createLookaheadTransport({ audioSession: 'playback' })` acquires on play and releases on teardown; capture surfaces acquire
// `'play-and-record'` while their `getUserMedia` stream is open; a React surface owning its own context or stream uses `hooks/useAudioSessionClaim.js`.
//
// Safari 16.4+ only; `navigator.audioSession` is absent elsewhere. Assignment is guarded because a partial WebKit implementation rejecting the value must not take playback down.

// Most-capable first: the first type any live holder wants is what gets declared.
const SESSION_PRECEDENCE = ['play-and-record', 'playback'];

// Live holders, one per un-released acquire. A LIST, not a count per type: two features can hold the same type and each must release only its own claim.
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
 * Claim the document's iOS audio session as `type` (`'playback'` output-only, `'play-and-record'` while a mic stream is open) until the returned release
 * function is called. Release is idempotent.
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
 * The shared AudioContext. Autoplay policy starts it suspended: callers `resumeAudioContext()` on play, not here.
 */
export function getAudioContext() {
  if (!sharedCtx) {
    const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    sharedCtx = new Ctor();
  }
  return sharedCtx;
}

/**
 * Bring `c` to `running`, awaited so the caller can schedule against a live clock; call from a user gesture. Every playback entry point goes through this.
 *
 * Gated on `state !== 'running'`, NOT `=== 'suspended'`: iOS Safari also parks a context in the non-standard `'interrupted'` state (call, Siri, screen lock),
 * and a suspended-only check would leave the transport scheduling against a clock that never advances. `'closed'` is excluded: resuming a closed context rejects.
 */
export async function resumeAudioContext(c) {
  if (!c || c.state === 'running' || c.state === 'closed') return;
  await c.resume?.();
}

// One second of white noise shared by every synth needing a noise source (chiptune drums, drum-kit snare/hats/cymbals), so each doesn't regenerate a megabyte
// of Float32. Regenerated only if the sample rate changes (never for the shared context; a per-mount MorseTrainer context may differ).
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
