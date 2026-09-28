/**
 * PortOS motion kit — deterministic motion and sound helpers for seekable HTML
 * compositions. Load it as a classic script (`<script src="portos-motion.js">`)
 * and read `globalThis.PortosMotion`.
 *
 * Every helper is a pure function of time, so `portosComposition.seek(t)` can
 * paint frame 812 without simulating frames 0–811 and a render is identical on
 * every run. No timers, no Math.random, no network, no carried state.
 */
(function install(root) {
  'use strict';

  const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));

  // Closed-form damped spring from 0 to 1, t seconds after it starts. Motion
  // with mass: it accelerates, overshoots a hair when underdamped, and settles.
  function spring(t, stiffness = 170, damping = 26) {
    if (t <= 0) return 0;
    const w0 = Math.sqrt(stiffness);
    const zeta = damping / (2 * w0);
    if (zeta < 1) {
      const wd = w0 * Math.sqrt(1 - zeta * zeta);
      return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
    }
    // Critically damped (overdamped values are treated as critical).
    return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  }

  // [stiffness, damping] presets. Snappy for UI leading edges, default for
  // cards/containers/camera, heavy for big type and lockups (no overshoot),
  // playful for mascots and stickers (visible overshoot).
  const SPRINGS = Object.freeze({
    snappy: Object.freeze([320, 30]),
    default: Object.freeze([170, 26]),
    heavy: Object.freeze([120, 22]),
    playful: Object.freeze([220, 14]),
  });

  const preset = (name) => SPRINGS[name] || SPRINGS.default;

  // A value that changes target several times: one spring per change, each
  // starting at its own time, summed. Continuous motion with no restart pops.
  // keys: [[time, value], ...] sorted by time.
  function track(t, keys, stiffness = 170, damping = 26) {
    if (!keys.length) return 0;
    let value = keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      value += (keys[i][1] - keys[i - 1][1]) * spring(t - keys[i][0], stiffness, damping);
    }
    return value;
  }

  // A tab indicator or selection bar that stretches while it travels: the
  // leading edge rides a stiffer spring than the trailing edge.
  function indicator(t, stops, width = 120) {
    const lead = track(t, stops, 320, 30);
    const trail = track(t, stops, 140, 22);
    return { left: Math.min(lead, trail), right: Math.max(lead, trail) + width };
  }

  // Opacity for content inside a morphing container: it enters just after the
  // morph starts and leaves just before the next one, so text never overlaps.
  function swapAlpha(t, tIn, tOut) {
    return Math.min(clamp((t - tIn - 0.08) / 0.12), clamp((tOut - 0.1 - t) / 0.1));
  }

  // Wrap time for seamless loops; negative time wraps too.
  const loopT = (t, duration) => ((t % duration) + duration) % duration;

  // The output frame a time belongs to. Shutter motion blur samples times on
  // both sides of each frame's centre, so per-frame flicker keyed to
  // floor(t * fps) would change mid-shutter; rounding holds it for the frame.
  const frameIdx = (t, fps) => Math.round(t * fps);

  // Seeded PRNG (mulberry32). Create one per element/scene with a fixed seed,
  // inside seek(t), so the same t always draws the same frame.
  function rng(seed) {
    let state = seed | 0;
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let v = Math.imul(state ^ (state >>> 15), 1 | state);
      v = (v + Math.imul(v ^ (v >>> 7), 61 | v)) ^ v;
      return ((v ^ (v >>> 14)) >>> 0) / 2 ** 32;
    };
  }

  // A beat grid for cutting picture and sound on the same clock.
  function beats(bpm = 120, { offsetSec = 0, beatsPerBar = 4 } = {}) {
    const beatSec = 60 / bpm;
    return Object.freeze({
      bpm,
      beatSec,
      barSec: beatSec * beatsPerBar,
      at: (beat) => offsetSec + beat * beatSec,
      bar: (bar) => offsetSec + bar * beatSec * beatsPerBar,
      index: (t) => Math.floor((t - offsetSec) / beatSec),
      phase: (t) => loopT(t - offsetSec, beatSec) / beatSec,
      list: (durationSec) => {
        const times = [];
        for (let time = offsetSec; time < durationSec; time += beatSec) times.push(Math.round(time * 1000) / 1000);
        return times;
      },
    });
  }

  // Synthesized UI sound effects: [lengthSec, (localTime, noise) => sample].
  const VOICES = Object.freeze({
    click: [0.05, (t) => Math.sin(2 * Math.PI * 1800 * t) * Math.exp(-t * 90) * 0.5],
    tick: [0.03, (t) => Math.sin(2 * Math.PI * 3200 * t) * Math.exp(-t * 160) * 0.3],
    pop: [0.15, (t) => Math.sin(2 * Math.PI * (600 + 900 * t) * t) * Math.exp(-t * 30) * 0.4],
    thump: [0.5, (t) => Math.sin(2 * Math.PI * (90 - 60 * t) * t) * Math.exp(-t * 9) * 0.9],
    whoosh: [0.35, (t, noise) => noise() * Math.sin(Math.PI * Math.min(1, t / 0.35)) * 0.25],
    riser: [1, (t, noise) => (noise() * 0.15 + Math.sin(2 * Math.PI * (200 + 600 * t * t) * t) * 0.1) * t],
  });

  // Add cue sounds into a mono sample buffer in place.
  // cues: [{ t, type, gain? }] with type one of Object.keys(VOICES).
  function mixCues(samples, sampleRate, cues, gain = 1) {
    cues.forEach((cue, index) => {
      const voice = VOICES[cue.type];
      if (!voice) throw new Error(`Unknown sound cue type: ${cue.type}`);
      const [lengthSec, fn] = voice;
      const noiseRng = rng(0x5eed + index);
      const noise = () => noiseRng() * 2 - 1;
      const start = Math.floor(cue.t * sampleRate);
      const level = gain * (cue.gain ?? 1);
      const length = Math.floor(lengthSec * sampleRate);
      for (let i = 0; i < length && start + i < samples.length; i++) {
        if (start + i >= 0) samples[start + i] += fn(i / sampleRate, noise) * level;
      }
    });
    return samples;
  }

  // Soft-limit a buffer into [-1, 1] and return a plain array — the shape
  // `portosComposition.renderAudio` must return.
  function toPcm(samples, drive = 1) {
    const out = new Array(samples.length);
    for (let i = 0; i < samples.length; i++) out[i] = clamp(Math.tanh(samples[i] * drive), -1, 1);
    return out;
  }

  // One-call SFX track: render cue sounds onto a silent bed of the right length.
  function renderCues({ sampleRate, durationSec, cues, gain = 1 }) {
    const samples = new Float32Array(Math.round(sampleRate * durationSec));
    return toPcm(mixCues(samples, sampleRate, cues, gain));
  }

  root.PortosMotion = Object.freeze({
    clamp, spring, SPRINGS, preset, track, indicator, swapAlpha, loopT, frameIdx, rng, beats,
    VOICES, mixCues, toPcm, renderCues,
  });
})(globalThis);
