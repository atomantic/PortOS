/**
 * Creative Commission — pure directive + cron composition (#2657, Phase 1).
 *
 * These are side-effect-free helpers: `commissionToCron` turns a schedule
 * descriptor into a 5-field cron string, and `buildCommissionDirective` composes
 * the CD directive (goal + deliverables + constraints) the planner turns into a
 * plan. Kept pure and dependency-free so they're trivially unit-testable and can
 * be imported anywhere without dragging the scheduler graph along. The
 * authoritative cron-VALIDITY check (isValidCron) lives in the scheduler/service.
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

const clampNote = (note) =>
  note.length > MAX_DIGEST_NOTE_LEN ? `${note.slice(0, MAX_DIGEST_NOTE_LEN - 1)}…` : note;

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
  const parts = [];
  if (likes.length) parts.push(`Recent likes: ${likes.join('; ')}.`);
  if (dislikes.length) parts.push(`Recent dislikes: ${dislikes.join('; ')}.`);
  parts.push('Steer toward the likes and away from the dislikes.');
  return parts.join(' ');
}

/**
 * Build the CD directive for a commission's next fire. Folds the brief (intent +
 * genre/category/style) and the accumulated feedback digest into `goal`, and
 * maps the brief's constraints (universe/series) onto the directive constraints.
 * Shape matches `creativeDirectorDirectiveSchema` (goal/deliverables/constraints)
 * so it round-trips straight into `createProject({ directive })`.
 */
export function buildCommissionDirective(commission) {
  const brief = commission?.brief || {};
  const ability = commission?.targetAbility || 'video';
  const lines = [];
  lines.push(`Create a ${ability} piece. ${String(brief.intent || '').trim()}`.trim());
  if (brief.genre) lines.push(`Genre: ${brief.genre}.`);
  if (brief.category) lines.push(`Category: ${brief.category}.`);
  if (brief.styleSpec) lines.push(`Style: ${brief.styleSpec}.`);

  const digest = renderFeedbackDigest(commission?.feedback, commission?.feedbackWindow ?? 5);
  if (digest) lines.push(digest);

  const constraints = {};
  if (brief.constraints?.universeId) constraints.universeId = brief.constraints.universeId;
  if (brief.constraints?.seriesId) constraints.seriesId = brief.constraints.seriesId;

  // Hard-cap the goal so an internally-composed directive (scheduler path, which
  // skips the route's 5000-char validation) can never exceed what the CD planner
  // should receive.
  let goal = lines.join(' ');
  if (goal.length > MAX_DIRECTIVE_GOAL_LEN) goal = `${goal.slice(0, MAX_DIRECTIVE_GOAL_LEN - 1)}…`;

  return {
    goal,
    deliverables: [`One ${ability} artifact matching the brief`],
    constraints,
  };
}
