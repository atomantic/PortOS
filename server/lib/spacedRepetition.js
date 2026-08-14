/**
 * Spaced repetition (SM-2 inspired) — the shared scheduling core.
 *
 * Every record that wants to resurface on a review cadence carries the same
 * four-field schedule:
 *
 *   { ease, intervalDays, nextReview, lastReviewed }
 *
 * A record is "due" when `nextReview <= now`. Reviewing it advances the
 * schedule: a correct-heavy pass pushes the next review further out, a miss
 * resets the interval to 0 so the record resurfaces immediately.
 *
 * The shape is deliberately additive and migration-safe — a record predating
 * spaced repetition simply has no schedule, and `scheduleOrDefault` derives one
 * anchored to the record's own `updatedAt`/`createdAt` (stable, in the past →
 * due now) so "due" state can't flap between reads.
 *
 * There is NO `repetitions` counter: the 0 → 1 → 6 → round(prev * ease) ladder
 * is derived from the previous interval, so a schedule round-tripping through
 * import/export/federation needs only these four fields.
 *
 * Extracted from `services/meatspacePostMemory.js` (which re-exports these for
 * its existing callers) when SongBook repertoire practice became the second
 * consumer — see #4102.
 */

/** Starting ease for a never-reviewed record — the classic SM-2 default. */
export const DEFAULT_EASE = 2.5;
/** SM-2's ease floor: below this the interval ladder stops growing usefully. */
export const MIN_EASE = 1.3;
/**
 * Ease ceiling. The per-review +0.1 bumps are unbounded otherwise, so ~26
 * perfect reps would push ease past 5, and any Zod schema mirroring this shape
 * (`memoryScheduleSchema.ease.max(5)` in postValidation.js) would then 400 on
 * the server's own value during an import / out-of-band reschedule round-trip.
 * Keep any such schema in sync with this constant.
 */
export const MAX_EASE = 5;
/**
 * Cap the interval at a year so a long run of perfect reviews can't grow it
 * without bound — an astronomically large `intervalDays` would overflow
 * `new Date(now + intervalDays * DAY_MS)` into an Invalid Date and throw. A
 * yearly review floor is a conventional SRS ceiling and keeps records
 * resurfacing.
 */
export const MAX_INTERVAL_DAYS = 365;
/** Top of the SM-2 quality scale — a review grades 0..MAX_QUALITY. */
export const MAX_QUALITY = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Fresh schedule — due at `nowIso` (i.e. immediately). */
export function defaultSchedule(nowIso = new Date().toISOString()) {
  return { ease: DEFAULT_EASE, intervalDays: 0, nextReview: nowIso, lastReviewed: null };
}

/** True when `schedule` is a usable schedule object rather than absent/garbage. */
export function isValidSchedule(schedule) {
  return Boolean(schedule) && typeof schedule === 'object' && typeof schedule.nextReview === 'string';
}

/**
 * The schedule to READ for a record, without persisting anything. Absent or
 * malformed schedules derive a default anchored to the record's own
 * `updatedAt`/`createdAt` — stable and in the past, so the record reads as due
 * now instead of the "due" answer flapping with the clock on every call.
 *
 * `null`/absent is deliberately NOT collapsed into "due at this instant": the
 * anchor is what makes two reads a millisecond apart agree.
 */
export function scheduleOrDefault(record, schedule = record?.schedule) {
  if (isValidSchedule(schedule)) return schedule;
  return defaultSchedule(record?.updatedAt || record?.createdAt || new Date().toISOString());
}

/**
 * SM-2 quality (0..5) for a correctness ratio (0..1). Non-finite input scores
 * 0 — an unmeasurable pass must never read as a perfect one.
 *
 * Note the pass threshold this implies: quality >= 3 needs ratio >= 0.5
 * (0.5 * 5 = 2.5 → rounds to 3).
 */
export function ratioToQuality(ratio) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  return Math.round(clamped * MAX_QUALITY);
}

/**
 * The correctness ratio a caller passes to `advanceSchedule` for a review the
 * user graded directly on the 0..MAX_QUALITY scale (rather than one measured as
 * correct/total). Exact inverse of `ratioToQuality` over the integers, so a
 * self-graded review lands on the quality the user actually picked.
 */
export function qualityToRatio(quality) {
  const clamped = Math.max(0, Math.min(MAX_QUALITY, Number.isFinite(quality) ? quality : 0));
  return clamped / MAX_QUALITY;
}

/**
 * Did the previous review land on the same UTC day as `now`? The signal behind
 * once-per-day gating (interval growth in `mergeScheduleAdvance`, and any
 * caller-side progression that should count a day of work once).
 *
 * An absent/unparseable `lastReviewed` is NOT the same day — a record with no
 * review history must never read as "already reviewed today".
 */
export function isSameReviewDay(lastReviewed, now = new Date()) {
  const lastReviewedMs = Date.parse(lastReviewed ?? '');
  if (!Number.isFinite(lastReviewedMs)) return false;
  return new Date(lastReviewedMs).toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
}

/**
 * Advance a schedule from a review's correctness ratio (0..1).
 * Pure — returns a new schedule object, never mutates the input.
 *   - ratio maps to an SM-2 quality (0..5); ease adjusts per the SM-2 formula.
 *   - quality < 3 (a miss-heavy pass) → intervalDays 0 → due now again, but the
 *     ease penalty still applies.
 *   - otherwise the interval steps 0 → 1 → 6 → round(interval * ease).
 */
export function advanceSchedule(schedule, ratio, now = new Date()) {
  const prev = schedule && typeof schedule === 'object' ? schedule : {};
  const quality = ratioToQuality(ratio);
  const nowIso = now.toISOString();

  const prevEase = typeof prev.ease === 'number' ? prev.ease : DEFAULT_EASE;
  let ease = prevEase + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  ease = Math.min(MAX_EASE, Math.max(MIN_EASE, Math.round(ease * 100) / 100));

  let intervalDays;
  if (quality < 3) {
    intervalDays = 0; // relearn — resurface immediately
  } else {
    const prevInterval = typeof prev.intervalDays === 'number' ? prev.intervalDays : 0;
    if (prevInterval <= 0) intervalDays = 1;
    else if (prevInterval < 6) intervalDays = 6;
    else intervalDays = Math.max(1, Math.round(prevInterval * ease));
    intervalDays = Math.min(MAX_INTERVAL_DAYS, intervalDays);
  }

  const nextReview = new Date(now.getTime() + intervalDays * DAY_MS).toISOString();
  return { ease, intervalDays, nextReview, lastReviewed: nowIso };
}

/**
 * Merge a freshly-advanced schedule against the record's prior schedule, gating
 * interval GROWTH to once per review day.
 *
 * Why: a "review" is one pass through the record, but a UI that submits per
 * chunk/section fires several advances in one sitting. Advancing on every
 * submission would compound the interval (0→1→6→16d) and drop the record off
 * the due list far longer than one completed review warrants. So a same-day
 * continuation only refreshes ease and `lastReviewed` — it keeps the
 * interval/nextReview already set earlier today. A miss (interval shrinks to 0)
 * always applies, so a fumbled pass still resurfaces the record immediately
 * regardless of earlier same-day success.
 */
export function mergeScheduleAdvance(prev, advanced, now = new Date()) {
  const prevInterval = typeof prev?.intervalDays === 'number' ? prev.intervalDays : 0;
  // Suppress compounding only when this is a same-day continuation AND the
  // interval would grow. Any shrink (a miss reset) always applies.
  if (isSameReviewDay(prev?.lastReviewed, now) && advanced.intervalDays > prevInterval) {
    return { ...prev, ease: advanced.ease, lastReviewed: advanced.lastReviewed };
  }
  return advanced;
}

/**
 * Is this schedule due at `now`? An absent or unparseable `nextReview` reads as
 * due — a record we can't schedule is one we should surface, never one we
 * silently hide forever.
 */
export function isScheduleDue(schedule, now = new Date()) {
  const nextReview = schedule?.nextReview;
  if (typeof nextReview !== 'string') return true;
  const at = Date.parse(nextReview);
  return Number.isNaN(at) || at <= now.getTime();
}
