/* Camera rig for PortOS music-video documents (#10589).
 *
 * One deterministic camera path per shared camera-movement id (the same ids
 * the storyboard's `camera.move` and the i2v camera prompt use — see
 * server/lib/cameraMovements.js), so code-drawn shots and generated shots
 * share one vocabulary.
 *
 *   PORTOS_CAMERA_RIG.sample(id, t, options) -> {
 *     position: [x, y, z], target: [x, y, z], up: [x, y, z],
 *     fov (degrees, vertical), roll (radians around the view axis),
 *     blur (0 sharp .. 1 fully soft), focusShift (0 near .. 1 far),
 *     timeScale (how fast the world's own clock runs), framing, subjectFraction }
 *
 * `t` is normalized shot time (0 = first frame, 1 = last). Options:
 *   speed   'slow' | 'moderate' | 'fast' | 'snap' (default: the move's own)
 *   beat    normalized time of the beat the move should hit (0..1)
 *   onBeat  true: the move arrives at `beat`; a snap move always centers on it
 *   amount  0..1, how much of the path to travel (1 = the full move)
 *
 * The subject sits at the origin, one unit tall. Units are arbitrary; a three.js
 * world can scale them. `applyToCamera(camera, sample)` drives a
 * THREE.PerspectiveCamera; `flatView(id, t, options)` turns the same path into a
 * 2D cover transform ({ zoom, x, y, rotation }) for a flat still or video
 * frame — the layered engine draws its stills and footage through it, and the
 * GENTLE table below holds the engine's subtle moves as entries of the same rig.
 *
 * Pure math, no DOM and no three.js import: the same file loads as a plain
 * <script> (window.PORTOS_CAMERA_RIG) and under a test harness.
 */
(() => {
  'use strict';

  const BASE_FOV = 50;
  // Camera-to-subject distance that frames a one-unit subject at BASE_FOV.
  const DIST = { 'extreme-wide': 14, wide: 5.5, medium: 2.5, close: 1.3, 'extreme-close': 0.6 };
  // Subject height as a fraction of frame height → framing (upper bounds).
  const FRAMING_BOUNDS = [['extreme-wide', 0.12], ['wide', 0.3], ['medium', 0.6], ['close', 1.2], ['extreme-close', Infinity]];

  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, k) => a + (b - a) * k;
  const geo = (a, b, k) => a * Math.pow(b / a, k);
  const seg = (t, a, b) => (b > a ? clamp((t - a) / (b - a)) : (t >= b ? 1 : 0));
  const rad = (deg) => (deg * Math.PI) / 180;
  const easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
  const easeOut = (k) => 1 - Math.pow(1 - k, 3);
  const smooth = (k) => k * k * (3 - 2 * k);
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const length = (a) => Math.hypot(a[0], a[1], a[2]);
  const normalize = (a) => { const l = length(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  // Deterministic, smooth "hand" noise: a few incommensurate sines.
  const wobble = (t, seed) => Math.sin(t * 7.3 + seed) * 0.5 + Math.sin(t * 13.7 + seed * 2.1) * 0.3 + Math.sin(t * 23.1 + seed * 3.7) * 0.2;

  const ORIGIN = [0, 0, 0];
  // Camera on a sphere around `target`: yaw turns right, pitch looks down from above.
  const around = (target, dist, yawDeg, pitchDeg) => add(target, [
    dist * Math.sin(rad(yawDeg)) * Math.cos(rad(pitchDeg)), dist * Math.sin(rad(pitchDeg)), dist * Math.cos(rad(yawDeg)) * Math.cos(rad(pitchDeg)),
  ]);
  // Target in front of a fixed `position`: yaw turns right, pitch tilts up.
  const aim = (position, dist, yawDeg, pitchDeg) => add(position, [
    dist * Math.sin(rad(yawDeg)) * Math.cos(rad(pitchDeg)), dist * Math.sin(rad(pitchDeg)), -dist * Math.cos(rad(yawDeg)) * Math.cos(rad(pitchDeg)),
  ]);
  const fractionAt = (dist, fov) => 1 / (2 * dist * Math.tan(rad(fov) / 2));
  // The fov that keeps a subject at `fraction` of frame height from `dist`.
  const fovFor = (fraction, dist) => (2 * Math.atan(1 / (2 * dist * fraction)) * 180) / Math.PI;
  const pose = (position, target = ORIGIN, extra = {}) => ({ position, target, ...extra });

  const M = DIST.medium; const C = DIST.close; const W = DIST.wide; const XW = DIST['extreme-wide'];
  const MEDIUM_FRACTION = fractionAt(M, BASE_FOV);

  // id -> (k, t) => partial state. k is the eased move progress (0..1), t the
  // raw shot time for continuous texture (hand shake, head bob).
  const PATHS = {
    'locked-off': () => pose([0, 0, M]),
    'slow-dolly-in': (k) => pose([0, 0, lerp(M, C, k)]),
    'slow-dolly-out': (k) => pose([0, 0, lerp(M, W, k)]),
    'fast-dolly-in': (k) => pose([0, 0, lerp(W, C, k)]),
    'dolly-zoom': (k) => { const d = lerp(M, 1.4, k); return pose([0, 0, d], ORIGIN, { fov: fovFor(MEDIUM_FRACTION, d) }); },
    'zoom-in': (k) => pose([0, 0, M], ORIGIN, { fov: lerp(BASE_FOV, 26, k) }),
    'zoom-out': (k) => pose([0, 0, M], ORIGIN, { fov: lerp(BASE_FOV, 80, k) }),
    'crash-zoom': (k) => pose([0, 0, M], ORIGIN, { fov: lerp(BASE_FOV, 15, k) }),
    'macro-zoom': (k) => pose([0, 0, geo(M, 0.5, k)], ORIGIN, { fov: lerp(BASE_FOV, 35, k) }),
    'pan-left': (k) => pose([0, 0, M], aim([0, 0, M], M, lerp(0, -35, k), 0)),
    'pan-right': (k) => pose([0, 0, M], aim([0, 0, M], M, lerp(0, 35, k), 0)),
    'whip-pan': (k) => pose([0, 0, M], aim([0, 0, M], M, lerp(0, 90, k), 0), { blur: 0.8 * Math.sin(Math.PI * k) }),
    'tilt-up': (k) => pose([0, 0, M], aim([0, 0, M], M, 0, lerp(0, 25, k))),
    'tilt-down': (k) => pose([0, 0, M], aim([0, 0, M], M, 0, lerp(0, -25, k))),
    'truck-left': (k) => pose([lerp(0, -1.5, k), 0, M], [lerp(0, -1.5, k), 0, 0]),
    'truck-right': (k) => pose([lerp(0, 1.5, k), 0, M], [lerp(0, 1.5, k), 0, 0]),
    'pedestal-up': (k) => pose([0, lerp(0, 1.2, k), M], [0, lerp(0, 1.2, k), 0]),
    'pedestal-down': (k) => pose([0, lerp(0, -1.2, k), M], [0, lerp(0, -1.2, k), 0]),
    'crane-up': (k) => pose(around(ORIGIN, lerp(M, 6, k), 0, lerp(0, 50, k))),
    'crane-down': (k) => pose(around(ORIGIN, lerp(6, M, k), 0, lerp(50, 5, k))),
    'orbit-180': (k) => pose(around(ORIGIN, M, lerp(0, 180, k), 5)),
    'orbit-360': (k) => pose(around(ORIGIN, M, lerp(0, 360, k), 5)),
    'cinematic-arc': (k) => pose(around(ORIGIN, 3, lerp(-30, 30, k), 6)),
    'reveal-from-behind': (k) => pose([lerp(-1.4, 0, k), 0, M]),
    'fly-through': (k) => pose([0, 0, lerp(7, 2.2, k)]),
    'following-shot': (k, t) => { const s = lerp(0, -4, k); return pose([0, 0.3 + 0.03 * Math.sin(t * 18), s + M], [0, 0, s]); },
    'leading-shot': (k, t) => { const s = lerp(0, 4, k); return pose([0, 0.2 + 0.03 * Math.sin(t * 18), s + M], [0, 0, s]); },
    'side-tracking': (k) => { const s = lerp(0, 4, k); return pose([s, 0, M], [s, 0, 0]); },
    'steadicam-follow': (k) => { const s = lerp(0, -3, k); return pose([0.15 * Math.sin(2 * Math.PI * k), 0.25, s + M], [0, 0, s]); },
    handheld: (_k, t) => pose([0.04 * wobble(t, 1), 0.03 * wobble(t, 2), M], [0.03 * wobble(t, 3), 0.02 * wobble(t, 4), 0], { roll: 0.015 * wobble(t, 5) }),
    'pov-walk': (k, t) => { const s = lerp(0, -3, k); return pose([0.02 * Math.sin(t * 9), 0.04 * Math.abs(Math.sin(t * 18)), s + M], [0, 0, s]); },
    'worm-eye-track': (k) => { const s = lerp(0, -3, k); return pose([0, -0.9, s + 2.3], [0, 0.2, s]); },
    'drone-flyover': (k) => { const s = lerp(0, -10, k); return pose([0, 8, s + 11], [0, 0, s]); },
    'drone-reveal': (k) => pose([0, lerp(1, 9, k), lerp(5.4, 11, k)]),
    'drone-orbit': (k) => pose(around(ORIGIN, XW, lerp(0, 120, k), 35)),
    'drone-dive': (k) => pose([0, lerp(13.5, 1.5, k), lerp(3.5, 2, k)]),
    'top-down-twist': (k) => pose([0, 3, 0.001], ORIGIN, { roll: lerp(0, Math.PI / 2, k) }),
    'dutch-roll': (k) => pose([0, 0, M], ORIGIN, { roll: lerp(0, rad(25), k) }),
    'barrel-roll': (k) => pose([0, 0, lerp(3, 2, k)], ORIGIN, { roll: lerp(0, 2 * Math.PI, k) }),
    'rack-focus': (k) => pose([0, 0, M], ORIGIN, { focusShift: k }),
    'focus-reveal': (k) => pose([0, 0, M], ORIGIN, { blur: 1 - k }),
    'ots-drift': (k) => pose([0.55 + lerp(0, 0.25, k), 0.15, M]),
    'push-past': (k) => pose([0, 0, lerp(4, 2, k)]),
    'slider-parallax': (k) => pose([lerp(-0.35, 0.35, k), 0, M]),
    'body-mount': (k, t) => { const s = lerp(0, 3, k); return pose([s, 0.05 * Math.sin(t * 11), C], [s, 0.05 * Math.sin(t * 11), 0], { roll: 0.06 * Math.sin(t * 6) }); },
    'bullet-time': (k) => pose(around(ORIGIN, M, lerp(-60, 60, k), 5), ORIGIN, { timeScale: 0.05 }),
    hyperlapse: (k) => { const s = lerp(0, -12, k); return pose([0, 0.2, s + M], [0, 0, s], { timeScale: 12 }); },
    'infinite-zoom': (k) => { const d = geo(M, 0.8, k); return pose([0, 0, d], ORIGIN, { fov: fovFor(geo(MEDIUM_FRACTION, 9, k), d) }); },
    'powers-of-ten': (k) => { const d = geo(C, 60, k); return pose([0, d, 0.02 * d]); },
    'locked-time-lapse': () => pose([0, 0, M], ORIGIN, { timeScale: 60 }),
    'tilt-shift-miniature': (k) => { const s = lerp(0, 0.8, k); return pose(around([s, 0, 0], 7, 0, 45), [s, 0, 0], { fov: 35, blur: 0.6, timeScale: 4 }); },
    'crash-zoom-out': (k) => pose([0, 0, M], ORIGIN, { fov: lerp(15, 80, k) }),
    'chase-tracking': (k, t) => { const s = lerp(0, -20, k); return pose([0.9 + 0.12 * Math.sin(t * 5), 0.35, s + 2.3], [0, 0, s], { roll: 0.03 * Math.sin(t * 7) }); },
  };

  // The catalog's default speed per move (server/lib/cameraMovements.js);
  // decides the ease when the caller passes none.
  const SNAP = new Set(['whip-pan', 'crash-zoom', 'dutch-roll', 'crash-zoom-out']);
  const FAST = new Set(['fast-dolly-in', 'orbit-360', 'fly-through', 'drone-dive', 'barrel-roll', 'chase-tracking']);
  const defaultSpeed = (id) => (SNAP.has(id) ? 'snap' : FAST.has(id) ? 'fast' : 'moderate');
  const SNAP_HALF_WINDOW = 0.06;

  /** Eased progress of a move at normalized shot time t. */
  function progress(id, t, options = {}) {
    const time = clamp(Number.isFinite(t) ? t : 0);
    const speed = options.speed || defaultSpeed(id);
    const beat = Number.isFinite(options.beat) ? clamp(options.beat) : null;
    const amount = Number.isFinite(options.amount) ? clamp(options.amount) : 1;
    let k;
    if (speed === 'snap') {
      const center = clamp(beat ?? 0.12, SNAP_HALF_WINDOW, 1 - SNAP_HALF_WINDOW);
      k = smooth(seg(time, center - SNAP_HALF_WINDOW, center + SNAP_HALF_WINDOW));
    } else if (beat != null && options.onBeat) {
      k = easeInOut(seg(time, 0, Math.max(beat, 0.05)));
    } else if (speed === 'fast') {
      k = easeOut(seg(time, 0, 0.7));
    } else {
      k = easeInOut(time);
    }
    return k * amount;
  }

  const framingOf = (fraction) => FRAMING_BOUNDS.find(([, bound]) => fraction < bound)[0];
  const upFor = (position, target) => (Math.abs(normalize(sub(target, position))[1]) > 0.98 ? [0, 0, -1] : [0, 1, 0]);

  function stateAt(id, k, t) {
    const path = PATHS[id];
    if (!path) return null;
    const partial = path(k, t);
    const state = {
      position: partial.position, target: partial.target,
      fov: partial.fov ?? BASE_FOV, roll: partial.roll ?? 0, blur: partial.blur ?? 0,
      focusShift: partial.focusShift ?? 0, timeScale: partial.timeScale ?? 1,
    };
    state.up = upFor(state.position, state.target);
    state.subjectFraction = fractionAt(length(sub(state.target, state.position)), state.fov);
    state.framing = framingOf(state.subjectFraction);
    return state;
  }

  /** The camera state of move `id` at normalized shot time `t`, or null for an unknown id. */
  function sample(id, t, options = {}) {
    if (!PATHS[id]) return null;
    return stateAt(id, progress(id, t, options), clamp(Number.isFinite(t) ? t : 0));
  }

  /** Drive a THREE.PerspectiveCamera (duck-typed) from a sample. */
  function applyToCamera(camera, state) {
    if (!camera || !state) return camera;
    camera.up.set(state.up[0], state.up[1], state.up[2]);
    camera.position.set(state.position[0], state.position[1], state.position[2]);
    camera.lookAt(state.target[0], state.target[1], state.target[2]);
    if (state.roll) camera.rotateZ(state.roll);
    if (camera.fov !== state.fov) { camera.fov = state.fov; camera.updateProjectionMatrix?.(); }
    return camera;
  }

  /**
   * The move as a 2D cover transform for a flat frame: `zoom` (relative to the
   * first frame), `x`/`y` offsets of the image center (frame widths/heights,
   * screen y down), and `rotation` (radians). The flat frame is the plane
   * through the first frame's target, facing the first frame's camera.
   */
  const FLAT_MAX_OFFSET = 0.15;
  const FLAT_ZOOM = [0.4, 6];
  function flatView(id, t, options = {}) {
    const rest = stateAt(id, 0, 0);
    const sampled = sample(id, t, options);
    if (!rest || !sampled) return null;
    const aspect = Number.isFinite(options.aspect) && options.aspect > 0 ? options.aspect : 16 / 9;
    const n0 = normalize(sub(rest.target, rest.position));
    const right0 = normalize(cross(n0, rest.up));
    const up0 = cross(right0, n0);
    // A camera travelling down the lens axis WITH its subject (follow, lead,
    // hyperlapse) keeps the subject's size and place: drop that shared travel
    // before projecting onto the flat frame.
    const travel = sub(sampled.target, rest.target);
    const lag = length(sub(sub(sampled.position, rest.position), travel));
    const together = length(travel) > 1e-6 && lag < 0.25 * length(travel) && Math.abs(dot(normalize(travel), n0)) > 0.85;
    const now = together ? { ...sampled, position: sub(sampled.position, travel), target: rest.target } : sampled;
    const dir = normalize(sub(now.target, now.position));
    const facing = dot(dir, n0);
    let hit = now.target;
    let dist = length(sub(now.target, now.position));
    if (facing > 0.2) {
      const along = dot(sub(rest.target, now.position), n0) / facing;
      if (along > 1e-3) { hit = add(now.position, scale(dir, along)); dist = along; }
    }
    const h = dist * Math.tan(rad(now.fov) / 2);
    const h0 = length(sub(rest.target, rest.position)) * Math.tan(rad(rest.fov) / 2);
    const offset = sub(hit, rest.target);
    let x = -dot(offset, right0) / (2 * h * aspect);
    const y = dot(offset, up0) / (2 * h);
    // A camera circling a fixed target reads as a sideways drift on a flat frame.
    if (length(sub(now.target, rest.target)) < 0.05) {
      const azimuth = (p) => Math.atan2(dot(sub(p, rest.target), right0), -dot(sub(p, rest.target), n0));
      x -= (Math.sin(azimuth(now.position) - azimuth(rest.position)) * 0.12) / aspect;
    }
    return {
      zoom: clamp(h0 / h, FLAT_ZOOM[0], FLAT_ZOOM[1]),
      x: clamp(x, -FLAT_MAX_OFFSET, FLAT_MAX_OFFSET), y: clamp(y, -FLAT_MAX_OFFSET, FLAT_MAX_OFFSET),
      rotation: now.roll, blur: now.blur, timeScale: now.timeScale,
    };
  }

  // The layered engine's subtle moves, as entries of this rig: `amount` of the
  // named path, drawn over a `base` cover scale.
  const GENTLE = Object.freeze({
    footage: Object.freeze({ move: 'slow-dolly-in', amount: 0.08, base: 1.02 }),
    hold: Object.freeze({ move: 'locked-off', amount: 1, base: 1.035 }),
    push: Object.freeze({ move: 'slow-dolly-in', amount: 0.15, base: 1.04 }),
    pull: Object.freeze({ move: 'slow-dolly-out', amount: 0.03, base: 1.13 }),
    'drift-left': Object.freeze({ move: 'truck-left', amount: 0.12, base: 1.09 }),
    'drift-right': Object.freeze({ move: 'truck-right', amount: 0.12, base: 1.09 }),
    rise: Object.freeze({ move: 'pedestal-up', amount: 0.1, base: 1.08 }),
  });
  // Unassigned stills cycle through these; a 'pan' still alternates the drifts.
  const GENTLE_CYCLE = Object.freeze(['push', 'pull', 'drift-left', 'drift-right', 'rise']);
  // How much of a director-chosen move a flat still travels (a photo has edges).
  const STILL_AMOUNT = 0.35;

  globalThis.PORTOS_CAMERA_RIG = Object.freeze({
    version: 1,
    ids: Object.freeze(Object.keys(PATHS)),
    has: (id) => Object.prototype.hasOwnProperty.call(PATHS, id),
    sample, progress, flatView, applyToCamera, framingOf, defaultSpeed,
    GENTLE, GENTLE_CYCLE, STILL_AMOUNT,
  });
})();
