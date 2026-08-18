// Shared easing functions for camera/animation interpolation. Pure math, no deps — safe to use
// from inside useFrame loops. Extend here rather than re-defining easings inline per component.

// Classic Hermite smoothstep: eases in and out, t clamped to [0,1] by the caller.
export const smoothstep = (t) => t * t * (3 - 2 * t);

// Quadratic ease in/out. Paired with `smoothstep` (which is the ease-in-out of
// this set) they cover the four easing names the declarative Three.js clip
// contract allows (`server/lib/threejsModel.js`).
export const linear = (t) => t;
export const easeIn = (t) => t * t;
export const easeOut = (t) => t * (2 - t);

// Keyed by the clip contract's easing enum, so an evaluator resolves a NAME to
// a curve instead of branching on it. An unknown name is the caller's problem —
// look it up with a `linear` fallback rather than trusting the map to have it.
export const EASING_CURVES = Object.freeze({
  linear,
  easeIn,
  easeOut,
  easeInOut: smoothstep,
});
