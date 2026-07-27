// Minimal Web Audio fake for playback tests — jsdom/node have no Web Audio.
// createFakeAudio() returns a fresh { FakeAudioContext, audio } pair: stub the
// constructor with vi.stubGlobal('AudioContext', FakeAudioContext) and drive
// `audio.now` to move the context clock; every created oscillator/gain is
// recorded on `audio` for assertions (gain envelopes land in `param.values`).
// Same shape the pre-existing hand-rolled fakes in scorePlayback.test.js /
// scorePlayback.race.test.js use — new audio tests should import this instead
// of copying another one.
//
// Pass { suspended: true } to model a context that starts suspended and only
// resumes when the test calls `audio.flushResume()` — this reproduces the
// teardown-during-await race the players' playToken guard fixes, letting a test
// interleave a stop()/pause() between play()'s `await ctx.resume()` and its
// continuation.

export const createFakeAudio = ({ suspended = false } = {}) => {
  // Pending resolver for a suspended context's in-flight resume() (null until
  // a resume() is awaiting, cleared once flushed).
  let resolveResume = null;
  const audio = {
    now: 0,
    oscillators: [],
    gains: [],
    // Bandpassed noise voices (createBufferSource + createBiquadFilter) — the
    // percussion synth in drumPlayback.js. `oscillators` records buffer sources
    // too (they satisfy the same start/stop/onended surface the transport tracks),
    // so a caller that only cares "how many voices sounded" reads that one list.
    filters: [],
    reset() {
      this.now = 0;
      this.oscillators.length = 0;
      this.gains.length = 0;
      this.filters.length = 0;
      resolveResume = null;
    },
    // Resolve a suspended context's pending resume() so play()'s await continues.
    flushResume() { const r = resolveResume; resolveResume = null; if (r) r(); },
  };
  const fakeParam = () => {
    const values = [];
    return {
      values,
      setValueAtTime: (v) => values.push(v),
      exponentialRampToValueAtTime: (v) => values.push(v),
    };
  };
  function FakeAudioContext() {
    return {
      state: suspended ? 'suspended' : 'running',
      resume: suspended
        ? () => new Promise((r) => { resolveResume = r; })
        : () => Promise.resolve(),
      get currentTime() { return audio.now; },
      destination: { id: 'destination' },
      createOscillator() {
        const osc = {
          type: '', frequency: fakeParam(), onended: null, started: null, stopped: null,
          connect: (t) => t, start(t) { this.started = t; }, stop(t) { this.stopped = t; },
        };
        audio.oscillators.push(osc);
        return osc;
      },
      createGain() {
        const gain = { gain: fakeParam(), connect: (t) => t, disconnect() {} };
        audio.gains.push(gain);
        return gain;
      },
      // --- Noise-voice nodes (percussion synth) ------------------------------
      createBuffer(channels, length, sampleRate) {
        const data = new Float32Array(length);
        return { sampleRate, length, numberOfChannels: channels, getChannelData: () => data };
      },
      createBufferSource() {
        const src = {
          buffer: null, loop: false, playbackRate: { value: 1 },
          onended: null, started: null, stopped: null, noise: true,
          connect: (t) => t, start(t) { this.started = t; }, stop(t) { this.stopped = t; },
        };
        // Recorded alongside oscillators: the transport tracks both the same way.
        audio.oscillators.push(src);
        return src;
      },
      createBiquadFilter() {
        const filter = { type: '', frequency: fakeParam(), Q: { value: 1 }, connect: (t) => t };
        audio.filters.push(filter);
        return filter;
      },
      sampleRate: 48000,
    };
  }
  return { FakeAudioContext, audio };
};
