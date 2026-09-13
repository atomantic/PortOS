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

const normalizeReferenceText = (value) => String(value || '').normalize('NFKC').toLocaleLowerCase();

const referencedByName = (entry, referenceText) => {
  const name = normalizeReferenceText(entry?.name || entry?.slugline);
  return name.length >= 2 && referenceText.includes(name);
};

const seriesPlanningText = (series, universe, issues) => normalizeReferenceText(JSON.stringify({
  protectedWorldIntent: {
    starterPrompt: universe?.starterPrompt || '',
    logline: universe?.logline || '',
    premise: universe?.premise || '',
  },
  series: {
    name: series?.name || '',
    logline: series?.logline || '',
    premise: series?.premise || '',
    arc: series?.arc || null,
    seasons: series?.seasons || [],
    characterArcs: series?.characterArcs || [],
  },
  // Current issue plans can introduce supporting cast absent from the macro
  // summaries. Old prose, beat outputs and sibling-series issues are not roots.
  issuePlans: issues.filter((issue) => series?.id && issue?.seriesId === series.id)
    .map((issue) => ({ title: issue.title, synopsis: issue.stages?.idea?.input || '' })),
}));

/**
 * Scope a shared universe's canon to entities that demonstrably belong to one
 * series' current planning contract. Universe Builder worlds can retain canon
 * from abandoned drafts and from sibling series; injecting every old named
 * entity into a new arc prompt makes those records look equally authoritative
 * and can resurrect an incompatible plot.
 *
 * Stable character-arc ids/names and explicit mentions in protected world,
 * series fields, or current issue plans are the roots. Selected records then
 * provide one bounded relationship hop to supporting characters, places, and
 * objects. Nothing is deleted from the universe or catalog — this only narrows
 * generative prompt context. An empty result is intentional: protected premise
 * text is safer than guessing that unrelated legacy canon belongs to the story.
 */
export function scopeCanonForSeries(universe, series, issues = []) {
  const canon = pickCanon(universe);
  let referenceText = seriesPlanningText(series, universe, issues);
  const arcCharacterIds = new Set((series?.characterArcs || [])
    .map((arc) => arc?.characterId)
    .filter(Boolean));
  const arcCharacterNames = new Set((series?.characterArcs || [])
    .map((arc) => normalizeReferenceText(arc?.characterName))
    .filter(Boolean));

  const characters = canon.characters.filter((character) => (
    arcCharacterIds.has(character?.id)
    || arcCharacterNames.has(normalizeReferenceText(character?.name))
    || referencedByName(character, referenceText)
  ));

  // One relationship hop admits supporting nouns the active principals name,
  // while avoiding an unbounded graph walk through old draft relationships.
  referenceText += `\n${normalizeReferenceText(JSON.stringify(characters))}`;
  const supportingCharacters = canon.characters.filter((character) => (
    !characters.includes(character) && referencedByName(character, referenceText)
  ));
  const scopedCharacters = [...characters, ...supportingCharacters];
  referenceText += `\n${normalizeReferenceText(JSON.stringify(supportingCharacters))}`;

  return {
    characters: scopedCharacters,
    places: canon.places.filter((place) => referencedByName(place, referenceText)),
    objects: canon.objects.filter((object) => referencedByName(object, referenceText)),
  };
}

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
 * extraction, and scene planning** intentionally consume the full canon (they
 * need the truth and have no single issue number). Arc/episode planning uses
 * `getSeriesPlanningCanon` below so abandoned sibling-draft entities do not
 * compete with the active series contract. New prompt-builders that load canon
 * here for a drafting prompt MUST apply the filter; see
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

/** Series-scoped canon, including current issue plans; accepts an already-read world. */
export async function getSeriesPlanningCanon(series, preloadedUniverse) {
  if (!series?.universeId) return EMPTY;
  const universe = preloadedUniverse || await getUniverse(series.universeId).catch(() => null);
  if (!universe) return EMPTY;
  // Keep issue-store imports out of the widely used full-canon reader's graph.
  const { listIssues } = await import('./issues.js');
  const issues = series.id ? await listIssues({ seriesId: series.id }) : [];
  return scopeCanonForSeries(universe, series, issues);
}
