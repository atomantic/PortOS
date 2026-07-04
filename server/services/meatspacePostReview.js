/**
 * MeatSpace POST — Skill re-verification scheduler (issue #2096)
 *
 * POST can detect when you've MASTERED a skill (a multiplication rung below your
 * current level, a cognitive rung you've passed, a mastered memory chunk) but
 * never checked whether you STILL know it. This service adds a lightweight,
 * SM-2-style review scheduler for those mastered-but-inactive skills:
 *
 *   - When a skill first becomes mastered it's tracked with `masteredAt` and a
 *     first review due 7 days out.
 *   - Left un-practiced, it goes "due for review" on an expanding interval
 *     (7 → 30 → 90 days). Passing a maintenance review pushes the next review
 *     further out; failing one flips it to "needs refresh" and schedules a
 *     sooner re-review — but NEVER demotes the underlying `floorLevel` (the
 *     anti-frustration guard lives in the progression ladder, untouched here).
 *   - Actively practicing a mastered skill (any non-review session at it) resets
 *     its staleness clock, so only genuinely inactive skills ever surface.
 *
 * Storage: `data/meatspace/post-review-schedule.json` — a small sibling of the
 * other `data/meatspace/post-*.json` files. Meatspace is `file-primary` per
 * docs/STORAGE.md (an iCloud/file-sync store family), so a JSON sibling is the
 * classification-correct home; the schedule is created lazily on first mastery,
 * so a fresh install (or legacy data with no schedule) simply has nothing due.
 *
 * This module is a pure store + scheduler: it does NOT read session history or
 * compute mastery itself (that lives in meatspacePost.js / meatspacePostMemory.js
 * which already import both). Callers hand it skill descriptors; it owns the
 * review-schedule state machine and one load-modify-save per session.
 */

import { join } from 'path';
import { atomicWrite, PATHS, ensureDir, readJSONFile } from '../lib/fileUtils.js';

const MEATSPACE_DIR = PATHS.meatspace;
const REVIEW_SCHEDULE_FILE = join(MEATSPACE_DIR, 'post-review-schedule.json');

// Expanding review intervals (days) after mastery — SM-2-flavored per skill.
export const REVIEW_INTERVALS_DAYS = [7, 30, 90];
// A failed review schedules a much sooner re-review (and flips to needs-refresh).
export const REFRESH_INTERVAL_DAYS = 3;
// Retention % window (reviews passed / taken) reported in the progress dashboard.
export const RETENTION_WINDOW_DAYS = 90;
// Cap the per-skill review history so the file can't grow without bound.
const MAX_REVIEW_HISTORY = 25;
const DAY_MS = 24 * 60 * 60 * 1000;

function addDays(nowMs, days) {
  return new Date(nowMs + days * DAY_MS).toISOString();
}

function intervalForStage(stage) {
  const idx = Math.max(0, Math.min(REVIEW_INTERVALS_DAYS.length - 1, stage));
  return REVIEW_INTERVALS_DAYS[idx];
}

// =============================================================================
// STORE
// =============================================================================

async function loadReviewSchedule() {
  const data = await readJSONFile(REVIEW_SCHEDULE_FILE, { skills: {} }, { allowArray: false });
  const skills = data?.skills && typeof data.skills === 'object' ? data.skills : {};
  return { skills };
}

async function saveReviewSchedule(schedule) {
  await ensureDir(MEATSPACE_DIR);
  await atomicWrite(REVIEW_SCHEDULE_FILE, { skills: schedule.skills || {} });
}

// =============================================================================
// PURE STATE-MACHINE HELPERS (exported for unit tests)
// =============================================================================

/** Fresh entry for a newly-mastered skill — first review one interval out. */
export function defaultReviewEntry(skill, now = new Date()) {
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  return {
    skillId: skill.skillId,
    kind: skill.kind,               // 'multiplication' | 'cognitive' | 'memory'
    label: skill.label,
    drillType: skill.drillType,     // drill type to regenerate a review rep
    level: skill.level ?? null,     // rung index (multiplication/cognitive)
    factors: skill.factors ?? null, // multiplication factor plan
    config: skill.config ?? null,   // cognitive rung knobs for regeneration
    memoryItemId: skill.memoryItemId ?? null,
    chunkId: skill.chunkId ?? null,
    masteredAt: nowIso,
    lastPracticedAt: nowIso,
    lastReviewedAt: null,
    reviewStage: 0,
    nextReviewAt: addDays(nowMs, REVIEW_INTERVALS_DAYS[0]),
    status: 'fresh',                // 'fresh' | 'needs-refresh'
    reviewsPassed: 0,
    reviewsTaken: 0,
    reviewHistory: [],              // [{ date, passed }]
  };
}

/** True when a tracked skill's review is due (`nextReviewAt <= now`). */
export function isReviewDue(entry, now = new Date()) {
  const t = Date.parse(entry?.nextReviewAt ?? '');
  if (Number.isNaN(t)) return true;
  return t <= now.getTime();
}

/**
 * Retention state for reporting: `fresh` (mastered, not yet due), `due` (review
 * overdue), or `needs-refresh` (last review failed, awaiting a sooner re-review).
 */
export function reviewState(entry, now = new Date()) {
  if (entry?.status === 'needs-refresh') return 'needs-refresh';
  return isReviewDue(entry, now) ? 'due' : 'fresh';
}

/**
 * 90-day retention: reviews passed / reviews taken within the window. Returns
 * `null` when no reviews have been taken in the window (nothing to report yet).
 */
export function retentionForEntry(entry, now = new Date(), windowDays = RETENTION_WINDOW_DAYS) {
  const cutoff = now.getTime() - windowDays * DAY_MS;
  const history = Array.isArray(entry?.reviewHistory) ? entry.reviewHistory : [];
  let taken = 0;
  let passed = 0;
  for (const h of history) {
    const t = Date.parse(h?.date ?? '');
    if (Number.isNaN(t) || t < cutoff) continue;
    taken += 1;
    if (h.passed) passed += 1;
  }
  return { reviewsTaken: taken, reviewsPassed: passed, retentionPct: taken ? Math.round((passed / taken) * 100) : null };
}

/** Apply a passed/failed review to an entry (pure — returns a new entry). */
export function applyReviewResult(entry, passed, now = new Date()) {
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const history = [...(Array.isArray(entry.reviewHistory) ? entry.reviewHistory : []), { date: nowIso, passed: !!passed }]
    .slice(-MAX_REVIEW_HISTORY);
  const next = {
    ...entry,
    lastReviewedAt: nowIso,
    lastPracticedAt: nowIso,
    reviewsTaken: (entry.reviewsTaken || 0) + 1,
    reviewsPassed: (entry.reviewsPassed || 0) + (passed ? 1 : 0),
    reviewHistory: history,
  };
  if (passed) {
    // Passed a maintenance rep — push the next review further out (expanding
    // interval) and clear any needs-refresh flag.
    next.reviewStage = Math.min(REVIEW_INTERVALS_DAYS.length - 1, (entry.reviewStage || 0) + 1);
    next.status = 'fresh';
    next.nextReviewAt = addDays(nowMs, intervalForStage(next.reviewStage));
  } else {
    // Failed — flip to needs-refresh and re-review much sooner. NEVER touches
    // floorLevel: the anti-frustration ladder guard is intentionally untouched.
    next.reviewStage = 0;
    next.status = 'needs-refresh';
    next.nextReviewAt = addDays(nowMs, REFRESH_INTERVAL_DAYS);
  }
  return next;
}

/**
 * Actively practicing a mastered skill (a normal, non-review session at it)
 * resets its staleness clock so it doesn't nag for a maintenance rep the user is
 * already doing. Refreshes `lastPracticedAt` and pushes `nextReviewAt` out by
 * the current stage's interval; does not count as a formal review.
 */
export function applyPractice(entry, now = new Date()) {
  const nowMs = now.getTime();
  return {
    ...entry,
    lastPracticedAt: now.toISOString(),
    // Only push the clock FORWARD — never pull a due/needs-refresh review earlier.
    nextReviewAt: (() => {
      const bumped = addDays(nowMs, intervalForStage(entry.reviewStage || 0));
      const cur = Date.parse(entry.nextReviewAt ?? '');
      return Number.isNaN(cur) || Date.parse(bumped) > cur ? bumped : entry.nextReviewAt;
    })(),
    // Practicing a needs-refresh skill clears the refresh flag (they're on it).
    status: entry.status === 'needs-refresh' ? 'fresh' : entry.status,
  };
}

// =============================================================================
// SESSION SYNC — one load-modify-save
// =============================================================================

/**
 * Reconcile the review schedule against a just-completed session:
 *   1. Upsert every currently-mastered skill (new ones get `masteredAt=now` +
 *      a first review 7d out). Existing entries refresh their label/drill
 *      metadata but keep their review schedule.
 *   2. Record formal review results for review reps in this session
 *      (`reviewResults`) — pass pushes the interval out, fail → needs-refresh.
 *   3. Reset the staleness clock for mastered skills actively practiced this
 *      session (`practicedSkillIds`) that were NOT themselves review reps.
 *
 * @param {object} args
 * @param {Array} args.masteredSkills - current mastered-skill descriptors
 * @param {string[]} [args.practicedSkillIds] - skill ids exercised this session
 * @param {Array<{skillId,passed}>} [args.reviewResults] - review-rep outcomes
 * @param {Date} [args.now]
 * @returns {Promise<{added:number, reviewed:number, refreshed:number}>}
 */
export async function applySessionToReviewSchedule({ masteredSkills = [], practicedSkillIds = [], reviewResults = [], now = new Date() } = {}) {
  const schedule = await loadReviewSchedule();
  const skills = schedule.skills;
  let added = 0;
  let reviewed = 0;
  let refreshed = 0;

  // 1. Upsert mastered skills.
  for (const skill of masteredSkills) {
    if (!skill?.skillId) continue;
    const existing = skills[skill.skillId];
    if (!existing) {
      skills[skill.skillId] = defaultReviewEntry(skill, now);
      added += 1;
    } else {
      // Refresh mutable descriptor metadata (label/drill config can evolve) but
      // preserve the earned review schedule.
      existing.label = skill.label ?? existing.label;
      existing.drillType = skill.drillType ?? existing.drillType;
      existing.level = skill.level ?? existing.level;
      existing.factors = skill.factors ?? existing.factors;
      existing.config = skill.config ?? existing.config;
      existing.memoryItemId = skill.memoryItemId ?? existing.memoryItemId;
      existing.chunkId = skill.chunkId ?? existing.chunkId;
    }
  }

  // 2. Record formal review results.
  const reviewedIds = new Set();
  for (const r of reviewResults) {
    if (!r?.skillId || !skills[r.skillId]) continue;
    skills[r.skillId] = applyReviewResult(skills[r.skillId], !!r.passed, now);
    reviewedIds.add(r.skillId);
    reviewed += 1;
  }

  // 3. Reset staleness for actively-practiced (non-review) mastered skills.
  for (const id of practicedSkillIds) {
    if (reviewedIds.has(id)) continue; // a review rep already updated it
    if (!skills[id]) continue;
    skills[id] = applyPractice(skills[id], now);
    refreshed += 1;
  }

  await saveReviewSchedule(schedule);
  if (added || reviewed) {
    console.log(`🔁 POST review schedule: +${added} mastered, ${reviewed} reviewed, ${refreshed} refreshed`);
  }
  return { added, reviewed, refreshed };
}

// =============================================================================
// READ API
// =============================================================================

/** All tracked review entries (array). */
export async function getReviewSchedule() {
  const { skills } = await loadReviewSchedule();
  return Object.values(skills);
}

/**
 * Mastered skills whose maintenance review is currently due (or needs-refresh),
 * most-overdue first, capped at `limit`. These become the labeled "maintenance
 * reps" the launcher mixes into a Quick session.
 */
export async function getDueReviews(now = new Date(), limit = 2) {
  const entries = await getReviewSchedule();
  return entries
    .filter(e => reviewState(e, now) !== 'fresh')
    .sort((a, b) => Date.parse(a.nextReviewAt || 0) - Date.parse(b.nextReviewAt || 0))
    .slice(0, Math.max(0, limit));
}

/**
 * Per-skill retention states + an overall 90-day retention % for the progress
 * dashboard mastery block (issue #2091 + #2096).
 */
export async function getRetentionReport(now = new Date()) {
  const entries = await getReviewSchedule();
  let totalTaken = 0;
  let totalPassed = 0;
  const skills = entries.map(e => {
    const ret = retentionForEntry(e, now);
    totalTaken += ret.reviewsTaken;
    totalPassed += ret.reviewsPassed;
    return {
      skillId: e.skillId,
      kind: e.kind,
      label: e.label,
      state: reviewState(e, now),
      masteredAt: e.masteredAt,
      nextReviewAt: e.nextReviewAt,
      retentionPct: ret.retentionPct,
    };
  });
  const dueCount = skills.filter(s => s.state !== 'fresh').length;
  return {
    skills,
    dueCount,
    trackedCount: skills.length,
    retentionPct: totalTaken ? Math.round((totalPassed / totalTaken) * 100) : null,
    windowDays: RETENTION_WINDOW_DAYS,
  };
}
