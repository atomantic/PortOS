// Cross-reference where each canon entry on a universe appears across the
// series + issues that link to that universe. Pure aggregation over existing
// stores — no new writes, no LLM calls. Match is by prose text scanning,
// same pattern the comic-page renderer uses to decide which characters to
// cite in the diffusion prompt.

import { getUniverse, ERR_NOT_FOUND } from './universeBuilder.js';
import { listSeries } from './pipeline/series.js';
import { listIssues } from './pipeline/issues.js';
import {
  matchCharactersInText, matchPlacesInText, matchObjectsInText,
} from '../lib/scenePrompt.js';
import { ServerError } from '../lib/errorHandler.js';

const MATCHERS = Object.freeze({
  characters: matchCharactersInText,
  places: matchPlacesInText,
  objects: matchObjectsInText,
});

// Collect the searchable prose for an issue. Prose stage is the canonical
// source the canon matchers were tuned against; idea + scripts are included
// so a character that only ever appears in dialogue (no prose) still
// surfaces in the cross-reference.
function corpusForIssue(issue) {
  const stages = issue.stages || {};
  const parts = [
    stages.prose?.output,
    stages.prose?.input,
    stages.idea?.output,
    stages.idea?.input,
    stages.comicScript?.output,
    stages.teleplay?.output,
  ];
  return parts.filter(Boolean).join('\n\n');
}

/**
 * Thin variant of getUniverseCanonUsage that only returns the linked-series
 * id/name pairs — no per-issue prose scan, no canon matchers. Callers that
 * just need the seriesId → seriesName lookup (e.g. NounsStage's "from
 * <series>" canon-card chip) should prefer this; the full cross-reference
 * endpoint is O(series × issues × matchers).
 */
export async function listLinkedSeriesNames(universeId) {
  // Validate the universe exists so 404s line up with the heavier endpoint.
  // Only translate the explicit not-found condition to 404; let I/O / parse
  // errors bubble so they don't masquerade as "not found".
  await getUniverse(universeId).catch((err) => {
    if (err?.code === ERR_NOT_FOUND) {
      throw new ServerError('Universe not found', { status: 404, code: 'UNIVERSE_NOT_FOUND' });
    }
    throw err;
  });
  const allSeries = await listSeries();
  return allSeries
    .filter((s) => s.universeId === universeId)
    .map((s) => ({ id: s.id, name: s.name }));
}

/**
 * Return per-canon-entry usage across the universe's series.
 *
 * Shape:
 * {
 *   characters: { [entryId]: [{ seriesId, seriesName, issueIds, issueCount }, ...] },
 *   places:     { [entryId]: [...] },
 *   objects:    { [entryId]: [...] },
 *   seriesNameMap: { [seriesId]: seriesName }, // every linked series, even ones with no prose match
 *   seriesCount,         // how many series link to this universe
 *   issueCount,          // total issues scanned
 * }
 */
export async function getUniverseCanonUsage(universeId) {
  const universe = await getUniverse(universeId).catch((err) => {
    throw new ServerError(err.message || 'Universe not found', { status: 404, code: 'UNIVERSE_NOT_FOUND' });
  });

  const allSeries = await listSeries();
  const linkedSeries = allSeries.filter((s) => s.universeId === universeId);
  // Cover entries whose `sourceSeriesId` points at a linked series that has no
  // prose-match — the per-entry rows would otherwise miss that series, but the
  // chip-label lookup on the client still needs its name.
  const seriesNameMap = Object.fromEntries(linkedSeries.map((s) => [s.id, s.name]));

  // Per (kind, entryId) → Map(seriesId → { seriesName, issueIds: Set })
  const tally = { characters: new Map(), places: new Map(), objects: new Map() };

  let issueCount = 0;
  for (const series of linkedSeries) {
    const issues = await listIssues({ seriesId: series.id });
    issueCount += issues.length;
    for (const issue of issues) {
      const corpus = corpusForIssue(issue);
      if (!corpus.trim()) continue;
      for (const kind of Object.keys(MATCHERS)) {
        const canon = Array.isArray(universe[kind]) ? universe[kind] : [];
        if (canon.length === 0) continue;
        const matched = MATCHERS[kind](corpus, canon);
        for (const entry of matched) {
          const id = entry.id || entry.name;
          if (!id) continue;
          let perSeries = tally[kind].get(id);
          if (!perSeries) {
            perSeries = new Map();
            tally[kind].set(id, perSeries);
          }
          let bucket = perSeries.get(series.id);
          if (!bucket) {
            bucket = { seriesName: series.name, issueIds: new Set() };
            perSeries.set(series.id, bucket);
          }
          bucket.issueIds.add(issue.id);
        }
      }
    }
  }

  const shape = (perKind) => {
    const out = {};
    for (const [entryId, perSeries] of perKind.entries()) {
      out[entryId] = [...perSeries.entries()]
        .map(([seriesId, { seriesName, issueIds }]) => ({
          seriesId,
          seriesName,
          issueIds: [...issueIds],
          issueCount: issueIds.size,
        }))
        .sort((a, b) => b.issueCount - a.issueCount || (a.seriesName || '').localeCompare(b.seriesName || ''));
    }
    return out;
  };

  return {
    characters: shape(tally.characters),
    places: shape(tally.places),
    objects: shape(tally.objects),
    seriesNameMap,
    seriesCount: linkedSeries.length,
    issueCount,
  };
}
