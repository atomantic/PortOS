// Stable, non-negative DJB2-style string hash. Used to derive deterministic
// per-entity variation (process seeds, neon accent colors, flow-link jitter)
// without Math.random, so renders are reproducible across reloads and frames.
export function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}
