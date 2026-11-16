/**
 * PostgreSQL TIMESTAMPTZ bind-safety helper: `mirrorTimestamp(value, fallback)`.
 *
 * PostgreSQL TIMESTAMPTZ bind-safety: `mirrorTimestamp(value, fallback)` coerces a hand-editable timestamp into a value TIMESTAMPTZ always accepts (or falls back), guarding boot-time binds against `Date.parse` rollover and out-of-range years (a bad legacy value in boot-time schema init / data import can block the whole backend).
 * Extracted from the Creative Director migration (#997), hardened over several review rounds, and shared by DB-backed stores mirroring a hand-editable JSON timestamp into a typed column (e.g. the media asset index, #1000).
 */

/**
 * Safe ISO timestamp for a TIMESTAMPTZ column, falling back to `fallback`. Returns the NORMALIZED canonical ISO string (`Date#toISOString`), not the raw input: `Date.parse` rolls out-of-range calendar dates over (`2026-02-31` → Mar 3) and echoing the raw string would still make PG reject the bind.
 * Year-range guard: only a 4-digit year 0001–9999 is accepted (well inside PG range); the signed expanded forms (`-100000-…`, `+275760-…`, accepted by `Date.parse` but unbindable) and year `0000` (PG has no Gregorian year zero) fall back.
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
