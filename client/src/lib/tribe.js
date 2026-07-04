// Pure Tribe domain helpers shared by the Tribe page and its circle-map
// visualization. Rings are Dunbar-inspired concentric circles (support is the
// innermost / closest, village the outermost / weak ties). The ring `cadenceDays`
// defaults mirror DEFAULT_RING_CADENCE in server/services/tribe.js — keep in sync.
//
// The cadence STATE MACHINE (external/missing/overdue/soon/steady) lives in the
// shared, authoritative `tribeCadence.js` (mirrored from server/lib/tribeCadence.js)
// so the page, the Tribe Care dashboard widget, and the proactive-alert check all
// route through one implementation. `contactStatus` below only layers presentation
// (label/tone) on top of that shared `cadenceStatus` — do not re-implement the rules.
import { cadenceStatus, daysSinceDate } from './tribeCadence.js';

// The four inner rings are the Dunbar tribe (capped, care-cadenced). `external` is
// a fifth, uncapped classification OUTSIDE the tribe — people known or previously
// known who've moved out of your circle (drifted acquaintances, a nemesis). It
// carries no care cadence (`cap: null`, and `contactStatus` returns an 'external'
// state instead of overdue/soon), and the UI keeps it out of the care queue.
export const RINGS = [
  { id: 'support', label: 'Support', cap: 5, cadenceDays: 7, tone: 'text-rose-300', bg: 'bg-rose-500/10', border: 'border-rose-500/30', hex: '#fda4af' },
  { id: 'core', label: 'Core', cap: 15, cadenceDays: 21, tone: 'text-amber-300', bg: 'bg-amber-500/10', border: 'border-amber-500/30', hex: '#fcd34d' },
  { id: 'tribe', label: 'Tribe', cap: 50, cadenceDays: 45, tone: 'text-teal-300', bg: 'bg-teal-500/10', border: 'border-teal-500/30', hex: '#5eead4' },
  { id: 'village', label: 'Village', cap: 150, cadenceDays: 90, tone: 'text-sky-300', bg: 'bg-sky-500/10', border: 'border-sky-500/30', hex: '#7dd3fc' },
  { id: 'external', label: 'External', cap: null, cadenceDays: 365, tone: 'text-slate-400', bg: 'bg-slate-500/10', border: 'border-slate-500/30', hex: '#94a3b8' },
];

// Rings inside the active tribe (everything except `external`) — the set the care
// queue, capacity, and overdue/soon counts operate over.
export const TRIBE_RINGS = RINGS.filter((ring) => ring.id !== 'external');

export const ENERGY = [
  { id: 'nourishing', label: 'Nourishing', className: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30', hex: '#6ee7b7' },
  { id: 'steady', label: 'Steady', className: 'text-sky-300 bg-sky-500/10 border-sky-500/30', hex: '#7dd3fc' },
  { id: 'complex', label: 'Complex', className: 'text-amber-300 bg-amber-500/10 border-amber-500/30', hex: '#fcd34d' },
  { id: 'draining', label: 'Draining', className: 'text-rose-300 bg-rose-500/10 border-rose-500/30', hex: '#fda4af' },
];

// Whole days from an ISO date (YYYY-MM-DD) to today, or null if unparseable.
// Backed by the shared `daysSinceDate` so the client and server compute
// elapsed days identically.
export const daysBetween = daysSinceDate;

// Cadence health for a contact: missing / overdue / soon (<=7d) / steady, plus
// an `external` state that never nags. The state/`daysRemaining` come straight
// from the shared `cadenceStatus`; this wrapper only attaches the UI label +
// Tailwind tone so there is exactly one implementation of the cadence rules.
const STATUS_PRESENTATION = {
  external: { label: 'External', tone: 'text-slate-400' },
  missing: { label: 'No touchpoint', tone: 'text-gray-300' },
  overdue: { tone: 'text-rose-300' },
  soon: { tone: 'text-amber-300' },
  steady: { tone: 'text-emerald-300' },
};
export function contactStatus(contact) {
  const { state, daysRemaining } = cadenceStatus(contact);
  const { label, tone } = STATUS_PRESENTATION[state];
  if (label) return { label, tone, state, daysRemaining };
  const dueLabel = state === 'overdue' ? `${Math.abs(daysRemaining)}d overdue` : `${daysRemaining}d left`;
  return { label: dueLabel, tone, state, daysRemaining };
}

// Status → SVG stroke color for the circle-map nodes.
export const STATUS_HEX = {
  missing: '#9ca3af',
  overdue: '#f87171',
  soon: '#fbbf24',
  steady: '#34d399',
  external: '#94a3b8',
};

export function ringFor(id) {
  return RINGS.find((ring) => ring.id === id) || RINGS[2];
}

export function energyFor(id) {
  return ENERGY.find((energy) => energy.id === id) || ENERGY[1];
}

export function tagsToArray(tags) {
  if (Array.isArray(tags)) return tags.map((tag) => String(tag).trim()).filter(Boolean);
  return String(tags || '').split(',').map((tag) => tag.trim()).filter(Boolean);
}

export function tagsToInput(tags) {
  return tagsToArray(tags).join(', ');
}

// Up to two uppercase initials for a node glyph; falls back to '?'.
export function initialsFor(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
