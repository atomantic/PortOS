/** Project the layered preview playhead from the audio master's worker-time anchors. */
export function createPreviewPlaybackClock(bridge) {
  let clockAt = 0, songTime = 0, rate = 1, correction = 0, lastAnchor = 0;
  const now = performance.now.bind(performance);
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const anchorAge = (input, at) => (at - input.workerTime) / 1000;
  const project = (input, at) => clamp(input.t + anchorAge(input, at), 0, bridge.duration);
  const reset = (time, at) => {
    songTime = time; clockAt = at; correction = 0; rate = 1;
  };
  const advance = (at) => {
    const elapsed = Math.max(0, (at - clockAt) / 1000);
    songTime = clamp(songTime + elapsed * rate, 0, bridge.duration);
    correction -= elapsed * (rate - 1);
    rate = 1 + clamp(correction / 2, -0.02, 0.02);
    clockAt = at;
    return songTime;
  };
  return {
    now, anchorAge, project, reset, advance,
    get rate() { return rate; },
    anchorGap: (at) => at - lastAnchor,
    acceptAnchor(at, drift = 0) { lastAnchor = at; correction = drift; },
  };
}
