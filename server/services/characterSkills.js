/**
 * Character Skill Registry (#2674, epic #2672)
 *
 * Derives per-domain "skills" — Wordsmith (Create), Mentalist (POST), Vitalist
 * (Health), Strategist (Goals), Archivist (Brain), Auteur (Media) — from the
 * stats each domain ALREADY exposes. There is deliberately **no new usage-event
 * bus**: every `compute()` composes an existing getter, so a domain the user has
 * never touched costs one cheap read and yields level 0.
 *
 * **Derived on read, never persisted.** `getCharacter()` attaches these to its
 * response; `saveCharacter()` strips them (they are in `character.js`'s
 * `DERIVED_FIELDS`), and `getWireCharacter()` strips them from the federation
 * snapshot. That is on purpose: usage differs per machine, so federating a
 * usage-derived value under LWW would let the peer you use *least* overwrite the
 * peer you use *most*.
 *
 * **Sentinel + validate.** A domain with no activity yields `level 0 / value 0`;
 * a domain whose stat read *fails* — or returns a non-finite value — yields
 * `{ level: null, value: null, unavailable: true }`. These two states must never
 * collapse: a fake 0 would read as "you have never written anything" when the
 * truth is "we could not tell".
 *
 * **Reads come from a shared context.** Each `compute()` takes a `read(signalId)` from
 * `characterSignals.js` rather than importing a domain getter itself, so the six skills and
 * the metrics grid (#2676) — which derive from the same nine signals — cost ONE read per
 * signal per request, not one per consumer.
 *
 * **Known gap in that guarantee (#2726).** `readSkill` honours whatever a domain
 * reports, but it can only *detect* a failure the getter actually surfaces — by
 * rejecting, or by resolving something non-countable. Today only the DB-backed
 * getters do that:
 *
 *   - reports failure  → `wordsmith`, `archivist`, `auteur` (a failed `query()` throws)
 *   - SWALLOWS failure → `mentalist`, `vitalist`, `strategist`
 *
 * The swallowing three bottom out in `readJSONFile`, which returns its default on
 * *every* read error and not just ENOENT — so a corrupt or unreadable
 * `post-sessions.json` is indistinguishable here from "no sessions yet" and reports a
 * real-looking level 0. Closing it needs strict-read variants threaded through the
 * shared file getters (the `readVideoHistoryStrict` `{ ok, list }` precedent in
 * `mediaAssetIndex/db.js`), which is a wider change than this registry — tracked in
 * #2726. Nothing here needs to change when it lands: the moment a getter starts
 * reporting failure, `readSkill` already classifies it correctly.
 */

import { createSignalContext } from './characterSignals.js';

// Skills plateau rather than growing without bound — past this the curve is
// noise, and an unbounded level would dwarf the age-based character level.
export const MAX_SKILL_LEVEL = 20;

/**
 * Pure bucketed log curve: each *doubling* of `value` adds one level, so a skill
 * climbs quickly at first and then needs exponentially more use — the shape of an
 * RPG XP table, without a table to maintain.
 *
 * `scale` is the domain's "one unit of meaningful use" (a POST session is worth
 * more than a single health log), so every domain reaches level 1 at its own
 * natural cadence instead of forcing one global cadence onto all six.
 *
 *   value 0             → 0   (empty domain → base level; never divides by zero)
 *   value 1×scale       → 1
 *   value 3×scale       → 2
 *   value 7×scale       → 3      …  value (2^n − 1)×scale → n
 *
 * Non-finite/negative input floors to 0 rather than throwing — but note callers
 * must classify "unavailable" BEFORE reaching this curve (see `readSkill`), since
 * a 0 here means a genuinely empty domain.
 */
export function levelFromValue(value, scale) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return Math.min(MAX_SKILL_LEVEL, Math.floor(Math.log2(value / safeScale + 1)));
}

// Sentinel returned by a failed stat read. A unique Symbol (not null/0/-1) so it
// can never be mistaken for a real count a domain legitimately reported.
const STAT_UNAVAILABLE = Symbol('stat-unavailable');

/**
 * The registry. Each entry is `{ id, label, domain, scale, compute }`, where
 * `compute(read)` resolves to a single non-negative number: the domain's cumulative
 * engagement. `read` is the shared signal context (`characterSignals.js`) — never import a
 * domain getter here, or this skill's reads stop being shared with the metrics grid.
 *
 * Values are **cumulative**, never streak-based: a streak resets to 0 after one
 * missed day, and a skill you have already earned should not un-learn itself
 * because you took a week off. (The metrics grid reports the *streaks* off the same
 * signals — the two are complementary readings, not duplicates.)
 */
export const SKILLS = [
  {
    id: 'wordsmith',
    label: 'Wordsmith',
    domain: 'create',
    // Worldbuilding is slow, high-effort work — a handful of records is already
    // real engagement, so the first level comes cheap.
    scale: 2,
    // Everything Create/Writers Room actually produces: universes authored, catalog
    // ingredients, captured scraps, and Writers Room works. Writers Room is its own store, so
    // omitting it would leave a writing-only user stuck at level 0 in the very skill named
    // for their work.
    //
    // All four reads are tallies, never listings (#2729): countUniverses/countWorks are
    // COUNT(*)s that exclude tombstones exactly as listUniverses()/listWorks() filter them,
    // so this no longer materializes every universe record, the universe-run history, or
    // every work's rebuilt manifest just to read a `.length`.
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
    // Scored sessions + training-log entries (Morse / memory practice) — the same
    // "either counts as activity" union the unified POST streak uses, so this
    // can't disagree with what the Progress page calls practice.
    compute: async (read) => {
      const [sessions, training] = await Promise.all([read('postSessions'), read('postTraining')]);
      return sessions.length + training.length;
    },
  },
  {
    id: 'vitalist',
    label: 'Vitalist',
    domain: 'health',
    // Health logs are near-daily and cheap to record, so the curve is stretched
    // to keep a single week of logging from vaulting to level 3.
    scale: 5,
    compute: async (read) => (await read('loggingStats')).totalLogged,
  },
  {
    id: 'strategist',
    label: 'Strategist',
    domain: 'goals',
    scale: 3,
    // Goal *discipline*, not goal count: check-ins plus recorded progress steps.
    // Filing ten goals and never revisiting them is not strategy.
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
    // Memories accrue fastest of any domain (a single Brain capture can mint
    // several), so this needs the flattest curve of the six.
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
 * Resolve one skill to its response shape. The two failure-ish paths are kept
 * distinct on purpose (see the sentinel+validate note in the module header):
 *   - `compute` rejects           → unavailable (the domain could not be read)
 *   - `compute` resolves non-finite → unavailable (the domain lied; a fake 0 here
 *     would silently read as "no activity")
 *   - `compute` resolves 0        → a real, earned level 0
 */
async function readSkill(skill, read) {
  // `Promise.resolve().then(...)` rather than `skill.compute(read).catch(...)`: a compute
  // declared without `async` that throws synchronously would otherwise escape before `.catch`
  // is attached, rejecting the whole GET instead of degrading this one skill.
  const raw = await Promise.resolve().then(() => skill.compute(read)).catch((err) => {
    // `err?.message ?? err` — a non-Error rejection (a thrown string, a rejected `undefined`)
    // would otherwise throw *inside* the catch and defeat the per-skill containment below.
    console.warn(`⚠️ Character skill ${skill.id}: stat read failed — ${err?.message ?? err}`);
    return STAT_UNAVAILABLE;
  });

  const base = { id: skill.id, label: skill.label, domain: skill.domain };

  if (raw === STAT_UNAVAILABLE || !Number.isFinite(raw) || raw < 0) {
    if (raw !== STAT_UNAVAILABLE) {
      console.warn(`⚠️ Character skill ${skill.id}: stat returned a non-countable value`);
    }
    // level/value stay null — NOT 0 — so no consumer can render an unread domain
    // as a legitimately empty one.
    return { ...base, level: null, value: null, unavailable: true };
  }

  return { ...base, level: levelFromValue(raw, skill.scale), value: raw, unavailable: false };
}

/**
 * Compute every skill. Domains are read in parallel and each failure is contained
 * to its own skill, so one unreachable domain (e.g. Postgres down for the catalog
 * or memory reads) degrades that entry to `unavailable` instead of failing the
 * whole `GET /api/character`.
 *
 * `read` is the shared signal context. Callers deriving MORE than skills from the same
 * request (`getCharacter()` also derives the metrics grid) must mint ONE context and pass it
 * to both, or the signals the two registries share get read twice. Defaults to a private
 * context so a skills-only caller stays a one-liner.
 */
export async function getCharacterSkills(read = createSignalContext()) {
  return Promise.all(SKILLS.map((skill) => readSkill(skill, read)));
}
