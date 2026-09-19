/**
 * Classify a provider quota window by its PERIOD — how long the allowance it
 * meters lasts before it refills.
 *
 * Every subscription CLI reports at least two windows on the same card: a short
 * rolling one (claude/codex `session` ≈ 5h, antigravity `5-hour`) and a long one
 * (`week`, `month`). They answer different questions, and quota-burn needs both:
 *
 *   - The LONG window is the allowance that expires unused — it is what "burn
 *     the quota before it resets" is about, and its reset is the deadline the
 *     user cares about.
 *   - The SHORT window is what actually refuses a request. Exhausting it stops
 *     work for a few hours even though the weekly allowance is untouched.
 *
 * Selecting "the soonest-resetting window" conflated the two: the 5-hour window
 * is almost always the soonest, so the Quota Burn page reported a reset a few
 * hours out when the weekly reset the plan was written against was days away,
 * and `resetWithinHours` gated on a horizon that re-opened every 5 hours.
 *
 * Pure module — no I/O, no provider knowledge beyond the vocabulary the adapters
 * in `providerUsage.js` already emit (`scope`, `label`, and the optional
 * `periodHours` a provider that states its window length exactly can supply).
 */

/**
 * Window periods, in hours, for the scope/label words the adapters emit.
 * Deliberately only the vocabulary that ships: anything else falls to the
 * documented `null` → soonest-reset fallback rather than being guessed at.
 */
const PERIOD_WORDS = Object.freeze([
  [/\bsession\b/i, 5],
  [/\b(?:day|daily)\b/i, 24],
  [/\b(?:week|weekly)\b/i, 7 * 24],
  [/\b(?:month|monthly)\b/i, 30 * 24],
]);

/**
 * `5-hour`, `5h window`, `2 days`, `45m window` → hours. Mirrors the shapes
 * `humanizeWindowMinutes` in `providerUsage.js` renders.
 */
const PERIOD_UNITS = Object.freeze([
  [/(\d+(?:\.\d+)?)\s*-?\s*(?:h|hr|hrs|hour|hours)\b/i, 1],
  [/(\d+(?:\.\d+)?)\s*-?\s*(?:d|day|days)\b/i, 24],
  [/(\d+(?:\.\d+)?)\s*-?\s*(?:m|min|mins|minute|minutes)\b/i, 1 / 60],
]);

function periodFromText(text) {
  if (typeof text !== 'string' || !text) return null;
  // Units before words: `5-hour` must read as 5, and a `Weekly` label with no
  // digits falls through to the word map.
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
 * How long this window's allowance lasts, in hours — or null when the limit
 * says nothing we can read.
 *
 * Null is a real answer, not zero: a window whose period we cannot classify must
 * not be ranked as the narrowest (which would make it the thing a denial backs
 * off to) NOR as the broadest (which would make it the burn deadline). Unknowns
 * are ranked last, and a set where every window is unknown falls back to
 * reset-time ordering.
 *
 * `periodHours` on the limit wins — codex's telemetry states `window_minutes`
 * exactly, and a plan with a 7-hour primary window must not be read as 5 just
 * because the adapter calls it a session.
 */
export function windowPeriodHours(limit) {
  const stated = Number(limit?.periodHours);
  if (Number.isFinite(stated) && stated > 0) return stated;
  return periodFromText(limit?.scope) ?? periodFromText(limit?.label);
}

/** How a window is named wherever one is reported to a human or an agent. */
export const windowLabelOf = (limit) => limit?.label || limit?.scope || 'window';

// Tolerable age is a FRACTION of the window's own period, not a flat constant:
// a weekly meter read 70 minutes ago is fine, a 5-hour session meter read 55
// minutes ago is ~18% out of date. 10% keeps a weekly meter quiet for most of a
// day while catching a session meter inside one cache generation. Floored so a
// fast-moving window (a 30-minute period, if one ever ships) is not
// permanently captioned.
const STALE_FRACTION = 0.1;
const STALE_FLOOR_MS = 5 * 60 * 1000;

/**
 * How old a reading of a window with this period may be before it counts as
 * stale, in milliseconds — or null when the period isn't known (an unreadable
 * period cannot be asserted stale or fresh).
 */
export function staleThresholdMs(periodHours) {
  if (!Number.isFinite(periodHours) || periodHours <= 0) return null;
  return Math.max(STALE_FLOOR_MS, periodHours * 60 * 60 * 1000 * STALE_FRACTION);
}

/**
 * Is this limit's reading stale, given how old it is? Takes `ageMs` rather
 * than a timestamp + `now` so this module stays free of date parsing (see the
 * module doc) — callers already hold a parsed age from `lib/lwwTimestamp.js`.
 * An unknown period or an unparseable age can't be judged, so both read as
 * "not stale" rather than guessed at.
 */
export function isLimitStale(limit, ageMs) {
  const threshold = staleThresholdMs(windowPeriodHours(limit));
  if (threshold === null || !Number.isFinite(ageMs)) return false;
  return ageMs > threshold;
}

/**
 * Split one card's windows into the two roles a burn reasons about, in a single
 * scoring pass:
 *
 *   `target`  — `{ limit, hours }` for the BROADEST window that states a
 *               readable reset: the allowance that expires unused. Its reset is
 *               the deadline, and its epoch is what the dispatch cap keys on.
 *               Ties break on the soonest reset. Null when no window on the
 *               card states a reset at all.
 *   `limiting` — the NARROWEST window: what refuses first. Exhausting a 5-hour
 *               window stops every dispatch for hours while the weekly allowance
 *               the plan targets is still mostly unspent, so it is the horizon a
 *               denial backs off to. Null when nothing states a period — an
 *               unknown period cannot be asserted to be the narrowest, and
 *               picking one would set a backoff to the wrong clock.
 *
 * `hoursUntil` maps a limit to hours-until-reset (null when unreadable), so this
 * module stays free of date parsing. Computed once per limit rather than by each
 * role, since parsing a reset is the expensive half.
 */
export function classifyWindows(limits, hoursUntil) {
  const scored = (limits || []).map((limit) => ({
    limit,
    period: windowPeriodHours(limit),
    hours: hoursUntil(limit),
  }));

  const datable = scored.filter((entry) => entry.hours !== null);
  const known = datable.filter((entry) => entry.period !== null);
  // A set where nothing states a classifiable period keeps the pre-#3390
  // behavior — soonest reset first — which is still the best available answer
  // for a provider whose vocabulary this module doesn't know.
  const pool = known.length ? known : datable;
  const target = pool.length
    ? pool.reduce((best, entry) => {
      const broader = (entry.period ?? 0) - (best.period ?? 0);
      if (broader !== 0) return broader > 0 ? entry : best;
      return entry.hours < best.hours ? entry : best;
    })
    : null;

  // Not restricted to windows with a readable reset: a limiting window with no
  // stated reset still can't be the target, and excluding it here would promote
  // a broader one into the "what refuses first" role.
  const periodic = scored.filter((entry) => entry.period !== null);
  const limiting = periodic.length
    ? periodic.reduce((narrowest, entry) => (entry.period < narrowest.period ? entry : narrowest)).limit
    : null;

  return { target: target && { limit: target.limit, hours: target.hours }, limiting };
}
