/**
 * Character Skill Registry: derives per-domain skills (Wordsmith, Mentalist, Vitalist, Strategist,
 * Archivist, Auteur) from stats each domain already exposes; no new usage-event bus.
 *
 * Derived on read, never persisted: `saveCharacter()` and `getWireCharacter()` strip them, because
 * usage differs per machine and federating it under LWW would let the least-used peer overwrite the most-used.
 *
 * Sentinel + validate: no activity yields level 0 / value 0; a failed or non-finite read yields
 * `{ level: null, value: null, unavailable: true }`. The two must never collapse.
 *
 * Reads come from the shared `read(signalId)` context in `characterSignals.js` (one read per signal per
 * request); file-backed signals read strictly (#2726) so `readSkill` can classify a failure.
 */

import { createSignalContext } from './characterSignals.js';

// Skills plateau rather than growing without bound, so a level can't dwarf the age-based character level.
export const MAX_SKILL_LEVEL = 20;

/**
 * Pure bucketed log curve: each doubling of `value` adds one level (value (2^n - 1) x scale -> level n).
 * `scale` is the domain's "one unit of meaningful use", so each domain reaches level 1 at its own cadence.
 * Non-finite/negative input floors to 0; callers must classify "unavailable" BEFORE this (see `readSkill`).
 */
export function levelFromValue(value, scale) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return Math.min(MAX_SKILL_LEVEL, Math.floor(Math.log2(value / safeScale + 1)));
}

// Sentinel for a failed stat read: a unique Symbol so it can't be mistaken for a real count.
const STAT_UNAVAILABLE = Symbol('stat-unavailable');

/**
 * The registry: `{ id, label, domain, scale, compute }`, where `compute(read)` resolves to the domain's
 * cumulative engagement. `read` is the shared signal context; never import a domain getter here.
 * Cumulative, never streak-based, so an earned skill doesn't un-learn after a week off (the metrics grid reports streaks).
 */
export const SKILLS = [
  {
    id: 'wordsmith',
    label: 'Wordsmith',
    domain: 'create',
    // Worldbuilding is slow, high-effort work, so the first level comes cheap.
    scale: 2,
    // Universes, catalog ingredients, scraps and Writers Room works (its own store; omitting it would
    // strand a writing-only user at level 0). All tallies, never listings (#2729).
    compute: async (read) => {
      const [universeCount, workCount, catalog] = await Promise.all([
        read('universeCount'),
        read('workCount'),
        read('catalogStats'),
      ]);
      return universeCount + workCount + catalog.total + catalog.scraps;
    },
  },
  {
    id: 'mentalist',
    label: 'Mentalist',
    domain: 'post',
    scale: 3,
    // Scored sessions + training-log entries: the same union the unified POST streak uses.
    compute: async (read) => {
      const [sessions, training] = await Promise.all([read('postSessions'), read('postTraining')]);
      return sessions.length + training.length;
    },
  },
  {
    id: 'vitalist',
    label: 'Vitalist',
    domain: 'health',
    // Health logs are near-daily and cheap, so a stretched curve.
    scale: 5,
    compute: async (read) => (await read('loggingStats')).totalLogged,
  },
  {
    id: 'strategist',
    label: 'Strategist',
    domain: 'goals',
    scale: 3,
    // Goal discipline, not count: check-ins plus recorded progress steps.
    compute: async (read) => {
      const { goals } = await read('goals');
      return (goals || []).reduce(
        (sum, goal) => sum + (goal.checkIns?.length || 0) + (goal.progressHistory?.length || 0),
        0
      );
    },
  },
  {
    id: 'archivist',
    label: 'Archivist',
    domain: 'brain',
    // Memories accrue fastest (one Brain capture can mint several), so the flattest curve.
    scale: 10,
    compute: async (read) => read('memoryCount'),
  },
  {
    id: 'auteur',
    label: 'Auteur',
    domain: 'media',
    scale: 5,
    // Rendered images + videos in the durable media asset index.
    compute: async (read) => read('assetCount'),
  },
];

/**
 * Resolve one skill to its response shape. `compute` rejecting or resolving non-finite is `unavailable`
 * (a fake 0 would read as "no activity"); resolving 0 is a real, earned level 0.
 */
async function readSkill(skill, read) {
  // `Promise.resolve().then(...)`: a non-async compute that throws synchronously must degrade this one skill, not reject the GET.
  const raw = await Promise.resolve().then(() => skill.compute(read)).catch((err) => {
    // `err?.message ?? err`: a non-Error rejection would otherwise throw inside the catch.
    console.warn(`⚠️ Character skill ${skill.id}: stat read failed — ${err?.message ?? err}`);
    return STAT_UNAVAILABLE;
  });

  const base = { id: skill.id, label: skill.label, domain: skill.domain };

  if (raw === STAT_UNAVAILABLE || !Number.isFinite(raw) || raw < 0) {
    if (raw !== STAT_UNAVAILABLE) {
      console.warn(`⚠️ Character skill ${skill.id}: stat returned a non-countable value`);
    }
    // level/value stay null, NOT 0, so an unread domain never renders as legitimately empty.
    return { ...base, level: null, value: null, unavailable: true };
  }

  return { ...base, level: levelFromValue(raw, skill.scale), value: raw, unavailable: false };
}

/**
 * Compute every skill. Domains are read in parallel and each failure is contained to its own skill,
 * degrading that entry to `unavailable` instead of failing `GET /api/character`.
 * Callers deriving more than skills from one request must pass ONE shared `read` context to avoid double reads.
 */
export async function getCharacterSkills(read = createSignalContext()) {
  const postEnabled = await read('postEnabled');
  const skills = postEnabled ? SKILLS : SKILLS.filter((skill) => skill.domain !== 'post');
  return Promise.all(skills.map((skill) => readSkill(skill, read)));
}
