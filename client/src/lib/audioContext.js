// The ONE app-wide Web Audio AudioContext, created lazily on first use.
// Browsers cap the number of live contexts (~6), and every playback feature
// sharing a single context also shares a single sample clock — so features
// that sound together (metronome + score synth, MIDI preview over a round)
// stay aligned for free. Consumed by songPlayback.js, scorePlayback.js,
// metronome.js, and midiPlayback.js — new audio features should import this
// instead of growing another module-level singleton.
//
// The constructor is resolved lazily and never touches a bare `window` at
// module load — the server's vitest run globs lib tests in the node
// environment (no jsdom), where `window` is undefined. Tests inject a fake
// via vi.stubGlobal('AudioContext', …) before the first call; the singleton
// then caches that fake for the life of the test file's module registry.

let sharedCtx = null;

/**
 * The shared AudioContext. Autoplay policies start it suspended until a user
 * gesture — callers resume() it on play, not here.
 */
export function getAudioContext() {
  if (!sharedCtx) {
    const Ctor =
      (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) ||
      globalThis.AudioContext ||
      globalThis.webkitAudioContext;
    sharedCtx = new Ctor();
  }
  return sharedCtx;
}
