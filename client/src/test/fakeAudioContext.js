// Minimal Web Audio fake for playback tests — jsdom/node have no Web Audio.
// createFakeAudio() returns a fresh { FakeAudioContext, audio } pair: stub the
// constructor with vi.stubGlobal('AudioContext', FakeAudioContext) and drive
// `audio.now` to move the context clock; every created oscillator/gain is
// recorded on `audio` for assertions (gain envelopes land in `param.values`).
// Same shape the pre-existing hand-rolled fakes in scorePlayback.test.js /
// scorePlayback.race.test.js use — new audio tests should import this instead
// of copying another one.
//
// Pass { state } for a context that doesn't start running: `'suspended'` (the
// autoplay policy) or iOS Safari's non-standard `'interrupted'` (a call / Siri /
// the screen locking parks it there, and a resume gate written as
// `state === 'suspended'` walks straight past it). Either way resume() parks
// until the test calls `audio.flushResume()`, which reproduces the
// teardown-during-await race the players' playToken guard fixes — a test can
// interleave a stop()/pause() between play()'s `await ctx.resume()` and its
// continuation. `audio.state` is live (flipped to `'running'` by flushResume, so
// the fake models the real state machine) and `audio.resumeCalls` counts the
// resume() attempts.

export const createFakeAudio = ({ state: initialState = 'running' } = {}) => {
  // Pending resolvers for in-flight resume() calls. A LIST, not a single slot:
  // two overlapping play()s (the second superseding the first mid-await) each
  // park their own resume, and a single slot would drop the first one's resolver
  // so its continuation never ran — the superseded play would hang instead of
  // reaching its stale-token bail.
  let resumeResolvers = [];
  const audio = {
    now: 0,
    // Live context state — flips to 'running' once a pending resume resolves,
    // so a test can assert the transport actually brought the clock up.
    state: initialState,
    resumeCalls: 0,
    // Set to an Error to make resume() reject instead of parking — the autoplay
    // policy refusing a gesture, or iOS declining to hand the session back. Set
    // on the shared `audio` (not via a re-stubbed constructor) because
    // lib/audioContext.js memoizes the context on first use, so a later stub
    // never reaches the instance the code under test is already holding.
    resumeRejection: null,
    oscillators: [],
    gains: [],
    // Bandpassed noise voices (createBufferSource + createBiquadFilter) — the
    // percussion synth in drumPlayback.js. `oscillators` records buffer sources
    // too (they satisfy the same start/stop/onended surface the transport tracks),
    // so a caller that only cares "how many voices sounded" reads that one list.
    filters: [],
    // WaveShaperNodes — per-voice saturation and the master soft-clipper in
    // drumPlayback.js. `curve` is recorded so a test can assert a voice is
    // actually driven (the harmonics that make a sub-bass kick audible).
    shapers: [],
    reset() {
      this.now = 0;
      this.state = initialState;
      this.resumeCalls = 0;
      this.resumeRejection = null;
      this.oscillators.length = 0;
      this.gains.length = 0;
      this.filters.length = 0;
      this.shapers.length = 0;
      resumeResolvers = [];
    },
    // Resolve every pending resume() so the parked play()s continue, bringing the
    // context up exactly as a real one does.
    flushResume() {
      const pending = resumeResolvers;
      resumeResolvers = [];
      if (!pending.length) return;
      this.state = 'running';
      for (const r of pending) r();
    },
  };
  // Every node records what it was connected TO, so a test can assert ROUTING
  // ("the kick's oscillator feeds a drive shaper") rather than inferring it from
  // node creation order. `connect` still returns its target so chains work.
  const connectable = () => ({
    connections: [],
    connect(target) { this.connections.push(target); return target; },
    disconnect() {},
  });
  const fakeParam = () => {
    const values = [];
    return {
      values,
      setValueAtTime: (v) => values.push(v),
      exponentialRampToValueAtTime: (v) => values.push(v),
      // Glide to a target (drumPlayback's click-volume bus) — recorded like any
      // other scheduled value so a test reads the level off `values`.
      setTargetAtTime: (v) => values.push(v),
    };
  };
  function FakeAudioContext() {
    return {
      get state() { return audio.state; },
      resume: () => {
        audio.resumeCalls += 1;
        if (audio.resumeRejection) return Promise.reject(audio.resumeRejection);
        if (audio.state === 'running') return Promise.resolve();
        return new Promise((r) => { resumeResolvers.push(r); });
      },
      get currentTime() { return audio.now; },
      destination: { id: 'destination' },
      createOscillator() {
        const osc = {
          type: '', frequency: fakeParam(), onended: null, started: null, stopped: null,
          periodicWave: null,
          ...connectable(), start(t) { this.started = t; }, stop(t) { this.stopped = t; },
          setPeriodicWave(w) { this.periodicWave = w; },
        };
        audio.oscillators.push(osc);
        return osc;
      },
      createGain() {
        const gain = { gain: fakeParam(), ...connectable() };
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
          ...connectable(), start(t) { this.started = t; }, stop(t) { this.stopped = t; },
        };
        // Recorded alongside oscillators: the transport tracks both the same way.
        audio.oscillators.push(src);
        return src;
      },
      createBiquadFilter() {
        const filter = { type: '', frequency: fakeParam(), Q: { value: 1 }, ...connectable() };
        audio.filters.push(filter);
        return filter;
      },
      // Band-limited pulse waves (chiptune's non-50%-duty channels). Only the
      // identity matters to a test — the players just hand it back to
      // setPeriodicWave — so the harmonic arrays are recorded, not modelled.
      createPeriodicWave(real, imag, options) {
        return { periodicWave: true, real, imag, options };
      },
      createWaveShaper() {
        const shaper = { curve: null, oversample: 'none', ...connectable() };
        audio.shapers.push(shaper);
        return shaper;
      },
      sampleRate: 48000,
    };
  }
  return { FakeAudioContext, audio };
};
