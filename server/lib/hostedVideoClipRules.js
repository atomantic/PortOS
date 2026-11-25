/** Shared duration and resolution rules for hosted video catalogs. */

/** Whole-second picker choices; source-audio models take their length from the audio. */
export function durationLengths(rule) {
  if (!rule || rule.kind === 'audio') return [];
  if (rule.kind === 'enum') return [...rule.values];
  return Array.from({ length: rule.max - rule.min + 1 }, (_, i) => rule.min + i);
}

/** Cover the requested shot span if possible, with tolerance for frame-time arithmetic. */
export function coverOrLongest(rule, seconds) {
  if (!rule || rule.kind === 'audio') return null;
  const n = Number(seconds);
  if (seconds == null || seconds === '' || !Number.isFinite(n) || n <= 0) return rule.defaultSec;
  if (rule.kind === 'enum') return rule.values.find((v) => v >= n - 1e-6) ?? rule.values[rule.values.length - 1];
  return Math.min(rule.max, Math.max(rule.min, Math.ceil(n - 1e-6)));
}

/** Keep the catalog's spelling for a supported size; otherwise use its default. */
export function matchResolution(options, fallback, requested) {
  const want = typeof requested === 'string' ? requested.trim().toLowerCase() : '';
  return options.find((option) => option.toLowerCase() === want) || fallback;
}
