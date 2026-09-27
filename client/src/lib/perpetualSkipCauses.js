/**
 * Render a perpetual work-detector skip-cause map
 * ({ 'needs-input': 49, blocked: 17, … }) as a compact human string, largest
 * cause first. Mirrors `formatSkipCauses` in server/services/cosTaskGenerator.js
 * — the server renders it into park log lines, the client into the on-demand
 * "Run" toast, and both must answer "why did N open issues yield zero work"
 * with the same words. Returns '' for an empty/absent map.
 */
export function formatSkipCauses(skipCauses, maxCauses = 3) {
  if (!skipCauses || typeof skipCauses !== 'object') return '';
  return Object.entries(skipCauses)
    .filter(([, n]) => Number.isFinite(n) && n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxCauses)
    .map(([cause, n]) => `${n} ${cause}`)
    .join(', ');
}
