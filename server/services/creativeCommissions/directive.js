/**
 * Creative Commission — pure, ability-agnostic directive + cron helpers (#2657).
 *
 * These are side-effect-free helpers: `commissionToCron` turns a schedule
 * descriptor into a 5-field cron string; `renderFeedbackDigest` renders the taste
 * feedback into a steering digest; and `composeDirectiveGoal` folds a list of
 * brief lines + that digest into a CD directive `goal` under the 5000-char cap.
 * The per-output-type directive assembly (which lines/deliverables each type
 * gets) lives in abilityAdapters.js (#2769), which imports these — this module
 * stays a dependency-free leaf and never imports back. Kept pure so they're
 * trivially unit-testable and importable anywhere without dragging the scheduler
 * graph along. The authoritative cron-VALIDITY check (isValidCron) lives in the
 * scheduler/service.
 */

// The CD directive `goal` this composes is fed straight into `createProject` by
// the scheduler, which does NOT re-validate it against the route's
// `creativeDirectorDirectiveSchema` (that 5000-char cap only guards HTTP input).
// A commission with the max `feedbackWindow` (50) and long notes could otherwise
// balloon the goal past what the planner should ever see. Clamp defensively: cap
// each note's contribution to the digest, and hard-cap the final goal with
// headroom under the CD schema limit.
export const MAX_DIGEST_NOTE_LEN = 300;
export const MAX_DIRECTIVE_GOAL_LEN = 4500;
// The digest is the whole point of the feedback loop, so it gets a reserved
// slice of the goal budget the brief text can't eat into (see
// buildCommissionDirective). Bounded on its own too, so 50 reactions can't blow
// the reservation.
export const MAX_DIGEST_LEN = 1500;

const clamp = (s, max) => (s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s);
const clampNote = (note) => clamp(note, MAX_DIGEST_NOTE_LEN);

/**
 * Compose a 5-field cron (`minute hour dayOfMonth month dayOfWeek`) from a
 * commission schedule. Returns the raw string, or null when the schedule is
 * missing the fields its kind requires (the caller then rejects it). Does NOT
 * assert cron validity — that's isValidCron's job at the service boundary.
 */
export function commissionToCron(schedule) {
  if (!schedule || typeof schedule !== 'object') return null;
  const { kind, atLocalTime, weekday, weekdaysOnly, cron } = schedule;

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
 * digest, under the CD's 5000-char cap. Ability-agnostic (#2769): each ability
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
