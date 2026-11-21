/**
 * LoRA adapter-effect report: normalization, freshness and verdict rules. The measurement lives in
 * `scripts/ml/lora_effect_probe.py` (needs numpy).
 *
 * This module owns what PortOS decides ABOUT a measurement, identical for a fresh probe result or a sidecar
 * written by an older install. It answers "does the adapter change anything" (a structurally valid LoRA can have
 * all-zero `lora_B` or NaN deltas) before a multi-minute render.
 *
 * Finite-safety holds both ways: the probe skips non-finite module totals, and this module refuses any non-finite number that reaches it anyway (hand-edited sidecar, future probe).
 * Only `zero` blocks a render; `nonfinite` is reported but not refused, and there is deliberately no "weak" verdict, which would refuse working subtle LoRAs.
 */

import { isPlainObject } from './objects.js';

// Bumped in lockstep with PROBE_VERSION in scripts/ml/lora_effect_probe.py; a cached report with another version is dropped and re-probed, not reinterpreted.
export const LORA_EFFECT_PROBE_VERSION = 1;

export const LORA_EFFECT_STATUSES = Object.freeze({
  // At least one finite, non-zero module measurement.
  OK: 'ok',
  // Measurements exist and every one is exactly zero — provably inert.
  ZERO: 'zero',
  // Modules were found but every measurement was NaN/Infinity.
  NONFINITE: 'nonfinite',
  // No measurable LoRA module pairs (not a LoRA, unsupported dtype, truncated).
  UNREADABLE: 'unreadable',
  // The probe could not run at all (no interpreter with numpy, timeout, crash).
  // Never a statement about the adapter — only about this machine.
  UNMEASURABLE: 'unmeasurable',
});

export const LORA_EFFECT_STATUS_VALUES = Object.freeze(Object.values(LORA_EFFECT_STATUSES));

export const isKnownLoraEffectStatus = (status) => LORA_EFFECT_STATUS_VALUES.includes(status);

// Non-finite in, null out; the typeof check pins the type (numeric strings and booleans must not pass).
const finiteOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

const nonNegativeInt = (value) => {
  const n = finiteOrNull(value);
  return n == null || n < 0 ? 0 : Math.floor(n);
};

// A non-object payload yields null; an unrecognized `status` degrades to `unmeasurable`. `sizeBytes`/`mtimeMs`/`measuredAt` are stamped by the caller (the probe doesn't own the cache key).
export const normalizeLoraEffectReport = (raw, { sizeBytes = null, mtimeMs = null, measuredAt = null } = {}) => {
  if (!isPlainObject(raw)) return null;
  const declared = isKnownLoraEffectStatus(raw.status) ? raw.status : LORA_EFFECT_STATUSES.UNMEASURABLE;
  const measured = nonNegativeInt(raw.measured);
  const zeroModules = nonNegativeInt(raw.zeroModules);
  const skippedNonFinite = nonNegativeInt(raw.skippedNonFinite);
  const skippedUnsupported = nonNegativeInt(raw.skippedUnsupported);
  // `zero` is the only status that refuses a render, so it must mean the WHOLE adapter is provably inert: at least one measurement, all zero, nothing skipped
  // (an unread module may carry the effect). Mirrors scripts/ml/lora_effect_probe.py and is restated because a sidecar is untrusted input.
  const zeroIsBacked = measured > 0
    && zeroModules === measured
    && skippedNonFinite === 0
    && skippedUnsupported === 0;
  const status = declared === LORA_EFFECT_STATUSES.ZERO && !zeroIsBacked
    ? LORA_EFFECT_STATUSES.UNMEASURABLE
    : declared;
  // Statistics exist only alongside a measurement, so "no data" never reads as "measured 0.0" (which would turn an unmeasurable adapter into a refusal).
  const stat = (value) => (measured > 0 ? finiteOrNull(value) : null);
  return {
    probeVersion: nonNegativeInt(raw.probeVersion),
    status,
    modules: nonNegativeInt(raw.modules),
    measured,
    skippedNonFinite,
    skippedUnsupported,
    zeroModules,
    medianRms: stat(raw.medianRms),
    maxRms: stat(raw.maxRms),
    reason: typeof raw.reason === 'string' && raw.reason ? raw.reason : null,
    sizeBytes: finiteOrNull(sizeBytes),
    mtimeMs: finiteOrNull(mtimeMs),
    measuredAt: typeof measuredAt === 'string' && measuredAt ? measuredAt : null,
  };
};

// Module-private so `readCachedLoraEffectReport` is the only way to ask and no caller trusts an unnormalized report.
// Key is probe version + size AND mtime (from the caller's existing `stat`): size alone misses a same-size replacement that would leave a stale `zero` blocking renders.
// Not a hash: hashing every LoRA on every list costs far more than the diagnostic is worth, and the user can force a re-measure.
const isLoraEffectReportFresh = (report, { sizeBytes, mtimeMs } = {}) => {
  if (!isPlainObject(report)) return false;
  if (report.probeVersion !== LORA_EFFECT_PROBE_VERSION) return false;
  const matches = (cached, actual) => {
    const a = finiteOrNull(cached);
    const b = finiteOrNull(actual);
    return a != null && b != null && a === b;
  };
  return matches(report.sizeBytes, sizeBytes) && matches(report.mtimeMs, mtimeMs);
};

// Never probes: `listLoras()` calls this per entry and must not fan out into one Python child per adapter.
export const readCachedLoraEffectReport = (raw, { sizeBytes, mtimeMs } = {}) => {
  const report = normalizeLoraEffectReport(raw, {
    sizeBytes: raw?.sizeBytes,
    mtimeMs: raw?.mtimeMs,
    measuredAt: raw?.measuredAt,
  });
  return isLoraEffectReportFresh(report, { sizeBytes, mtimeMs }) ? report : null;
};

// Only a measured, entirely-zero adapter qualifies. Everything else is permissive: `unmeasurable` says nothing about the file, `unreadable` belongs to the key-layout gate,
// and `nonfinite` may still be worth rendering; refusing unmeasured adapters would stop a machine without numpy from rendering.
export const loraEffectIssue = (report) => {
  if (!report || report.status !== LORA_EFFECT_STATUSES.ZERO) return null;
  return report.reason
    || 'every measurable module in it has exactly zero effect, so fusing it would change nothing';
};

export const formatLoraEffect = (report) => {
  if (!report) return 'not measured';
  // Check both statistics: normalize nulls non-finite values, and `null.toExponential()` in a render path crashes.
  if (report.measured <= 0 || !Number.isFinite(report.medianRms) || !Number.isFinite(report.maxRms)) {
    return `${report.status}${report.reason ? `: ${report.reason}` : ''}`;
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
