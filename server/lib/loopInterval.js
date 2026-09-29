// Loop interval grammar shared by services/loops.js and the loop route schema,
// so the route rejects exactly what the service would.
export const MIN_INTERVAL_MS = 10_000;

export function parseInterval(str) {
  const match = String(str).match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d|ms)?$/i);
  if (!match) return null;
  const val = parseFloat(match[1]);
  const unit = (match[2] || 'm').toLowerCase();
  const multipliers = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Math.round(val * (multipliers[unit] || 60_000));
}

// True when `interval` (ms number or grammar string) resolves to >= MIN_INTERVAL_MS.
export function isValidLoopInterval(interval) {
  const ms = typeof interval === 'number' ? interval : parseInterval(interval);
  return Boolean(ms) && ms >= MIN_INTERVAL_MS;
}
