// Pure, deterministic helpers for OpenWorld's productivity district: a glowing
// obelisk whose height reflects today's completed agent tasks and whose color
// reflects recent velocity. No three.js / React imports.

import { PARCELS } from './openWorldPlan';

export const MONUMENT = {
  position: PARCELS.productivity.anchor, // southwest district — anchored by the master plan (openWorldPlan.js)
  baseWidth: 5, // footprint of the obelisk base
  minHeight: 3,
  maxHeight: 26,
  taskCap: 20,
};

// Velocity tiers drive the monument color so the district speaks recent throughput at a
// glance. `velocity.percentage` from the quick-summary payload is "today vs. historical
// average", where 100 ≈ on pace. Colors reuse the PortOS Tailwind design tokens.
const TIERS = [
  { min: 120, key: 'surging', color: '#22c55e', label: 'SURGING' }, // port-success — well above pace
  { min: 80, key: 'steady', color: '#3b82f6', label: 'STEADY' }, // port-accent — roughly on pace
  { min: 40, key: 'slowing', color: '#f59e0b', label: 'SLOWING' }, // port-warning — below pace
  { min: 0, key: 'idle', color: '#ef4444', label: 'IDLE' }, // port-error — little/no recent throughput
];

const ABSENT_COLOR = '#64748b'; // slate — no productivity data at all

const clamp01 = (n) => Math.max(0, Math.min(1, n));

// Coerce a value to a finite number or return null (the "absent" sentinel) so callers can
// distinguish a missing/garbage field from a legitimate 0.
function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Map today's completed task count to a 0..1 fill against the cap.
export function throughputLevel(tasks, cap = MONUMENT.taskCap) {
  const count = finiteOrNull(tasks);
  if (count === null) return null;
  if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) return null;
  return clamp01(count / cap);
}

// Classify recent velocity into a color tier. A non-numeric velocity (absent) falls through
// to the lowest tier's color via the caller; here we only resolve a present number.
export function velocityTier(velocity) {
  const v = finiteOrNull(velocity);
  if (v === null) return null;
  return TIERS.find((t) => v >= t.min) || TIERS[TIERS.length - 1];
}

// Full derived view-model for the component. `productivityData` is the quick-summary payload
// (`{ today: { completed, ... }, velocity: { percentage, ... } }`).
export function computeProductivityMonument(productivityData) {
  const payload = productivityData && typeof productivityData === 'object' ? productivityData : {};
  const todaySrc = payload.today && typeof payload.today === 'object' ? payload.today : {};
  const velocitySrc = payload.velocity && typeof payload.velocity === 'object' ? payload.velocity : {};

  const completedToday = finiteOrNull(todaySrc.completed);
  const level = throughputLevel(completedToday) ?? 0;
  const present = completedToday !== null;

  const tier = velocityTier(velocitySrc.percentage);
  // Absent productivity data reads slate/dim; a present payload always gets a tier color
  // (idle red when velocity is missing-but-data-exists, so the monument never goes dark on
  // a real-but-quiet day).
  const color = present ? (tier?.color ?? TIERS[TIERS.length - 1].color) : ABSENT_COLOR;
  const tierLabel = present ? (tier?.label ?? TIERS[TIERS.length - 1].label) : 'NO DATA';

  const height = MONUMENT.minHeight + level * (MONUMENT.maxHeight - MONUMENT.minHeight);
  // A present-but-quiet day still glows faintly; absent data is nearly dark.
  const intensity = present ? 0.3 + level * 0.7 : 0.1;

  let throughputLabel;
  if (!present) throughputLabel = 'NO DATA';
  else if (completedToday === 0) throughputLabel = 'NO TASKS TODAY';
  else throughputLabel = `${completedToday} TASK${completedToday === 1 ? '' : 'S'} TODAY`;

  return {
    position: MONUMENT.position,
    baseWidth: MONUMENT.baseWidth,
    height,
    level,
    present,
    completedToday,
    color,
    intensity,
    tierKey: present ? (tier?.key ?? TIERS[TIERS.length - 1].key) : 'absent',
    tierLabel,
    throughputLabel,
    surging: tier?.key === 'surging',
  };
}
