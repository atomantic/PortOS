// Authoritative, pure cadence rules for the Tribe care system — the single
// source of truth for "who needs care." Consumed on the server by
// `personCadenceStatus` / `getCareSummary` (server/services/tribe.js → the
// proactive-alerts check + the Tribe Care dashboard widget) and re-exported by
// `client/src/lib/tribeCadence.js` for the client bundle (Tribe page + circle
// map), so both sides run this code rather than two copies of it. Keep it pure:
// no Node built-in, nothing outside `server/lib`.

// The four inner rings owe a care cadence; `external` (former contacts, a
// nemesis) is outside the tribe and is never nagged.
export const DEFAULT_CADENCE_DAYS = 45;
// A member with <= this many days left before their next check-in is "soon".
export const SOON_WINDOW_DAYS = 7;

// Default check-in cadence (days) per ring. Used by server/services/tribe.js
// to set default cadence_days when creating new people, and mirrored on the
// client in `client/src/lib/tribe.js` (the RINGS array's `cadenceDays`).
// The SQL column default is a flat 45 (`cadence_days` in db.js / init-db.sql)
// because the ring-aware default is resolved here before insert.
export const DEFAULT_RING_CADENCE = {
  support: 7,
  core: 21,
  tribe: 45,
  village: 90,
  // `external` is for people outside the active tribe (former contacts, a nemesis):
  // no care cadence is owed, so this default is a neutral yearly nudge and the UI
  // excludes external people from the care queue entirely.
  external: 365,
};

// Whole days from an ISO date (YYYY-MM-DD…) to today, or null when unparseable.
export function daysSinceDate(dateStr) {
  if (!dateStr) return null;
  const start = new Date(`${String(dateStr).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(start.getTime())) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor((today - start) / 86400000);
}

// Cadence health for a tribe member: external / missing / overdue / soon /
// steady. `daysRemaining` is cadenceDays - elapsed (negative once overdue);
// null when there's no recorded last contact (distinct from a 0-days-remaining
// member). `daysOverdue` is 0 unless overdue, and null for a `missing`
// (never-contacted) member so callers can sort those to the top without a
// magic number. External members carry no cadence.
export function cadenceStatus(entity) {
  if (entity.ring === 'external') return { state: 'external', daysRemaining: null, daysOverdue: 0 };
  const elapsed = daysSinceDate(entity.lastContact);
  if (elapsed == null) return { state: 'missing', daysRemaining: null, daysOverdue: null };
  const daysRemaining = Number(entity.cadenceDays || DEFAULT_CADENCE_DAYS) - elapsed;
  if (daysRemaining < 0) return { state: 'overdue', daysRemaining, daysOverdue: Math.abs(daysRemaining) };
  if (daysRemaining <= SOON_WINDOW_DAYS) return { state: 'soon', daysRemaining, daysOverdue: 0 };
  return { state: 'steady', daysRemaining, daysOverdue: 0 };
}
