/**
 * Render a perpetual work-detector skip-cause map
 * ({ 'needs-input': 49, blocked: 17, … }) as a compact human string, largest
 * cause first. The one definition shared by every surface that answers "why
 * did N open issues yield zero work" — the park log line (taskSchedule.js),
 * the gate log (cosTaskGenerator.js), the on-demand toast, and the work-item
 * picker — so they cannot drift apart in wording. `excludeCause` drops one
 * cause from the rendering for callers that already show it through another
 * channel (the toast excludes `in-flight` because `counts.inFlight` carries
 * it). Returns '' for an empty/absent map.
 */
export function formatSkipCauses(skipCauses, maxCauses = 3, excludeCause = null) {
  if (!skipCauses || typeof skipCauses !== 'object') return '';
  return Object.entries(skipCauses)
    .filter(([cause, n]) => cause !== excludeCause && Number.isFinite(n) && n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxCauses)
    .map(([cause, n]) => `${n} ${cause}`)
    .join(', ');
}
