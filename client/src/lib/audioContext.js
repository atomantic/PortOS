// The shared lazy Web Audio AudioContext for the song-system playback stack
// (songPlayback, scorePlayback, metronome, midiPlayback). Browsers cap the
// number of live contexts (~6), and modules sharing one context also share
// one sample clock — so features that sound together (metronome + score
// synth, MIDI preview) stay aligned for free. New audio features should
// import this instead of growing another module-level singleton.
//
// Known holdouts, on purpose: components/city/audio/cityAudioEngine.js keeps
// its own context (it owns a persistent gain graph and its own — differently
// contracted — getAudioContext export), and MorseTrainer creates a per-mount
// context it close()s on unmount, which would kill a shared one for everyone
// else. Migrate those only with their graphs/lifecycles in mind.
//
// The constructor is resolved lazily so importing this module never touches
// audio APIs at load time (node-env test runs import it cleanly). Tests
// inject a fake via vi.stubGlobal('AudioContext', …) before the first call;
// the singleton then caches that fake for the test file's module registry.

let sharedCtx = null;

/**
 * The shared AudioContext. Autoplay policies start it suspended until a user
 * gesture — callers resume() it on play, not here.
 */
export function getAudioContext() {
  if (!sharedCtx) {
    const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    sharedCtx = new Ctor();
  }
  return sharedCtx;
}
