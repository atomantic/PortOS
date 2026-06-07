/**
 * PostgreSQL TIMESTAMPTZ bind-safety helper.
 *
 * A TIMESTAMPTZ column rejects a bind value that isn't a calendar-valid,
 * in-range timestamp — and when that bind happens inside boot-time schema
 * init / data import, one bad legacy value can throw and block the whole
 * backend from coming up. This helper turns any candidate into a value
 * Postgres will always accept, or falls back.
 *
 * Extracted from the Creative Director migration (#997), where it was hardened
 * across several review rounds against `Date.parse` quirks. Shared so other
 * DB-backed stores that mirror a hand-editable JSON timestamp into a typed
 * column (e.g. the media asset index, #1000) reuse the exact same guards
 * instead of re-deriving them and drifting.
 */

/**
 * Safe ISO timestamp for a TIMESTAMPTZ column, falling back to `fallback`.
 *
 * Returns the NORMALIZED canonical ISO string (`Date#toISOString`), not the raw
 * input — because `Date.parse` accepts out-of-range calendar dates by rolling
 * them over (`2026-02-31` → Mar 3), and echoing that raw string would still
 * make Postgres reject the TIMESTAMPTZ bind and throw. Normalizing guarantees a
 * value PG always accepts.
 *
 * Year-range guard: `toISOString()` emits a plain 4-digit year (`YYYY-…`) only
 * for years 0000–9999, and a SIGNED expanded form (`±YYYYYY-…`) otherwise. We
 * accept ONLY a 4-digit year 0001–9999 — those are all well inside Postgres
 * TIMESTAMPTZ range. Rejected (→ fallback): the signed expanded forms
 * (`-100000-…`, `+275760-…`, which `Date.parse` accepts but PG can't bind) AND
 * year `0000` (Postgres has no Gregorian year zero — AD 1–99 are `0001`–`0099`,
 * so a normalized `0000-…` would still be bind-rejected).
 */
export function mirrorTimestamp(value, fallback) {
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) {
      const iso = new Date(ms).toISOString();
      if (/^\d{4}-/.test(iso) && !iso.startsWith('0000-')) return iso;
    }
  }
  return fallback;
}
