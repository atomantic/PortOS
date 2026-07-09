// Resolves a series's effective canon (characters, places, objects) by
// reading the linked universe. Series no longer carries canon arrays of its
// own (Phase B.4) — every active series is universe-linked, so this is just
// a thin async lookup that returns empty arrays when the series has no
// `universeId` set.

import { getUniverse } from '../universeBuilder.js';

// Frozen inner arrays too — otherwise a careless `canon.characters.push(...)`
// at a caller would silently pollute every future orphan-series read.
const EMPTY = Object.freeze({
  characters: Object.freeze([]),
  places: Object.freeze([]),
  objects: Object.freeze([]),
});

/**
 * Shape a universe record into `{ characters, places, objects }` arrays,
 * tolerating missing/non-array fields. Exposed so callers that already have
 * a universe in scope (e.g. `visualStages.loadBibleContext`) can avoid the
 * round-trip through `getSeriesCanon`.
 */
export const pickCanon = (universe) => ({
  characters: Array.isArray(universe?.characters) ? universe.characters : [],
  places: Array.isArray(universe?.places) ? universe.places : [],
  objects: Array.isArray(universe?.objects) ? universe.objects : [],
});

/**
 * Async canon read for text/arc-planning stages that don't already have the
 * universe record in scope. Returns frozen-empty when the series is orphan
 * (no universeId) or the linked universe is missing.
 *
 * Returns the FULL canon — this reader does NOT reveal-gate (#2178). The
 * reveal-gating contract is: a **writer-facing generative prompt** (prose /
 * script drafting, alternate-POV rewrite) must run the result through
 * `filterCanonForIssue` / `filterCanonListForIssue` from
 * `server/lib/storyBible.js` before injecting it, so a later-reveal secret
 * can't leak into an earlier issue. The **judge, editorial checks, canon
 * extraction, arc/scene planning** intentionally consume the full canon (they
 * need the truth and have no single issue number). New prompt-builders that
 * load canon here for a drafting prompt MUST apply the filter; see
 * `textStages.buildStageContext` and `perspectiveRewrite.resolveCast` for the
 * reference call sites.
 *
 * @returns {Promise<{ characters, places, objects }>}
 */
export async function getSeriesCanon(series) {
  if (!series?.universeId) return EMPTY;
  const universe = await getUniverse(series.universeId).catch(() => null);
  if (!universe) return EMPTY;
  return pickCanon(universe);
}
