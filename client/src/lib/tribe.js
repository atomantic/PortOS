// Pure Tribe domain helpers shared by the Tribe page and its circle-map
// visualization. Rings are Dunbar-inspired concentric circles (support is the
// innermost / closest, village the outermost / weak ties). The ring `cadenceDays`
// defaults mirror DEFAULT_RING_CADENCE in server/services/tribe.js — keep in sync.

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
export function daysBetween(date) {
  if (!date) return null;
  const start = new Date(`${date}T00:00:00`);
  if (Number.isNaN(start.getTime())) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor((today - start) / 86400000);
}

// Cadence health for a contact: missing / overdue / soon (<=7d) / steady.
// `daysRemaining` is cadenceDays - elapsed (negative once overdue); null when
// there's no recorded last contact (distinct from a 0-days-remaining contact).
export function contactStatus(contact) {
  // External people carry no care cadence — never nag about an overdue nemesis.
  if (contact.ring === 'external') return { label: 'External', tone: 'text-slate-400', state: 'external', daysRemaining: null };
  const elapsed = daysBetween(contact.lastContact);
  if (elapsed == null) return { label: 'No touchpoint', tone: 'text-gray-300', state: 'missing', daysRemaining: null };
  const daysRemaining = Number(contact.cadenceDays || 45) - elapsed;
  if (daysRemaining < 0) return { label: `${Math.abs(daysRemaining)}d overdue`, tone: 'text-rose-300', state: 'overdue', daysRemaining };
  if (daysRemaining <= 7) return { label: `${daysRemaining}d left`, tone: 'text-amber-300', state: 'soon', daysRemaining };
  return { label: `${daysRemaining}d left`, tone: 'text-emerald-300', state: 'steady', daysRemaining };
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
