/**
 * Creative Commission — pure, ability-agnostic directive + cron helpers (#2657).
 *
 * These are side-effect-free helpers: `commissionToCron` turns a schedule
 * descriptor into a 5-field cron string; `renderFeedbackDigest` renders the taste
 * feedback into a steering digest; and `composeDirectiveGoal` folds a list of
 * brief lines + that digest into a CD directive `goal` under MAX_DIRECTIVE_GOAL_LEN.
 * The per-output-type directive assembly (which lines/deliverables each type
 * gets) lives in abilityAdapters.js (#2769), which imports these — this module
 * never imports back. Its only imports are the CAP CONSTANTS the goal budget is
 * derived from (see below); it pulls in no scheduler/store graph, so it stays
 * trivially unit-testable and importable anywhere. The authoritative
 * cron-VALIDITY check (isValidCron) lives in the scheduler/service.
 */

import {
  COMMISSION_INTENT_MAX, COMMISSION_STYLE_SPEC_MAX, COMMISSION_BRIEF_TAG_MAX,
} from '../../lib/creativeBriefLimits.js';

// The CD directive `goal` this composes is fed straight into `createProject` by
// the scheduler, which does NOT re-validate it against the route's
// `creativeDirectorDirectiveSchema` (whose cap only guards HTTP input).
// A commission with the max `feedbackWindow` (50) and long notes could otherwise
// balloon the goal past what the planner should ever see. Clamp defensively: cap
// each note's contribution to the digest, and hard-cap the final goal with
// headroom under the CD schema limit.
export const MAX_DIGEST_NOTE_LEN = 300;
// The digest is the whole point of the feedback loop, so it gets a reserved
// slice of the goal budget the brief text can't eat into (see
// buildCommissionDirective). Bounded on its own too, so 50 reactions can't blow
// the reservation.
export const MAX_DIGEST_LEN = 1500;
// Everything an adapter prepends that the user did not write: the lead sentence
// plus the longest system prefix (a model's prompt guidance, or a fully-populated
// music taste recipe). Not derived — those strings are prose, not capped fields —
// so directive.test.js measures the real ones against this allowance.
export const MAX_SYSTEM_PREFIX_LEN = 3000;
// DERIVED, not tuned: the sum of every bounded part one goal can hold. The clamp
// drops the TAIL and the adapters put system text FIRST, so a budget short of
// this sum eats the user's own words rather than erroring — which is why raising
// a brief cap has to move this number, and does so automatically here.
export const MAX_DIRECTIVE_GOAL_LEN = COMMISSION_INTENT_MAX
  + COMMISSION_STYLE_SPEC_MAX
  + (COMMISSION_BRIEF_TAG_MAX * 2) // genre + category
  + MAX_DIGEST_LEN
  + MAX_SYSTEM_PREFIX_LEN;

const clamp = (s, max) => (s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s);
const clampNote = (note) => clamp(note, MAX_DIGEST_NOTE_LEN);

const MONTHLY_DAY_RANGES = Object.freeze({
  first: '1-7',
  second: '8-14',
  third: '15-21',
  fourth: '22-28',
});

/** Return the rich calendar rule carried by a commission, when present. */
export function commissionToRecurrence(schedule) {
  if (!schedule || typeof schedule !== 'object') return null;
  if (schedule.kind === 'RECURRENCE') return schedule.recurrence || null;
  return null;
}

function recurrenceToCron(rule) {
  if (!rule || typeof rule !== 'object') return null;
  if (rule.frequency === 'custom') return typeof rule.cron === 'string' && rule.cron.trim() ? rule.cron.trim() : null;
  const match = typeof rule.time === 'string' ? rule.time.match(/^([01]\d|2[0-3]):([0-5]\d)$/) : null;
  if (!match) return null;
  const prefix = `${Number(match[2])} ${Number(match[1])}`;
  const interval = Math.max(1, Number(rule.interval) || 1);
  if (rule.frequency === 'daily') {
    const weekdays = Array.isArray(rule.weekdays)
      ? [...new Set(rule.weekdays)].filter(day => Number.isInteger(day) && day >= 0 && day <= 6).sort((a, b) => a - b)
      : [];
    if (weekdays.length && interval > 1) return null;
    return `${prefix} ${interval > 1 ? `*/${interval}` : '*'} * ${weekdays.length ? weekdays.join(',') : '*'}`;
  }
  if (rule.frequency === 'weekly') {
    const weekdays = Array.isArray(rule.weekdays) ? [...new Set(rule.weekdays)].sort((a, b) => a - b) : [];
    return `${prefix} * * ${weekdays.length ? weekdays.join(',') : '*'}`;
  }
  if (rule.frequency === 'monthly-date') {
    const day = Number(rule.dayOfMonth);
    return Number.isInteger(day) && day >= 1 && day <= 31 ? `${prefix} ${day} * *` : null;
  }
  if (rule.frequency === 'monthly-weekday') {
    const range = MONTHLY_DAY_RANGES[rule.ordinal];
    const weekday = Number(rule.weekday);
    return range && Number.isInteger(weekday) && weekday >= 0 && weekday <= 6
      ? `${prefix} ${range} * ${weekday}`
      : null;
  }
  return null;
}

/**
 * Compose a 5-field cron (`minute hour dayOfMonth month dayOfWeek`) from a
 * commission schedule. Returns the raw string, or null when the schedule is
 * missing the fields its kind requires (the caller then rejects it). Does NOT
 * assert cron validity — that's isValidCron's job at the service boundary.
 */
export function commissionToCron(schedule) {
  if (!schedule || typeof schedule !== 'object') return null;
  const { kind, atLocalTime, weekday, weekdaysOnly, cron } = schedule;

  if (kind === 'RECURRENCE') return recurrenceToCron(schedule.recurrence);

  if (kind === 'CUSTOM') {
    return typeof cron === 'string' && cron.trim() ? cron.trim() : null;
  }

  // DAILY / WEEKLY compose from HH:MM.
  const m = typeof atLocalTime === 'string' ? atLocalTime.match(/^([01]\d|2[0-3]):([0-5]\d)$/) : null;
  if (!m) return null;
  const hour = String(Number(m[1]));
  const minute = String(Number(m[2]));

  if (kind === 'DAILY') {
    return `${minute} ${hour} * * ${weekdaysOnly ? '1-5' : '*'}`;
  }
  if (kind === 'WEEKLY') {
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return null;
    return `${minute} ${hour} * * ${weekday}`;
  }
  return null;
}

/**
 * Render the last N feedback reactions into a compact steering digest the
 * planner can act on. Phase 2 populates `commission.feedback`; Phase 1 always
 * yields an empty digest (no feedback exists yet), but the fold is implemented
 * now so Phase 2 only needs the rate/annotate surface — not a directive change.
 *
 * Distinguishes "no feedback" (returns '') from "feedback with empty notes"
 * (still surfaces the up/down tallies) per the absent-vs-empty rule.
 */
export function renderFeedbackDigest(feedback, windowSize = 5) {
  if (!Array.isArray(feedback) || feedback.length === 0 || windowSize <= 0) return '';
  const recent = feedback.slice(-windowSize);
  const likes = [];
  const dislikes = [];
  for (const f of recent) {
    if (!f || typeof f !== 'object') continue;
    const note = typeof f.note === 'string' ? f.note.trim() : '';
    const up = f.rating === 'up' || (typeof f.rating === 'number' && f.rating > 0);
    const down = f.rating === 'down' || (typeof f.rating === 'number' && f.rating < 0);
    if (up && note) likes.push(clampNote(note));
    else if (down && note) dislikes.push(clampNote(note));
    else if (up) likes.push('(liked, no note)');
    else if (down) dislikes.push('(disliked, no note)');
  }
  if (likes.length === 0 && dislikes.length === 0) return '';
  // Budget the likes and dislikes SEPARATELY so a run of long likes (emitted
  // first) can't eat the whole digest and truncate away the newer dislikes + the
  // steering instruction. Each group gets an equal share of the digest budget
  // (minus the fixed steering sentence); the final clamp is then a no-op safety net.
  // Render each group NEWEST-first before clamping: `likes`/`dislikes` are
  // collected oldest→newest, and `clamp` keeps the prefix, so clamping the
  // chronological join would drop the user's LATEST reaction in a long group.
  // Reversing puts the newest notes first, so the truncation sheds the oldest.
  const STEER = 'Steer toward the likes and away from the dislikes.';
  // Split the budget only across the groups that are actually present — a
  // one-sided window (only likes or only dislikes) gets the WHOLE budget rather
  // than reserving half for an absent group and truncating real feedback.
  const groupsPresent = (likes.length ? 1 : 0) + (dislikes.length ? 1 : 0);
  const groupBudget = Math.max(0, Math.floor((MAX_DIGEST_LEN - STEER.length - 40) / groupsPresent));
  const parts = [];
  if (likes.length) parts.push(`Recent likes: ${clamp([...likes].reverse().join('; '), groupBudget)}.`);
  if (dislikes.length) parts.push(`Recent dislikes: ${clamp([...dislikes].reverse().join('; '), groupBudget)}.`);
  parts.push(STEER);
  return clamp(parts.join(' '), MAX_DIGEST_LEN);
}

/**
 * Compose a CD directive `goal` string from a list of brief lines and a feedback
 * digest, under MAX_DIRECTIVE_GOAL_LEN. Ability-agnostic (#2769): each ability
 * adapter builds its own type-specific `lines` (see abilityAdapters.js) and hands
 * them here so the char-budget / digest-reservation logic lives in exactly one
 * place.
 *
 * The scheduler feeds the result straight into `createProject({ directive })`,
 * skipping the route's input validation, so the clamp is load-bearing. RESERVE
 * room for the digest first, then clamp the BRIEF text into whatever remains —
 * truncating the tail of the whole string would drop the digest (appended last)
 * whenever a long intent/style fills the budget, silently killing the feedback
 * signal. The digest is bounded (MAX_DIGEST_LEN) so the reservation is finite.
 */
export function composeDirectiveGoal(lines, digest) {
  const briefText = (Array.isArray(lines) ? lines : []).filter(Boolean).join(' ');
  const reserve = digest ? digest.length + 1 : 0; // +1 for the joining space
  const briefBudget = Math.max(0, MAX_DIRECTIVE_GOAL_LEN - reserve);
  const clampedBrief = clamp(briefText, briefBudget);
  let goal = digest ? `${clampedBrief} ${digest}`.trim() : clampedBrief;
  // Final safety net (defensive — brief+reserve already fits): clamp the whole.
  return clamp(goal, MAX_DIRECTIVE_GOAL_LEN);
}
