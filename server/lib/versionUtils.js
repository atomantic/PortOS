/**
 * Version-string comparison shared across PortOS — the self-update checker
 * (upstream PortOS releases) and the local-LLM backend update detector (Ollama
 * GitHub releases) both need the same semver ordering, so it lives here rather
 * than being re-implemented per consumer.
 */

/**
 * Compare two semver strings. Returns:
 *  -1 if a < b, 0 if equal, 1 if a > b
 *
 * Handles the three-segment core plus pre-release precedence (`1.0.0` >
 * `1.0.0-rc.1`, numeric pre-release identifiers sort before string ones) and
 * ignores build metadata (`+build`). Inputs must NOT carry a leading `v` — strip
 * it at the call site (a `v` makes the leading numeric segment NaN→0).
 */
export function compareSemver(a, b) {
  const extractParts = (v) => {
    const noBuild = v.split('+')[0];
    const hyphenIdx = noBuild.indexOf('-');
    const core = hyphenIdx === -1 ? noBuild : noBuild.slice(0, hyphenIdx);
    const pre = hyphenIdx === -1 ? null : noBuild.slice(hyphenIdx + 1);
    return { nums: core.split('.').map(Number), pre: pre || null };
  };
  const comparePreRelease = (preA, preB) => {
    const segsA = preA.split('.');
    const segsB = preB.split('.');
    const len = Math.max(segsA.length, segsB.length);
    for (let i = 0; i < len; i++) {
      if (i >= segsA.length) return -1; // fewer segments = lower precedence
      if (i >= segsB.length) return 1;
      const numA = /^\d+$/.test(segsA[i]) ? Number(segsA[i]) : null;
      const numB = /^\d+$/.test(segsB[i]) ? Number(segsB[i]) : null;
      // Numeric identifiers sort before string identifiers
      if (numA !== null && numB !== null) {
        if (numA < numB) return -1;
        if (numA > numB) return 1;
      } else if (numA !== null) {
        return -1;
      } else if (numB !== null) {
        return 1;
      } else {
        if (segsA[i] < segsB[i]) return -1;
        if (segsA[i] > segsB[i]) return 1;
      }
    }
    return 0;
  };
  const pa = extractParts(a);
  const pb = extractParts(b);
  for (let i = 0; i < 3; i++) {
    const na = pa.nums[i] || 0;
    const nb = pb.nums[i] || 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  // Equal core versions: no pre-release > pre-release (1.0.0 > 1.0.0-rc.1)
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  if (pa.pre && pb.pre) return comparePreRelease(pa.pre, pb.pre);
  return 0;
}
