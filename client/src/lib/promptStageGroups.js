/**
 * Prompt-stage search + grouping for the Prompt Manager's Stages pane (#3284).
 *
 * The stage list is 120+ entries deep and the taxonomy is already encoded in the
 * display names — `Pipeline — Prose Draft`, `Writers Room — Live Continuation`,
 * `CoS Agent Briefing`. These helpers turn that convention into navigable
 * structure: an AND-token filter over title + description + key, then ordered
 * groups keyed on the name's prefix.
 *
 * Token semantics are shared with the media browser (`mediaSearch.js`) rather
 * than re-rolled — same "every whitespace term must match somewhere" contract
 * users already learned there.
 *
 * Pure — no React, no I/O. The page owns the disclosure state and icons.
 */

import { tokenizeQuery, matchHaystack } from './mediaSearch.js';

// Bucket for names that carry neither a dash prefix nor a known leading word.
export const OTHER_GROUP_LABEL = 'Other';

// Most names encode their family as `<Family> — <specific>`. The shipped catalog
// uses an em dash, but a user naming their own stage in the Create Stage modal
// will reach for a plain hyphen, so accept all three. A spaced separator is
// required — `Twin Spoken-vs-Written Comparison` must not split.
const DASH_PREFIX_RE = /^(.+?)\s[—–-]\s/;

// Families whose names predate the dash convention (`CoS Agent Briefing`,
// `Brain Classifier`). Matched as a leading WORD run so `Model Personality`
// wins over a hypothetical `Model` — longest-first ordering is what makes that
// deterministic, so keep multi-word entries above their prefixes.
export const STAGE_WORD_PREFIXES = [
  'Model Personality',
  'App Detection',
  'Brain',
  'CoS',
  'Memory',
  'Soul',
  'Twin',
];

// Lowercased once at module load — the match below runs per stage per keystroke.
const LOWERED_WORD_PREFIXES = STAGE_WORD_PREFIXES.map((prefix) => [prefix, prefix.toLowerCase()]);

/**
 * The group a stage belongs to, derived from its display name (falling back to
 * its key when a stage has no name). Hyphens normalize to spaces first so a
 * name-less `cos-evaluate` still lands under CoS rather than in Other.
 */
export function stageGroupLabel(displayName) {
  const name = String(displayName || '').trim();
  if (!name) return OTHER_GROUP_LABEL;

  const dashed = DASH_PREFIX_RE.exec(name);
  if (dashed) {
    const prefix = dashed[1].trim();
    if (prefix) return prefix;
  }

  const normalized = name.replace(/-/g, ' ').toLowerCase();
  for (const [prefix, needle] of LOWERED_WORD_PREFIXES) {
    if (normalized === needle || normalized.startsWith(`${needle} `)) return prefix;
  }
  return OTHER_GROUP_LABEL;
}

/**
 * The group for a `[key, config]` pair — the display name when it has one,
 * else the key. The single definition of that fallback: the page's
 * auto-expand and this module's bucketing must agree, or a deep-linked stage
 * opens the wrong group.
 */
export function stageGroupLabelFor(key, config) {
  return stageGroupLabel(config?.name || key);
}

/**
 * The identity a group is bucketed and remembered under. Case-folded because
 * headers render uppercase: `Pipeline — X` and `pipeline — y` are one group to
 * the eye, and letting them be two produces twin `PIPELINE` headers with the
 * user's stage in whichever one they didn't open. The first spelling seen wins
 * as the *display* label; this key is what open/closed state is stored under.
 */
export function stageGroupKey(label) {
  return String(label || '').toLowerCase();
}

export function stageGroupKeyFor(key, config) {
  return stageGroupKey(stageGroupLabelFor(key, config));
}

/**
 * The lowercased searchable string for one stage. Title and description are
 * what the issue asks for; the raw key rides along so a user who knows the
 * stage id (`brain-daily-digest`) can type it directly.
 */
export function stageHaystack(key, config) {
  return `${config?.name || ''} ${config?.description || ''} ${key || ''}`.toLowerCase();
}

/**
 * Filter + group the stage map for the Stages pane.
 *
 * `stages` is the `{ key: config }` map the prompts API returns. Returns
 * `{ groups, matchCount, totalCount }` where each group is
 * `{ key, label, stages: [[key, config], …] }` — `key` is the case-folded
 * identity to store open/closed state under, `label` the first spelling seen.
 * Groups sort alphabetically with `Other` pinned last, stages by display name.
 *
 * `systemStageKeys` is the `systemStages` list `GET /api/prompts` ships — the
 * server's own CURATED table (`server/lib/promptSystemStages.js`), not a client
 * mirror, so the "System only" filter can never disagree with what the server
 * badges (#3314). Deletion protection is deliberately WIDER than this list
 * (every stage `server/` names by literal key, #3335) — the filter intentionally
 * does not surface that set, since ~100 of 127 rows would match.
 *
 * An empty query and `systemOnly: false` return everything, so the same call
 * drives both the unfiltered and the filtered render.
 */
export function buildStageGroups(stages, { query = '', systemOnly = false, systemStageKeys = [] } = {}) {
  const entries = Object.entries(stages || {});
  const tokens = tokenizeQuery(query);
  const systemSet = new Set(systemStageKeys);

  const matched = entries.filter(([key, config]) => {
    if (systemOnly && !systemSet.has(key)) return false;
    if (tokens.length === 0) return true;
    return matchHaystack(stageHaystack(key, config), tokens);
  });

  const byKey = new Map();
  for (const entry of matched) {
    const label = stageGroupLabelFor(entry[0], entry[1]);
    const key = stageGroupKey(label);
    const group = byKey.get(key);
    if (group) group.stages.push(entry);
    else byKey.set(key, { key, label, stages: [entry] });
  }

  // `Other` sorts last; everything else alphabetically. Ranking rather than
  // branching so a second pinned bucket is one table entry, not a rewrite.
  const otherKey = stageGroupKey(OTHER_GROUP_LABEL);
  const rank = (group) => (group.key === otherKey ? 1 : 0);
  const groups = [...byKey.values()]
    .map((group) => ({
      ...group,
      stages: group.stages.sort(([aKey, a], [bKey, b]) =>
        String(a?.name || aKey).localeCompare(String(b?.name || bKey))),
    }))
    .sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));

  return { groups, matchCount: matched.length, totalCount: entries.length };
}
