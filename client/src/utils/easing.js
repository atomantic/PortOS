// Shared easing functions for camera/animation interpolation. Pure math, no deps — safe to use
// from inside useFrame loops. Extend here rather than re-defining easings inline per component.

// Classic Hermite smoothstep: eases in and out, t clamped to [0,1] by the caller.
export const smoothstep = (t) => t * t * (3 - 2 * t);
