/**
 * Classify a provider quota window by its PERIOD (`windowPeriodHours`).
 *
 * `classifyWindows` splits one card's windows into the weekly allowance that expires unused and the 5-hour one that refuses first, in one pass. `windowLabelOf` names a window; `staleThresholdMs` / `isLimitStale` judge a reading's age against 10% of ITS OWN window period (floored at 5min). Pure: no I/O, no provider knowledge beyond the vocabulary the adapters in `providerUsage.js` emit (`scope`, `label`, optional `periodHours` for a provider stating its window length exactly).
 *
 * Every subscription CLI reports at least a short rolling window (claude/codex `session` ≈ 5h, antigravity `5-hour`) and a long one (`week`, `month`), which answer different questions: the LONG window is the allowance that expires
 * unused (what "burn before it resets" is about; its reset is the deadline), the SHORT one is what actually refuses a request. Selecting "the soonest-resetting window" conflated them: the 5-hour one is almost always soonest,
 * so the Quota Burn page reported a reset hours out when the weekly reset was days away and `resetWithinHours` gated on a horizon re-opening every 5 hours.
 */

/** Window periods, in hours, for the scope/label words the adapters emit; only shipped vocabulary, anything else falls to the `null` → soonest-reset fallback rather than being guessed. */
const PERIOD_WORDS = Object.freeze([
  [/\bsession\b/i, 5],
  [/\b(?:day|daily)\b/i, 24],
  [/\b(?:week|weekly)\b/i, 7 * 24],
  [/\b(?:month|monthly)\b/i, 30 * 24],
]);

/** `5-hour`, `5h window`, `2 days`, `45m window` → hours; mirrors `humanizeWindowMinutes` in `providerUsage.js`. */
const PERIOD_UNITS = Object.freeze([
  [/(\d+(?:\.\d+)?)\s*-?\s*(?:h|hr|hrs|hour|hours)\b/i, 1],
  [/(\d+(?:\.\d+)?)\s*-?\s*(?:d|day|days)\b/i, 24],
  [/(\d+(?:\.\d+)?)\s*-?\s*(?:m|min|mins|minute|minutes)\b/i, 1 / 60],
]);

function periodFromText(text) {
  if (typeof text !== 'string' || !text) return null;
  // Units before words: `5-hour` must read as 5, and a digitless `Weekly` falls through to the word map.
  for (const [pattern, factor] of PERIOD_UNITS) {
    const match = text.match(pattern);
    if (match) {
      const hours = Number(match[1]) * factor;
      if (Number.isFinite(hours) && hours > 0) return hours;
    }
  }
  for (const [pattern, hours] of PERIOD_WORDS) {
    if (pattern.test(text)) return hours;
  }
  return null;
}

/**
 * How long this window's allowance lasts, in hours, or null when unreadable. Null is a real answer, not zero: an unclassifiable window must be ranked neither narrowest (a denial would back off to it) nor broadest (it would become the burn deadline);
 * unknowns rank last, and a set of all-unknowns falls back to reset-time ordering. `periodHours` on the limit wins (codex states `window_minutes` exactly; a 7-hour primary window must not read as 5 because the adapter calls it a session).
 */
export function windowPeriodHours(limit) {
  const stated = Number(limit?.periodHours);
  if (Number.isFinite(stated) && stated > 0) return stated;
  return periodFromText(limit?.scope) ?? periodFromText(limit?.label);
}

/** How a window is named wherever one is reported to a human or an agent. */
export const windowLabelOf = (limit) => limit?.label || limit?.scope || 'window';

// Tolerable age is a FRACTION of the window's own period: a weekly meter read 70 minutes ago is fine, a 5-hour meter read 55 minutes ago is ~18% out of date. 10% keeps a weekly meter quiet for most of a day; floored so a fast window (30-minute) isn't permanently captioned.
const STALE_FRACTION = 0.1;
const STALE_FLOOR_MS = 5 * 60 * 1000;

/** How old a reading of a window with this period may be before it counts as stale, in ms; null when the period is unknown (can't be asserted stale or fresh). */
export function staleThresholdMs(periodHours) {
  if (!Number.isFinite(periodHours) || periodHours <= 0) return null;
  return Math.max(STALE_FLOOR_MS, periodHours * 60 * 60 * 1000 * STALE_FRACTION);
}

/** Is this limit's reading stale given `ageMs`? Takes an age (not timestamp + `now`) to keep this module free of date parsing; an unknown period or unparseable age reads "not stale". */
export function isLimitStale(limit, ageMs) {
  const threshold = staleThresholdMs(windowPeriodHours(limit));
  if (threshold === null || !Number.isFinite(ageMs)) return false;
  return ageMs > threshold;
}

/**
 * Split one card's windows into the two roles a burn reasons about, in a single scoring pass:
 *   `target`: `{ limit, hours }` for the BROADEST window stating a readable reset (the allowance that expires unused; its reset is the deadline and its epoch keys the dispatch cap); ties break on soonest reset; null when no window states a reset.
 *   `limiting`: the NARROWEST window, what refuses first (a 5-hour window stops every dispatch while the weekly allowance is mostly unspent, so a denial backs off to it); null when nothing states a period (an unknown period can't be asserted narrowest).
 * `hoursUntil` maps a limit to hours-until-reset (null when unreadable), keeping this module free of date parsing; computed once per limit since parsing a reset is the expensive half.
 */
export function classifyWindows(limits, hoursUntil) {
  const scored = (limits || []).map((limit) => ({
    limit,
    period: windowPeriodHours(limit),
    hours: hoursUntil(limit),
  }));

  const datable = scored.filter((entry) => entry.hours !== null);
  const known = datable.filter((entry) => entry.period !== null);
  // A set with no classifiable period keeps the pre-#3390 behavior (soonest reset first), the best answer for an unknown vocabulary.
  const pool = known.length ? known : datable;
  const target = pool.length
    ? pool.reduce((best, entry) => {
      const broader = (entry.period ?? 0) - (best.period ?? 0);
      if (broader !== 0) return broader > 0 ? entry : best;
      return entry.hours < best.hours ? entry : best;
    })
    : null;

  // Not restricted to windows with a readable reset: a limiting window with no stated reset still can't be the target, and excluding it would promote a broader one into "what refuses first".
  const periodic = scored.filter((entry) => entry.period !== null);
  const limiting = periodic.length
    ? periodic.reduce((narrowest, entry) => (entry.period < narrowest.period ? entry : narrowest)).limit
    : null;

  return { target: target && { limit: target.limit, hours: target.hours }, limiting };
}
