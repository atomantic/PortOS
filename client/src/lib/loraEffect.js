/**
 * How the LoRA manager card renders an adapter-effect measurement (#4872).
 *
 * The status vocabulary is re-exported from `server/lib/loraEffect.js` — the
 * server measures and records the report, so a new verdict there reaches the
 * badge table below without a second edit. The badge tones and
 * `loraEffectDetail` are client-only: the server's `formatLoraEffect` always
 * returns a sentence for its log line, while the card needs `null` when the
 * badge already says everything (or it prints "Unreadable — unreadable").
 */
export { LORA_EFFECT_STATUSES } from '../../../server/lib/loraEffect.js';

// Badge text + Tailwind tone per status. Presentation is legitimately
// client-only, but it lives beside the mirrored status list so a new verdict
// can't render as a bare slug — one table rather than two parallel maps, which
// is the pair that would otherwise drift.
export const LORA_EFFECT_BADGES = Object.freeze({
  // Only `zero` refuses a render server-side, so only `zero` is styled as an
  // error. `nonfinite` is a genuinely broken adapter the user should see, but
  // it still renders — warning, not error.
  ok: { label: 'Active', tone: 'text-port-success' },
  zero: { label: 'No effect', tone: 'text-port-error' },
  nonfinite: { label: 'Diverged', tone: 'text-port-warning' },
  unreadable: { label: 'Unreadable', tone: 'text-port-warning' },
  unmeasurable: { label: 'Not measurable', tone: 'text-gray-500' },
});

export const loraEffectBadge = (status) => LORA_EFFECT_BADGES[status]
  || { label: status || 'Unknown', tone: 'text-gray-400' };

/**
 * One-line detail line for a measurement, worded like the server’s
 * `formatLoraEffect` log line but returning `null` where that returns a status.
 *
 * Returns `null` when there is nothing to add beyond the badge, so a caller can
 * omit the separator rather than printing "Unreadable — Unreadable".
 */
export const loraEffectDetail = (report) => {
  if (!report) return null;
  // Both statistics, not just `measured`: the server nulls a non-finite value
  // while leaving `measured` intact, so a measured report can still arrive with
  // no renderable number.
  if (!Number.isFinite(report.medianRms) || !Number.isFinite(report.maxRms)) {
    return report.reason || null;
  }
  const parts = [
    `median RMS ${report.medianRms.toExponential(2)}`,
    `max ${report.maxRms.toExponential(2)}`,
    `across ${report.measured} module(s)`,
  ];
  if (report.skippedNonFinite > 0) parts.push(`${report.skippedNonFinite} non-finite skipped`);
  if (report.skippedUnsupported > 0) parts.push(`${report.skippedUnsupported} unsupported skipped`);
  if (report.zeroModules > 0) parts.push(`${report.zeroModules} zero`);
  return parts.join(', ');
};
