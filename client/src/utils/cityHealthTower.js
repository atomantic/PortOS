// Pure, deterministic helpers for CyberCity's biometric vitals tower (roadmap 2.9): a
// stacked landmark in a far-southeast wellness district whose segments visualize the
// latest Apple Health metrics (heart rate / steps / sleep / active calories). Each
// segment's height and glow track that metric's normalized level; a metric with no data
// reads dim (absent) — distinct from a metric whose value is legitimately zero (e.g. a
// 0-step day). No three.js / React imports so the topology is unit-testable (mirrors
// cityBackupVault.js / cityTaskQueue.js).

import { PARCELS } from './cityPlan';

export const TOWER = {
  position: PARCELS.health.anchor, // far southeast — a wellness district anchored by the master plan (cityPlan.js)
  baseRadius: 3.2,
  segmentHeight: 3, // height of a fully-lit (level === 1) segment
  segmentGap: 0.25, // vertical gap between stacked segments
  minHeight: 0.35, // floor height so an absent/zero segment still reads as a thin disc, not nothing
};

// One descriptor per visualized metric, in stacking order (bottom → top). `key` is the
// Apple Health metric name as returned by GET /api/health/metrics/latest; `target` is the
// value mapped to a full (level === 1) segment; `color` reuses the meatspace health palette
// (which itself maps to PortOS tokens) so the tower speaks the same visual language.
export const METRICS = [
  { key: 'heart_rate', label: 'HEART', unit: 'bpm', target: 120, color: '#ef4444' }, // port-error red — the pulsing segment
  { key: 'step_count', label: 'STEPS', unit: 'steps', target: 10000, color: '#3b82f6' }, // port-accent blue
  { key: 'active_energy', label: 'CALORIES', unit: 'Cal', target: 600, color: '#f59e0b' }, // port-warning amber
  { key: 'sleep_analysis', label: 'SLEEP', unit: 'hrs', target: 8, color: '#8b5cf6' }, // violet
];

const DIM_COLOR = '#475569'; // slate — an absent (no-data) segment

const clamp01 = (n) => Math.max(0, Math.min(1, n));

// Normalize a raw metric value to a 0..1 level against its target, clamped. Returns null
// for a non-finite input so callers can distinguish "no usable number" from a real 0.
export function normalizeLevel(value, target) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (typeof target !== 'number' || !Number.isFinite(target) || target <= 0) return null;
  return clamp01(value / target);
}

// Derive a single segment's view-model from the latest-metrics payload entry. The endpoint
// returns `{ date, value } | null` per metric — null (or a missing key) is the "absent"
// sentinel and must NOT collapse into the same state as a present value of 0.
export function computeSegment(descriptor, entry) {
  // Absent: key missing, null entry, or a non-numeric/absent value field.
  const rawValue = entry && typeof entry === 'object' ? entry.value : undefined;
  const hasValue = typeof rawValue === 'number' && Number.isFinite(rawValue);
  // normalizeLevel returns null when the value/target can't be normalized; an absent or
  // unnormalizable segment renders at level 0 (its `present` flag disambiguates from a real 0).
  const level = (hasValue ? normalizeLevel(rawValue, descriptor.target) : null) ?? 0;
  return {
    key: descriptor.key,
    label: descriptor.label,
    unit: descriptor.unit,
    present: hasValue,
    value: hasValue ? rawValue : null,
    date: entry && typeof entry === 'object' ? entry.date ?? null : null,
    level, // 0..1; 0 for both an absent segment and a legitimate zero — `present` disambiguates
    color: hasValue ? descriptor.color : DIM_COLOR,
    // Lit segment height scales with level (with a thin floor so it's always visible); an
    // absent segment collapses to the floor height and reads dim.
    height: TOWER.minHeight + (hasValue ? level : 0) * TOWER.segmentHeight,
    // Emissive intensity: present segments glow proportional to level (with a small base so
    // even a zero-value-but-present segment is faintly lit); absent segments stay dark.
    intensity: hasValue ? 0.25 + level * 0.75 : 0.08,
  };
}

// Full derived view-model for the component: a fixed base position plus a bottom→top stack
// of segments with their y offsets pre-computed. `latest` is the raw latest-metrics payload
// (`{ [metricKey]: { date, value } | null }`); a missing/non-object payload yields an
// all-absent tower rather than a crash.
export function computeHealthTower(latest) {
  const payload = latest && typeof latest === 'object' ? latest : {};
  let y = 0;
  const segments = METRICS.map((descriptor) => {
    const segment = computeSegment(descriptor, payload[descriptor.key]);
    const placed = { ...segment, y: y + segment.height / 2 };
    y += segment.height + TOWER.segmentGap;
    return placed;
  });
  const presentCount = segments.filter((s) => s.present).length;
  // The heart-rate segment drives the heartbeat pulse; pre-extract its level/intensity/
  // presence so the component's per-frame loop never re-searches the segment list.
  const heart = segments.find((s) => s.key === 'heart_rate');
  return {
    position: TOWER.position,
    baseRadius: TOWER.baseRadius,
    segments,
    totalHeight: y - (segments.length ? TOWER.segmentGap : 0), // top of the highest segment
    presentCount,
    hasData: presentCount > 0,
    heartPresent: heart?.present ?? false,
    heartLevel: heart?.level ?? 0,
    heartIntensity: heart?.intensity ?? 0,
  };
}
