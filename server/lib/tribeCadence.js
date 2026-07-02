// Authoritative, pure cadence rules for the Tribe care system — the single
// source of truth for "who needs care." Consumed on the server by
// `personCadenceStatus` / `getCareSummary` (server/services/tribe.js → the
// proactive-alerts check + the Tribe Care dashboard widget) and mirrored to
// `client/src/lib/tribeCadence.js` for the client bundle (Tribe page + circle
// map). The mirror must produce IDENTICAL output; the cross-boundary contract
// test (client/src/lib/tribeCadence.contract.test.js) imports both copies and
// asserts they never drift. No Node-only deps — keep this file pure.

// The four inner rings owe a care cadence; `external` (former contacts, a
// nemesis) is outside the tribe and is never nagged.
export const DEFAULT_CADENCE_DAYS = 45;
// A member with <= this many days left before their next check-in is "soon".
export const SOON_WINDOW_DAYS = 7;

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
