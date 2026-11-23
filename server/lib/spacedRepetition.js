/**
 * Spaced repetition (SM-2 inspired): the shared scheduling core.
 *
 * A record that resurfaces on a review cadence carries `{ ease, intervalDays, nextReview, lastReviewed }` and is "due" when `nextReview <= now`; a correct-heavy review pushes the next one out, a miss resets the interval to 0. Additive and migration-safe: a record predating this has no schedule and `scheduleOrDefault` derives one anchored to its own `updatedAt`/`createdAt` (stable, in the past → due now) so "due" can't flap between reads. No `repetitions` counter: the 0 → 1 → 6 → round(prev * ease) ladder derives from the previous interval, so a schedule round-tripping import/export/federation needs only these four fields. Extracted from `services/meatspace/meatspacePostMemory.js` (which re-exports it) when SongBook practice became the second consumer (#4102).
 */

import { todayInTimezone } from './timezone.js';

/** Starting ease for a never-reviewed record — the classic SM-2 default. */
export const DEFAULT_EASE = 2.5;
/** SM-2's ease floor: below this the interval ladder stops growing usefully. */
export const MIN_EASE = 1.3;
/** Ease ceiling: the unbounded +0.1 bumps would pass 5 after ~26 perfect reps and any mirroring Zod schema (`memoryScheduleSchema.ease.max(5)` in postValidation.js) would 400 on the server's own value in an import round-trip. Keep such schemas in sync. */
export const MAX_EASE = 5;
/** Interval cap of a year (a conventional SRS ceiling): an astronomically large `intervalDays` would overflow `new Date(now + intervalDays * DAY_MS)` into an Invalid Date and throw. */
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

/** The schedule to READ for a record, without persisting. Absent/malformed schedules derive a default anchored to the record's `updatedAt`/`createdAt` (stable and in the past) so two reads a millisecond apart agree, rather than "due at this instant" flapping with the clock. */
export function scheduleOrDefault(record, schedule = record?.schedule) {
  if (isValidSchedule(schedule)) return schedule;
  return defaultSchedule(record?.updatedAt || record?.createdAt || new Date().toISOString());
}

/** SM-2 quality (0..5) for a correctness ratio (0..1). Non-finite input scores 0 (an unmeasurable pass must never read as perfect). Pass threshold: quality >= 3 needs ratio >= 0.5. */
export function ratioToQuality(ratio) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  return Math.round(clamped * MAX_QUALITY);
}

/** The correctness ratio to pass `advanceSchedule` for a review graded directly on the 0..MAX_QUALITY scale; the exact inverse of `ratioToQuality` over the integers, so a self-graded review lands on the picked quality. */
export function qualityToRatio(quality) {
  const clamped = Math.max(0, Math.min(MAX_QUALITY, Number.isFinite(quality) ? quality : 0));
  return clamped / MAX_QUALITY;
}

/** Did the previous review land on the same calendar day as `now` in `timezone` (IANA; UTC when omitted)? The signal behind once-per-day gating (`mergeScheduleAdvance` interval growth). An absent/unparseable `lastReviewed` is NOT the same day. */
export function isSameReviewDay(lastReviewed, now = new Date(), timezone = 'UTC') {
  const lastReviewedMs = Date.parse(lastReviewed ?? '');
  if (!Number.isFinite(lastReviewedMs)) return false;
  return todayInTimezone(timezone, new Date(lastReviewedMs)) === todayInTimezone(timezone, now);
}

/** Advance a schedule from a review's correctness ratio (0..1); pure, returns a new object. Ratio maps to SM-2 quality (0..5) adjusting ease; quality < 3 → intervalDays 0 (due now again, ease penalty still applies); otherwise the interval steps 0 → 1 → 6 → round(interval * ease). */
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
 * Merge a freshly-advanced schedule against the prior one, gating interval GROWTH to once per review day: a UI submitting per chunk fires several advances in one sitting, which would compound the interval (0→1→6→16d)
 * and drop the record off the due list. A same-day continuation only refreshes ease and `lastReviewed`; a miss (interval shrinks to 0) always applies. The review day is the user's local day in `timezone`.
 */
export function mergeScheduleAdvance(prev, advanced, now = new Date(), timezone = 'UTC') {
  const prevInterval = typeof prev?.intervalDays === 'number' ? prev.intervalDays : 0;
  // Suppress compounding only for a same-day continuation AND a growing interval; a shrink (miss reset) always applies.
  if (isSameReviewDay(prev?.lastReviewed, now, timezone) && advanced.intervalDays > prevInterval) {
    return { ...prev, ease: advanced.ease, lastReviewed: advanced.lastReviewed };
  }
  return advanced;
}

/** Is this schedule due at `now`? An absent/unparseable `nextReview` reads as due (a record we can't schedule should surface, never hide). */
export function isScheduleDue(schedule, now = new Date()) {
  const nextReview = schedule?.nextReview;
  if (typeof nextReview !== 'string') return true;
  const at = Date.parse(nextReview);
  return Number.isNaN(at) || at <= now.getTime();
}
