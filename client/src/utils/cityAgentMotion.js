// Pure, deterministic helpers for animating CyberCity agent entities along an
// orbit path and rendering a fading motion trail behind them. No three.js /
// React imports here so the geometry math can be unit-tested in isolation
// (mirrors the cityTimeline.js helper pattern).

export const AGENT_MOTION = {
  orbitRadius: 0.9, // horizontal orbit radius around the building anchor
  orbitSpeed: 0.6, // radians/sec around the anchor
  bobAmp: 0.3, // vertical bob amplitude (matches the legacy AgentEntity bob)
  bobSpeed: 1.5, // vertical bob speed
  trailSeconds: 1.6, // how far back in time the trail samples
  trailSamples: 24, // points along the trail at full quality
};

// Position of an agent at elapsed time `t` (seconds), as an offset relative to
// its building anchor. `index` fans multiple agents on the same building into
// distinct orbit phases so their paths and trails don't overlap.
export function computeAgentOrbit(t, { index = 0, radius, orbitSpeed, bobAmp, bobSpeed } = {}) {
  const r = radius ?? AGENT_MOTION.orbitRadius;
  const os = orbitSpeed ?? AGENT_MOTION.orbitSpeed;
  const ba = bobAmp ?? AGENT_MOTION.bobAmp;
  const bs = bobSpeed ?? AGENT_MOTION.bobSpeed;
  const phase = index * (Math.PI * 0.5); // quarter-turn fan per agent
  const angle = t * os + phase;
  return {
    x: Math.cos(angle) * r,
    y: Math.sin(t * bs + index) * ba,
    z: Math.sin(angle) * r,
  };
}

// Resolve how many trail samples to draw for a given quality density.
// `particleDensity` ranges ~0.5 (low) .. 1.5 (ultra). At/above the low floor it
// scales linearly to the full sample count; below the floor the trail is
// dropped entirely (returns 0) so weak hardware pays nothing for it.
export function resolveTrailSamples(particleDensity = 1, maxSamples = AGENT_MOTION.trailSamples) {
  if (!(particleDensity >= 0.5)) return 0;
  const scaled = Math.round((maxSamples * Math.min(1.5, particleDensity)) / 1.5);
  return Math.max(2, scaled);
}

// Sample the orbit path backwards from time `t` into `samples` points, newest
// first. Writes a flat [x0,y0,z0, x1,y1,z1, ...] of offsets relative to the
// anchor — the caller adds the anchor position when placing the trail. Pass a
// pre-allocated `out` array (e.g. the geometry's Float32Array) to fill it in
// place and avoid a per-frame allocation on the render hot path; otherwise a
// fresh Array is allocated and returned.
export function computeAgentTrailPoints(
  t,
  opts = {},
  samples = AGENT_MOTION.trailSamples,
  trailSeconds = AGENT_MOTION.trailSeconds,
  out = null,
) {
  const n = Math.max(2, samples);
  const pts = out || new Array(n * 3);
  for (let i = 0; i < n; i++) {
    const dt = (i / (n - 1)) * trailSeconds; // 0 at head (newest), trailSeconds at tail
    const p = computeAgentOrbit(t - dt, opts);
    pts[i * 3] = p.x;
    pts[i * 3 + 1] = p.y;
    pts[i * 3 + 2] = p.z;
  }
  return pts;
}

// Per-vertex color ramp aligned with computeAgentTrailPoints: full color at the
// head (newest) fading to black at the tail. `rgb` is a [r,g,b] triple in 0..1.
// Pairs with an additive-blended lineBasicMaterial so black reads as transparent.
export function computeTrailColors(rgb, samples = AGENT_MOTION.trailSamples) {
  const n = Math.max(2, samples);
  const colors = new Array(n * 3);
  for (let i = 0; i < n; i++) {
    const fade = 1 - i / (n - 1); // 1 at head .. 0 at tail
    colors[i * 3] = rgb[0] * fade;
    colors[i * 3 + 1] = rgb[1] * fade;
    colors[i * 3 + 2] = rgb[2] * fade;
  }
  return colors;
}
