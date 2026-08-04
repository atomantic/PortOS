/**
 * Normalize the reset times emitted by the provider quota adapters. A missing
 * or ambiguous reset is deliberately represented as null: a scheduled quota
 * burn must park rather than guess that a provider is about to reset.
 *
 * `parseHumanReset` is the adapter-facing half — each provider adapter calls it
 * so `resetsAt` is ISO 8601 on the wire; `normalizeResetAt`/`hoursUntilReset`
 * are the consumer-facing half that does arithmetic on that instant.
 */

const HOUR_MS = 60 * 60 * 1000;

function hasExplicitZone(value) {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
}

function zoneOffsetMs(epochMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(epochMs));
  const offset = parts.find((part) => part.type === 'timeZoneName')?.value;
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(offset || '');
  if (!match) return null;
  return (Number(match[2]) * 60 + Number(match[3])) * 60 * 1000 * (match[1] === '+' ? 1 : -1);
}

/**
 * Reshape a human-rendered reset into something `Date.parse` accepts. These are
 * CLI panel strings, not machine formats, and two shapes off live CLIs defeat a
 * bare parse:
 *
 *   claude  `Aug 4 at 1:59pm`   — an " at " separator and a meridiem glued to
 *                                 the minutes; `Date.parse` returns NaN, so
 *                                 EVERY claude window read as "no window states
 *                                 a reset time" and the family could never burn.
 *   claude  `Jul 7 at 2pm`      — the same, on the hour: no minutes at all.
 *   grok    `August 10, 06:07`  — parses, but see `stampYear` below.
 *
 * Pure.
 */
function normalizeSeparators(value) {
  return value
    .replace(/\s+at\s+/gi, ' ')
    // `1:59pm` → `1:59 pm`, and `2pm` → `2:00 pm` (a bare hour with a meridiem
    // is not a time `Date.parse` accepts).
    .replace(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi, (_, hour, minute, meridiem) => `${hour}:${minute || '00'} ${meridiem}`);
}

/** The calendar year `now` falls in, as `timeZone` renders it (local when absent). */
function zoneYear(now, timeZone) {
  const at = new Date(now);
  if (!timeZone) return at.getFullYear();
  return Number(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).format(at));
}

/**
 * Replace the year of a wall-clock instant.
 *
 * A year-less string does NOT default to the current year — `Date.parse('Aug 4
 * 1:59 pm')` resolves to **2001**. The old roll-forward then fired against a
 * date 25 years in the past and landed on 2002, so a grok window reported
 * "already reset" forever. Stamping the year up front also fixes the offset
 * lookup: DST rules are per-year (US rules changed in 2007), so resolving a
 * 2026 reset through a 2001 instant's offset can be off by an hour.
 */
function stampYear(wallMs, year) {
  const date = new Date(wallMs);
  date.setUTCFullYear(year);
  return date.getTime();
}

/**
 * Resolve a human wall-clock reset string to an epoch instant in `timezone`
 * (the server's own zone when none is stated). Returns null when the string
 * states no parseable date/time.
 */
function resolveWallClock(raw, { now, timezone }) {
  const value = normalizeSeparators(raw);
  // Read the string's fields as if they were UTC, so the year can be corrected
  // before any zone offset is applied to them.
  const wall = Date.parse(`${value} UTC`);
  if (!Number.isFinite(wall)) return null;

  // The instant that wall clock names in the provider's zone — or, with no zone
  // stated, in the server's own (which is what `Date.parse` assumed before).
  const resolve = (wallMs) => {
    const offset = timezone ? zoneOffsetMs(wallMs, timezone) : -new Date(wallMs).getTimezoneOffset() * 60_000;
    return offset === null ? null : wallMs - offset;
  };

  // `null` year = the string states its own and needs no stamping.
  const year = /\b\d{4}\b/.test(value) ? null : zoneYear(now, timezone);
  const epochMs = resolve(year === null ? wall : stampYear(wall, year));
  // A year-less reset stamped with the current year can still land in the past
  // across a year boundary (a "Jan 2" reset read on Dec 31). Roll to the next
  // occurrence — re-resolving the offset, since it is a per-year lookup. The
  // hour of grace keeps a reset that just passed from being pushed a year out.
  if (year !== null && epochMs !== null && epochMs < now - HOUR_MS) return resolve(stampYear(wall, year + 1));
  return epochMs;
}

/**
 * Turn one provider CLI's human reset string into an ISO 8601 instant — the
 * shape every quota adapter is expected to put on the wire, so the client can
 * localize it and `normalizeResetAt` stays pure arithmetic.
 *
 * Call this from the ADAPTER (`parseLimitLine`, `parseGrokUsage`, …), not from
 * a shared choke point: a new provider dialect belongs in its own adapter.
 * Already-ISO input passes through (normalized to UTC), so it is idempotent.
 *
 * @param {string} value - e.g. `Aug 4 at 1:59pm`, `2pm`, `August 10, 06:07`
 * @param {{ now?: number, timezone?: string }} [opts] - `timezone` is the IANA
 *   zone the CLI rendered in (the server's own when absent); `now` anchors the
 *   year a year-less string omits.
 * @returns {string|null} ISO 8601 instant, or null when unparseable
 */
export function parseHumanReset(value, { now = Date.now(), timezone } = {}) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  const epochMs = hasExplicitZone(raw) ? Date.parse(raw) : resolveWallClock(raw, { now, timezone });
  return Number.isFinite(epochMs) ? new Date(epochMs).toISOString() : null;
}

/**
 * Every in-tree adapter now emits ISO, so this hits the `hasExplicitZone` fast
 * path. The wall-clock fallback stays for a limit that arrives from an older
 * federated peer (or a future adapter that hasn't migrated) — dropping it would
 * regress those to "no window states a reset time".
 *
 * @returns {{ epochMs: number|null, source: 'iso'|'parsed'|'unknown' }}
 */
export function normalizeResetAt(limit, { now = Date.now(), timeZone } = {}) {
  const raw = typeof limit?.resetsAt === 'string' ? limit.resetsAt.trim() : '';
  if (!raw) return { epochMs: null, source: 'unknown' };

  if (hasExplicitZone(raw)) {
    const epochMs = Date.parse(raw);
    return Number.isFinite(epochMs) ? { epochMs, source: 'iso' } : { epochMs: null, source: 'unknown' };
  }

  const epochMs = resolveWallClock(raw, { now, timezone: limit?.timezone || timeZone });
  return epochMs === null ? { epochMs: null, source: 'unknown' } : { epochMs, source: 'parsed' };
}

export function hoursUntilReset(limit, opts = {}) {
  const { epochMs } = normalizeResetAt(limit, opts);
  return epochMs === null ? null : (epochMs - (opts.now ?? Date.now())) / HOUR_MS;
}
