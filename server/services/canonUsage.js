// Cross-reference where each canon entry on a universe appears across the
// series + issues that link to that universe. Pure aggregation over existing
// stores — no new writes, no LLM calls. Match is by prose text scanning,
// same pattern the comic-page renderer uses to decide which characters to
// cite in the diffusion prompt.

import { getUniverse } from './universeBuilder.js';
import { listSeries } from './pipeline/series.js';
import { listIssues } from './pipeline/issues.js';
import {
  matchCharactersInText, matchSettingsInText, matchObjectsInText,
} from '../lib/scenePrompt.js';
import { ServerError } from '../lib/errorHandler.js';

const MATCHERS = Object.freeze({
  characters: matchCharactersInText,
  settings: matchSettingsInText,
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
 * Return per-canon-entry usage across the universe's series.
 *
 * Shape:
 * {
 *   characters: { [entryId]: [{ seriesId, seriesName, issueIds, issueCount }, ...] },
 *   settings:   { [entryId]: [...] },
 *   objects:    { [entryId]: [...] },
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

  // Per (kind, entryId) → Map(seriesId → { seriesName, issueIds: Set })
  const tally = { characters: new Map(), settings: new Map(), objects: new Map() };

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
      out[entryId] = [...perSeries.entries()].map(([seriesId, { seriesName, issueIds }]) => ({
        seriesId,
        seriesName,
        issueIds: [...issueIds],
        issueCount: issueIds.size,
      }));
    }
    return out;
  };

  return {
    characters: shape(tally.characters),
    settings: shape(tally.settings),
    objects: shape(tally.objects),
    seriesCount: linkedSeries.length,
    issueCount,
  };
}
