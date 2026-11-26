/** Builds POST practice recommendations and runnable maintenance review drills. */

import { resolveTopicForDrillType, isTopicEnabled, isMemoryItemEnabled } from '../../lib/postTopics.js';
import { APPLIED_NUMERACY_DRILL_TYPE } from '../../lib/postAppliedNumeracy.js';
import { cognitiveLevelConfig } from '../../lib/postProgression.js';
import { getDueReviews } from './meatspacePostReview.js';
import { normalizeYmd, recordDayKey, ymdShift } from '../../lib/postStreak.js';
import { getPostConfig } from './postConfig.js';

/**
 * Ready-to-run "maintenance rep" drill specs for the mastered skills currently
 * due for review — the labeled review items the launcher mixes into a Quick
 * session (issue #2096). Multiplication, Powers, and cognitive reps are generated
 * through the standard /post/drill path; memory-chunk retention is served by
 * the existing spaced-repetition due-items flow. Each carries `review: true` +
 * `reviewSkillId` so the session-submit path records the pass/fail.
 */
export async function getPostReviewReps(now = new Date(), limit = 2) {
  // Fetch ALL due reviews, then filter to the runnable kinds BEFORE capping —
  // capping first would let older due memory-chunk entries (which have no
  // runnable rep) consume the limit slots and starve runnable multiplication/
  // cognitive reps that are due later in the schedule.
  const [due, config] = await Promise.all([
    getDueReviews(now, Infinity),
    getPostConfig(),
  ]);
  const reps = [];
  for (const entry of due) {
    if (reps.length >= limit) break;
    // Review reps are mixed directly into Quick sessions, so enforce the same
    // topic, module-composition, module, and per-drill gates as recommendations.
    // A skill may have become due after the user switched that practice off.
    if (!isRecDrillRunnable(config, recModuleForDrillType(entry.drillType, 'cognitive'), entry.drillType)) continue;
    if (entry.kind === 'multiplication') {
      reps.push({
        skillId: entry.skillId,
        label: entry.label,
        state: entry.status === 'needs-refresh' ? 'needs-refresh' : 'due',
        module: 'mental-math',
        type: 'multiplication',
        config: { count: 5, level: entry.level, factors: entry.factors, review: true, reviewSkillId: entry.skillId },
      });
    } else if (entry.kind === 'powers') {
      reps.push({
        skillId: entry.skillId,
        label: entry.label,
        state: entry.status === 'needs-refresh' ? 'needs-refresh' : 'due',
        module: 'mental-math',
        type: 'powers',
        config: { ...(entry.config || {}), count: 5, level: entry.level, review: true, reviewSkillId: entry.skillId },
      });
    } else if (entry.kind === 'cognitive') {
      reps.push({
        skillId: entry.skillId,
        label: entry.label,
        state: entry.status === 'needs-refresh' ? 'needs-refresh' : 'due',
        module: 'cognitive',
        type: entry.drillType,
        config: { ...(entry.config || cognitiveLevelConfig(entry.drillType, entry.level)), level: entry.level, review: true, reviewSkillId: entry.skillId },
      });
    } else if (entry.kind === APPLIED_NUMERACY_DRILL_TYPE) {
      reps.push({
        skillId: entry.skillId,
        label: entry.label,
        state: entry.status === 'needs-refresh' ? 'needs-refresh' : 'due',
        module: 'mental-math',
        type: APPLIED_NUMERACY_DRILL_TYPE,
        config: { count: 5, difficulty: entry.difficulty, review: true, reviewSkillId: entry.skillId },
      });
    }
  }
  return reps;
}

// Cap on how many recommendations the launcher/widget surface — enough to fill
// an "Up next" panel without becoming a wall of tasks.
export const RECOMMENDATION_LIMIT = 5;
// Coarse module → domain routing for weak-skill recommendations. Only the
// domains a weak-skill rec can name are needed here; the full map lives on the
// client (constants.js DRILL_TO_DOMAIN). Prettify falls back to the drill type.
const DRILL_LABEL = (type) =>
  String(type || '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * EVERY scored drill with an accuracy signal, ranked weakest-first. Pure; reads
 * the shape `getPostStats` returns. Empty when there's no accuracy signal yet
 * (fresh install / all drills without derivable accuracy). Each entry is
 * `{ key, module, type, accuracy, samples }` where `key` is `"<module>:<type>"`.
 *
 * Ranked rather than single-valued because the caller has to keep looking past
 * the weakest drill when that one is disabled, excluded by `sessionModules`, or
 * was already practiced inside the recency window (issue #5319) — stopping at
 * the first candidate is what used to pin the tier to one drill forever.
 */
export function weakestSkillsFromStats(stats) {
  const acc = stats?.evidenceByDrillAccuracy || stats?.byDrillAccuracy || {};
  const counts = stats?.evidenceByDrillCount || stats?.byDrillCount || {};
  const ranked = [];
  for (const [key, a] of Object.entries(acc)) {
    if (typeof a !== 'number' || Number.isNaN(a)) continue;
    const samples = counts[key] || 0;
    if (samples < 1) continue;
    const sep = key.indexOf(':');
    ranked.push({
      key,
      module: sep >= 0 ? key.slice(0, sep) : null,
      type: sep >= 0 ? key.slice(sep + 1) : key,
      accuracy: a,
      samples,
    });
  }
  // Stable: equal-accuracy drills keep their `Object.entries` order here, and
  // the day rotation in `orderByRecencyRotation` is what breaks that tie later.
  return ranked.sort((a, b) => a.accuracy - b.accuracy);
}

/**
 * Stalled-progression descriptors from the resolved multiplication, Powers, and cognitive
 * ladders: a laddered drill the user is partway up but not yet advancing, with
 * how many more clean/fast reps remain to reach the next rung. Pure — takes the
 * already-resolved progress objects. A ladder that's mastered-and-advancing or
 * at its hardest rung contributes nothing.
 *
 * @param {object} mulProgress - getMultiplicationProgress() result
 * @param {object} powersProgress - getPowersProgress() result
 * @param {Record<string,object>} cogProgress - getCognitiveProgress() result
 * @param {{kochLevel:number, kochLevelSet:boolean, maxKochLevel:number}} morse
 */
export function stalledProgressions(mulProgress, powersProgress, cogProgress, morse) {
  const out = [];

  const ladderStall = (prog, drillType, label, deepLink) => {
    if (!prog || prog.atHardest || prog.currentMastered) return null;
    const cur = (prog.levels || []).find((r) => r.level === prog.level);
    if (!cur) return null;
    // Only surface a ladder the user has actually engaged with. A fresh install
    // sits at level 0 with 0 samples and an unearned floor — telling it to "keep
    // climbing" a drill that's never been run is noise, and it would also crowd
    // out the fresh-state "run your first POST" default (issue #2100 review).
    const engaged = (cur.samples || 0) > 0 || (prog.floorLevel || 0) > 0 || prog.level > 0;
    if (!engaged) return null;
    const next = (prog.levels || []).find((r) => r.level === prog.level + 1);
    const minSamples = prog.thresholds?.minSamples ?? 0;
    const remaining = Math.max(1, minSamples - (cur.samples || 0));
    return {
      drillType,
      label,
      remaining,
      nextLabel: next?.label || null,
      deepLink,
    };
  };

  const mul = ladderStall(mulProgress, 'multiplication', 'Multiplication', '/post/launcher');
  if (mul) out.push(mul);

  const powers = ladderStall(powersProgress, 'powers', 'Powers', '/post/launcher');
  if (powers) out.push(powers);

  for (const [type, prog] of Object.entries(cogProgress || {})) {
    const stall = ladderStall(prog, type, DRILL_LABEL(type), '/post/launcher');
    if (stall) out.push(stall);
  }

  // Morse Koch progression: surface only once the user has engaged with Morse
  // (a level has been set) and isn't already at the final Koch level — so a
  // fresh install is never nagged about a track it hasn't started.
  if (morse?.kochLevelSet && morse.kochLevel < (morse.maxKochLevel ?? Infinity)) {
    out.push({
      drillType: 'morse-copy',
      label: 'Morse',
      remaining: null,
      nextLabel: `Koch level ${morse.kochLevel + 1}`,
      deepLink: '/post/morse/copy',
    });
  }

  return out;
}

/**
 * Compose the ordered "what to practice next" list from already-gathered
 * signals. PURE + fully unit-testable — the async `getPostRecommendations`
 * gathers the inputs and delegates here. Priority order (highest first):
 *   1. Due memory items (spaced-repetition overdue)
 *   2. Due skill re-verifications (mastered-but-inactive skills, issue #2096)
 *   3. Weakest scored skill by recent accuracy
 *   4. Stalled ladder progressions (N more reps to advance)
 * When nothing is actionable (e.g. a fresh install with no history), a single
 * sensible default ("run a full POST") is returned so the panel is never empty.
 *
 * `practicedToday` (from `practicedTodayFromActivity`) then demotes — never
 * drops — anything already practiced today, and stamps each rec with the flag
 * the daily routine reads to know it has run out of new work (issue #3563).
 */
// The built-in Elements Song has its own study surface (`/post/memory/elements`)
// rather than the generic per-item practice route.
const ELEMENTS_SONG_ID = 'elements-song';

/**
 * Deep link that lands a due memory item INSIDE a practice mode rather than on
 * the item list (issue #3249) — an "Up next" rec should start the drill, not
 * open a page the user still has to navigate. Mode choice per surface:
 *   - Elements Song → `element-flash` (recall test; its study deck is one click
 *     away on that surface)
 *   - any other item → `spaced`, which targets the weakest chunks — exactly what
 *     an item that has come due needs.
 * Pure — exported for unit tests.
 */
export function memoryPracticeDeepLink(itemId) {
  if (!itemId) return '/post/memory';
  if (itemId === ELEMENTS_SONG_ID) return '/post/memory/elements/element-flash';
  return `/post/memory/${itemId}/spaced`;
}

/**
 * The memory item a `kind: 'memory'` review entry belongs to. Prefers the
 * explicit `memoryItemId` field; falls back to parsing the `memory:<itemId>:<chunkId>`
 * skillId, splitting on the LAST colon so an item id containing one still
 * resolves. Returns null for a non-memory or unparseable entry. Pure.
 */
export function memoryItemIdFromReview(review) {
  if (review?.memoryItemId) return review.memoryItemId;
  const skillId = review?.skillId;
  if (typeof skillId !== 'string' || !skillId.startsWith('memory:')) return null;
  const rest = skillId.slice('memory:'.length);
  const lastColon = rest.lastIndexOf(':');
  const itemId = lastColon > 0 ? rest.slice(0, lastColon) : rest;
  return itemId || null;
}

/**
 * What the user has already practiced today, from BOTH scored POST sessions and
 * the training log (Morse/Wordplay/Memory practice never post a scored session).
 * Pure — exported for unit tests.
 *
 * "Continue Today's Routine" walks this recommendation list one item at a time,
 * but every signal feeding it (weakest recent accuracy, stalled ladder) is a
 * windowed average that a single rep barely moves — so without a
 * what-have-I-already-done gate the same drill stays pinned at the top and the
 * routine hands back the drill just finished, forever (issue #3563).
 *
 * @param {Array} sessions - all scored sessions (`{ date, tasks: [{ type }] }`)
 * @param {Array} trainingEntries - all training-log entries
 * @param {string|null} todayStr - the user's local `YYYY-MM-DD`
 * @param {string} [timezone] - user timezone for re-keying legacy ISO dates
 * @returns {{ drillTypes: Set<string>, memoryItemIds: Set<string>, completedSession: boolean }}
 */
function activityOnDays(sessions, trainingEntries, dayKeys, timezone) {
  const drillTypes = new Set();
  const memoryItemIds = new Set();
  let completedSession = false;

  // Both feeds go through recordDayKey, which re-derives the day from each
  // record's own instant in the CURRENT timezone (#4168) — matching against
  // the stored `date` would read a record written under a previous timezone (or
  // a memory-practice entry carrying a full ISO timestamp) as not-practiced.
  for (const session of sessions || []) {
    if (!dayKeys.has(recordDayKey(session, timezone))) continue;
    completedSession = true;
    for (const task of session.tasks || []) {
      if (task?.type) drillTypes.add(task.type);
      if (task?.memoryItemId) memoryItemIds.add(task.memoryItemId);
    }
  }
  for (const entry of trainingEntries || []) {
    if (!dayKeys.has(recordDayKey(entry, timezone))) continue;
    // Training entries are two shapes sharing one log: drill practice carries
    // `drillType`, memory practice carries `memoryItemId` + `mode`.
    if (entry.drillType) drillTypes.add(entry.drillType);
    if (entry.memoryItemId) memoryItemIds.add(entry.memoryItemId);
  }
  return { drillTypes, memoryItemIds, completedSession };
}

export function practicedTodayFromActivity(sessions = [], trainingEntries = [], todayStr = null, timezone) {
  // No resolvable local day ⇒ report nothing practiced rather than guessing, so
  // the routine degrades to its pre-#3563 ordering instead of silently demoting.
  const today = normalizeYmd(todayStr, timezone);
  if (!today) return { drillTypes: new Set(), memoryItemIds: new Set(), completedSession: false };
  return activityOnDays(sessions, trainingEntries, new Set([today]), timezone);
}

/**
 * How many local calendar days the heuristic-tier recency window spans — today
 * plus the previous two. Wide enough that a drill practiced yesterday yields to
 * something else, narrow enough that a three-drill rotation still comes back
 * around every third day.
 */
export const RECENT_PRACTICE_WINDOW_DAYS = 3;

/**
 * What the user has practiced across the last `windowDays` LOCAL calendar days,
 * from both scored sessions and the training log (issue #5319).
 *
 * This is the multi-day sibling of `practicedTodayFromActivity`, and it feeds a
 * different decision. `practicedToday` demotes an already-completed rec in
 * EVERY tier — including schedule-driven due memory items and due reviews. This
 * window only reorders the two HEURISTIC tiers (weakest skill, stalled ladder),
 * whose signals are windowed averages a single rep barely moves, so the same
 * drill would otherwise stay pinned to the top slot day after day. A genuinely
 * due item is never deprioritized by it.
 *
 * Pure — exported for unit tests. Carries no prompts or session content, only
 * drill types and memory item ids, and persists nothing.
 *
 * @param {Array} sessions - all scored sessions (`{ date, tasks: [{ type }] }`)
 * @param {Array} trainingEntries - all training-log entries
 * @param {string|null} todayStr - the user's local `YYYY-MM-DD`
 * @param {string} [timezone] - user timezone for re-keying legacy ISO dates
 * @param {number} [windowDays] - calendar days to look back over, including today
 * @returns {{ dayKey: string|null, drillTypes: Set<string>, memoryItemIds: Set<string> }}
 */
export function recentPracticeFromActivity(sessions = [], trainingEntries = [], todayStr = null, timezone, windowDays = RECENT_PRACTICE_WINDOW_DAYS) {
  // No resolvable local day ⇒ no window, and callers fall back to plain
  // priority order rather than rotating off a guessed day.
  const today = normalizeYmd(todayStr, timezone);
  if (!today) return { dayKey: null, drillTypes: new Set(), memoryItemIds: new Set() };

  const span = Math.max(1, Math.trunc(windowDays) || 1);
  const days = new Set(Array.from({ length: span }, (_, i) => ymdShift(today, -i)));
  const { drillTypes, memoryItemIds } = activityOnDays(sessions, trainingEntries, days, timezone);
  return { dayKey: today, drillTypes, memoryItemIds };
}

export function composePostRecommendations({
  dueMemoryItems = [],
  dueReviews = [],
  weakestSkill = null,
  stalled = [],
  hasHistory = false,
  practicedToday = null,
  limit = RECOMMENDATION_LIMIT,
} = {}) {
  // Copied into Sets so an array-shaped `practicedToday` (a JSON round-trip, or
  // a test literal) works the same as the live Set-bearing one.
  const doneTypes = new Set(practicedToday?.drillTypes || []);
  const doneItems = new Set(practicedToday?.memoryItemIds || []);
  const recs = [];

  for (const item of dueMemoryItems) {
    recs.push({
      id: `memory-due:${item.id}`,
      kind: 'memory-due',
      title: `Review "${item.title}"`,
      detail: 'Due for spaced-repetition practice',
      deepLink: memoryPracticeDeepLink(item.id),
      drillType: 'memory-sequence',
      memoryItemId: item.id,
    });
  }

  for (const review of dueReviews) {
    const reviewItemId = review.kind === 'memory' ? memoryItemIdFromReview(review) : null;
    // A memory-chunk re-verification can't run through the launcher's review-rep
    // path (getPostReviewReps only regenerates multiplication/cognitive reps —
    // memory retention lives under /post/memory), so route it there instead of a
    // dead /post/launcher link (issue #2100 review). It routes all the way INTO a
    // practice mode rather than the item list (issue #3249).
    recs.push({
      id: `skill-review:${review.skillId}`,
      kind: 'skill-review',
      title: `Re-verify ${review.label}`,
      detail: review.status === 'needs-refresh'
        ? 'Needs a refresh — last review slipped'
        : 'Maintenance rep due',
      deepLink: review.kind === 'memory'
        ? memoryPracticeDeepLink(reviewItemId)
        : '/post/launcher',
      drillType: review.drillType || null,
      memoryItemId: reviewItemId,
    });
  }

  if (weakestSkill) {
    recs.push({
      id: `weak-skill:${weakestSkill.key}`,
      kind: 'weak-skill',
      title: `Shore up ${DRILL_LABEL(weakestSkill.type)}`,
      detail: `Weakest skill lately — ${Math.round((weakestSkill.accuracy || 0) * 100)}% accuracy`,
      deepLink: weakestSkill.deepLink || '/post/launcher',
      drillType: weakestSkill.type,
    });
  }

  for (const stall of stalled) {
    const remainText = stall.remaining != null
      ? `${stall.remaining} more clean rep${stall.remaining === 1 ? '' : 's'} to reach ${stall.nextLabel || 'the next level'}`
      : `Advance to ${stall.nextLabel || 'the next level'}`;
    recs.push({
      id: `stalled:${stall.drillType}`,
      kind: 'stalled-progression',
      title: `${stall.label}: keep climbing`,
      detail: remainText,
      deepLink: stall.deepLink,
      drillType: stall.drillType,
    });
  }

  if (recs.length === 0) {
    recs.push({
      id: 'default:full-post',
      kind: 'default',
      title: hasHistory ? 'Keep your streak going' : 'Run your first POST',
      detail: hasHistory
        ? 'No specific gaps right now — run a full self-test to stay sharp.'
        : 'Complete a full self-test to start tracking what to practice next.',
      deepLink: '/post/launcher',
      drillType: null,
    });
  }

  // One rule, applied after the list is built, so a rec kind added later inherits
  // it instead of shipping an undefined flag. A rec's identity is whatever it
  // actually sends the user to practice: a memory ITEM for the two memory-shaped
  // recs, a drill TYPE for the ladder/weak-skill ones, and — for the "run a full
  // self-test" fallback, which names neither — any scored session at all.
  const isPracticedToday = (rec) => {
    if (rec.memoryItemId) return doneItems.has(rec.memoryItemId);
    if (rec.drillType) return doneTypes.has(rec.drillType);
    return Boolean(practicedToday?.completedSession);
  };
  // Demoted, not dropped: a fully-practiced day should still show what's up next
  // rather than an empty panel. `sort` is stable, so the priority order above is
  // preserved within each group; callers that want to STOP (the daily routine)
  // read the flag on the top rec.
  const ordered = recs
    .map(rec => ({ ...rec, practicedToday: isPracticedToday(rec) }))
    .sort((a, b) => a.practicedToday - b.practicedToday);

  return ordered.slice(0, Math.max(1, limit)).map((r, i) => ({ ...r, priority: i }));
}

// Coarse module → config key for the enabled-drill lookup.
const MODULE_CONFIG_KEY = { 'mental-math': 'mentalMath', 'llm-drills': 'llmDrills', cognitive: 'cognitive' };

/**
 * The module string `isRecDrillRunnable` should be called with for a given drill
 * type, derived from the topic registry rather than hardcoded per call site.
 *
 * Morse carries a null registry module (it never posts a scored POST task) but is
 * gated by its own config block, so it maps to the `morse` pseudo-module the gate
 * understands. `fallback` covers a drill type with no registry entry.
 */
export function recModuleForDrillType(type, fallback) {
  const topic = resolveTopicForDrillType(type);
  return topic ? (topic.module || topic.id) : fallback;
}

/**
 * Whether a recommended drill can actually be run under the current config
 * (issue #2100 review): a weak-skill / stalled rec deep-links into a session,
 * so recommending a drill the user has since disabled — or a module they've
 * removed from Session Composition — would be a dead end.
 *
 * Three gates, checked in order (issue #3252):
 *   1. The drill's practice TOPIC — off means off everywhere, including the
 *      dedicated Memory and Morse practice routes.
 *   2. Recommendation-specific participation — memory due-item recommendations
 *      deep-link to dedicated practice, so `sessionModules` doesn't apply;
 *      memory still honors the per-ITEM toggle when the caller knows the item.
 *   3. Session composition + the per-module/per-drill `enabled` flags.
 *
 * `memoryItemId` is only meaningful for `module === 'memory'`; absent means
 * "no specific item", which is never filtered.
 * Pure — exported for unit tests.
 */
export function isRecDrillRunnable(config, module, type, memoryItemId = null) {
  // An unmapped drill type has no topic — treat it as not topic-gated rather
  // than disabled, so a type added ahead of its registry entry still surfaces.
  const topic = resolveTopicForDrillType(type);
  if (topic && !isTopicEnabled(config, topic.id)) return false;

  if (module === 'memory') {
    if (config?.memory?.enabled === false) return false;
    const dt = config?.memory?.drillTypes?.[type];
    if (dt && dt.enabled === false) return false;
    return isMemoryItemEnabled(config, memoryItemId);
  }
  // Morse isn't a POST module (it never posts a scored task), so it is gated by
  // its own block alone — never by sessionModules, which can't contain it.
  if (module === 'morse') return config?.morse?.enabled !== false;

  const sm = Array.isArray(config?.sessionModules) ? config.sessionModules : null;
  // null = legacy/absent → all modules allowed; an explicit array must include it.
  if (sm !== null && !sm.includes(module)) return false;
  const key = MODULE_CONFIG_KEY[module];
  if (!key) return true; // unknown module — don't filter it out
  // An absent module/drill entry means "default" (enabled) — getPostConfig
  // deep-merges the enabled-by-default config, so only an EXPLICIT `false`
  // disables it.
  const mod = config?.[key];
  if (mod && mod.enabled === false) return false;
  const dt = mod?.drillTypes?.[type];
  return !dt || dt.enabled !== false;
}
