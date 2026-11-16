/**
 * How the LoRA manager card renders an adapter-effect measurement (#4872).
 *
 * `LORA_EFFECT_STATUSES` is re-exported from `server/lib/loraEffect.js`; `LORA_EFFECT_BADGES` +
 * `loraEffectBadge(status)` (only `zero` is styled as an error, because only `zero` refuses a render
 * server-side) and `loraEffectDetail(report)` are client-only — the detail line returns `null` when
 * the badge already says everything, where the server's `formatLoraEffect` always returns a sentence
 * for its log.
 */

/**
 * Status vocabulary re-exported from `server/lib/loraEffect.js` (the server measures and records the report, so a new verdict reaches the badge table without a second edit).
 */
export { LORA_EFFECT_STATUSES } from '../../../server/lib/loraEffect.js';

// Badge text + Tailwind tone per status: presentation is client-only but lives beside the mirrored status list so a new verdict can't render as a bare slug (one table, not two parallel maps that would drift).
export const LORA_EFFECT_BADGES = Object.freeze({
  // Only `zero` refuses a render server-side, so only `zero` is an error; `nonfinite` is a broken adapter that still renders (warning).
  ok: { label: 'Active', tone: 'text-port-success' },
  zero: { label: 'No effect', tone: 'text-port-error' },
  nonfinite: { label: 'Diverged', tone: 'text-port-warning' },
  unreadable: { label: 'Unreadable', tone: 'text-port-warning' },
  unmeasurable: { label: 'Not measurable', tone: 'text-gray-500' },
});

export const loraEffectBadge = (status) => LORA_EFFECT_BADGES[status]
  || { label: status || 'Unknown', tone: 'text-gray-400' };

/**
 * One-line detail for a measurement, worded like the server's `formatLoraEffect` log line but returning `null` where that returns a status, so a caller can omit the separator rather than print "Unreadable — Unreadable".
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
