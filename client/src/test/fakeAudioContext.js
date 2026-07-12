// Minimal Web Audio fake for playback tests — jsdom/node have no Web Audio.
// createFakeAudio() returns a fresh { FakeAudioContext, audio } pair: stub the
// constructor with vi.stubGlobal('AudioContext', FakeAudioContext) and drive
// `audio.now` to move the context clock; every created oscillator/gain is
// recorded on `audio` for assertions (gain envelopes land in `param.values`).
// Same shape the pre-existing hand-rolled fakes in scorePlayback.test.js /
// metronome.test.js use — new audio tests should import this instead of
// copying another one.

export const createFakeAudio = () => {
  const audio = {
    now: 0,
    oscillators: [],
    gains: [],
    // Modules cache the shared AudioContext (lib/audioContext.js) across a
    // test file, so create ONE pair per file and reset the recorders per
    // test — a fresh pair mid-file would record into an object the cached
    // context no longer points at.
    reset() { this.now = 0; this.oscillators.length = 0; this.gains.length = 0; },
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
      state: 'running',
      resume: () => Promise.resolve(),
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
        const gain = { gain: fakeParam(), connect: (t) => t };
        audio.gains.push(gain);
        return gain;
      },
    };
  }
  return { FakeAudioContext, audio };
};
