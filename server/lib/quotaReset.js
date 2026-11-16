/**
 * Normalize the reset times emitted by the provider quota adapters. A missing or ambiguous reset is deliberately null: a scheduled quota burn must park rather than guess a provider is about to reset.
 *
 * `parseHumanReset` is the adapter-facing half (each adapter calls it so `resetsAt` is ISO 8601 on the wire); `normalizeResetAt`/`hoursUntilReset` do arithmetic on that instant without treating
 * unknown values as imminent resets; `parseObservedReset` pulls the reset a provider stated in its own refusal text, and `isObservedBlockActive` is the shared "is that refusal still holding?" predicate.
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
  // A zero-offset zone (UTC, London in winter, Iceland) renders as a bare "GMT" (CLDR omits "+00:00"); match it separately or such users' resets resolve to null. Some ICU builds spell it "UTC".
  if (/^(?:GMT|UTC)$/.test(offset || '')) return 0;
  const match = /^(?:GMT|UTC)([+-])(\d{2}):(\d{2})$/.exec(offset || '');
  if (!match) return null;
  return (Number(match[2]) * 60 + Number(match[3])) * 60 * 1000 * (match[1] === '+' ? 1 : -1);
}

/**
 * Reshape a human-rendered CLI reset into something `Date.parse` accepts. Shapes that defeat a bare parse: claude `Aug 4 at 1:59pm` / `Jul 7 at 2pm` (" at " separator and meridiem glued to the
 * minutes or hour, so every claude window read as stateless and the family could never burn), and grok `August 10, 06:07` (parses, but see `stampYear`). Pure.
 */
function normalizeSeparators(value) {
  return value
    .replace(/\s+at\s+/gi, ' ')
    // `1:59pm` → `1:59 pm`, `2pm` → `2:00 pm` (a bare hour with a meridiem isn't a time `Date.parse` accepts).
    .replace(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi, (_, hour, minute, meridiem) => `${hour}:${minute || '00'} ${meridiem}`);
}

/** The calendar year `now` falls in, as `timeZone` renders it (local when absent). */
function zoneYear(now, timeZone) {
  const at = new Date(now);
  if (!timeZone) return at.getFullYear();
  return Number(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).format(at));
}

/**
 * Replace the year of a wall-clock instant. A year-less string does NOT default to the current year (`Date.parse('Aug 4 1:59 pm')` resolves to **2001**, so a grok window read "already reset" forever).
 * Stamping the year up front also fixes the offset lookup: DST rules are per-year, so a 2026 reset resolved through a 2001 instant's offset can be off by an hour.
 */
function stampYear(wallMs, year) {
  const date = new Date(wallMs);
  date.setUTCFullYear(year);
  return date.getTime();
}

/** Resolve a human wall-clock reset string to an epoch instant in `timezone` (the server's own when none is stated); null when no parseable date/time. */
function resolveWallClock(raw, { now, timezone }) {
  const value = normalizeSeparators(raw);
  // Read the fields as if UTC so the year can be corrected before any zone offset applies.
  const wall = Date.parse(`${value} UTC`);
  if (!Number.isFinite(wall)) return null;

  // The instant that wall clock names in the provider's zone (or the server's own when none is stated).
  const resolve = (wallMs) => {
    const offset = timezone ? zoneOffsetMs(wallMs, timezone) : -new Date(wallMs).getTimezoneOffset() * 60_000;
    return offset === null ? null : wallMs - offset;
  };

  // `null` year = the string states its own and needs no stamping.
  const year = /\b\d{4}\b/.test(value) ? null : zoneYear(now, timezone);
  const epochMs = resolve(year === null ? wall : stampYear(wall, year));
  // A year-less reset stamped with the current year can land in the past across a year boundary ("Jan 2" read on Dec 31): roll to the next occurrence, re-resolving the per-year offset.
  // The hour of grace keeps a reset that just passed from being pushed a year out.
  if (year !== null && epochMs !== null && epochMs < now - HOUR_MS) return resolve(stampYear(wall, year + 1));
  return epochMs;
}

/**
 * Turn one provider CLI's human reset string into an ISO 8601 instant, the shape every quota adapter puts on the wire so the client can localize it and `normalizeResetAt` stays pure arithmetic.
 * Call it from the ADAPTER (`parseLimitLine`, `parseGrokUsage`, …), not a shared choke point: a new dialect belongs in its own adapter. Already-ISO input passes through (UTC-normalized), so it is idempotent.
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
 * Every in-tree adapter emits ISO (the `hasExplicitZone` fast path); the wall-clock fallback stays for an older federated peer or an unmigrated adapter, which would otherwise read as "no window states a reset time".
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

/**
 * Has this window already rolled over as of `now`? Once the stated reset has passed, the percentage describes a SPENT window; one whose reset can't be resolved counts as live.
 * One definition for three surfaces: the retained Codex card (`unexpiredLimits` in services/providerUsage.js), the federated merge (`lib/fleetQuotas.js`), and the Codex log parser (`codexWindowExpired`).
 * Goes through `normalizeResetAt`, not a bare `Date.parse`, so an older peer's zone-less wall-clock reset is judged.
 */
export function limitWindowExpired(limit, opts = {}) {
  const now = opts.now ?? Date.now();
  const { epochMs } = normalizeResetAt(limit, { ...opts, now });
  return epochMs !== null && epochMs <= now;
}

/**
 * Compute fractional hours remaining until quota window reset.
 *
 * @param {{ resetsAt?: string, timezone?: string }} limit - Limit object containing resetsAt string
 * @param {{ now?: number, timeZone?: string }} [opts] - Reference timestamp and optional fallback timeZone
 * @returns {number|null} Fractional hours until reset (negative if already in the past), or null if indeterminate
 */
export function hoursUntilReset(limit, opts = {}) {
  const { epochMs } = normalizeResetAt(limit, opts);
  return epochMs === null ? null : (epochMs - (opts.now ?? Date.now())) / HOUR_MS;
}

/** Parse an absolute ISO instant out of free-form provider text (Antigravity: `(around 2026-07-31T21:38:09Z)`). Pure. */
const parseAbsoluteObservedReset = (text, now) => {
  const match = text.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)/);
  if (!match) return null;
  const at = new Date(match[1]).getTime();
  // Narration also carries log lines and session stamps; a past timestamp is not a reset (it would set an already-elapsed block, reading as "not blocked").
  return Number.isNaN(at) || at <= now ? null : at;
};

/**
 * Parse a relative reset window (`quota will reset in approximately 5 hours`,
 * `try again in 30 minutes`) into an absolute epoch ms. Pure given `now`.
 */
const parseRelativeObservedReset = (text, now) => {
  const match = text.match(/(?:reset|retry|try again|available)\b[^.]{0,40}?\bin\s+(?:approximately\s+|about\s+|~\s*)?(\d+(?:\.\d+)?)\s*(second|minute|hour|day)s?/i);
  if (!match) return null;
  const unitMs = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000 }[match[2].toLowerCase()];
  return now + Number(match[1]) * unitMs;
};

/**
 * The reset instant a provider stated in its own refusal text, as epoch ms, or null. The OBSERVED half of quota state: a refusal is the only quota signal some backends emit (`imageGenQuota.js`)
 * and tells a burn how long to back off (`quotaBurnDenials.js`). Absolute wins over relative ("in ~5 hours (around <ISO>)": the parenthetical is more precise and survives a slow error path);
 * both reject an instant not in the future. Pure given `now`.
 */
export function parseObservedReset(text, { now = Date.now() } = {}) {
  const raw = typeof text === 'string' ? text : '';
  if (!raw.trim()) return null;
  return parseAbsoluteObservedReset(raw, now) ?? parseRelativeObservedReset(raw, now);
}

/**
 * Is a block recorded from an observed refusal still holding? `at` marks it blocked; `until` only says WHEN it lifts and may legitimately be unknown. Keying off `until` alone would collapse
 * "blocked, reset unknown" into "not blocked", so an unknown reset holds for a bounded `ttlMs` (nothing forces a later attempt to prove the provider serves again).
 * Shared by `imageGenQuota.js` and `quotaBurnDenials.js`, each with its own TTL. Pure.
 */
export function isObservedBlockActive(block, { now = Date.now(), ttlMs } = {}) {
  // `?.` rather than a default: a default only covers `undefined`, and a ledger lookup may hand `null`.
  const at = block?.at;
  if (!at) return false;
  return block.until ? block.until > now : now - at < ttlMs;
}
