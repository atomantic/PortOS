// Resolves a series's canon (characters, settings, objects) from the linked
// universe — Phase B of the Universe-as-canon refactor. Before B, each series
// owned its own bible arrays; now canon lives on the universe so multiple
// series can share a cast. The series's own arrays stay populated as a
// fallback for series with no universe link AND for orphan series that
// haven't migrated yet.

import { getUniverse } from '../universeBuilder.js';

/**
 * Read a series's effective canon. Prefers the linked universe; falls back to
 * the series's own arrays when the universe is unset, missing, or empty.
 *
 * The dual-path read makes the migration non-blocking: render paths produce
 * correct results before AND after the one-shot copy in `migrateSeriesCanon`.
 * Once every series's canon lives on its universe, the fallback becomes dead
 * weight and the series.{characters,settings,objects} fields can be dropped
 * from the schema (Phase B.2).
 *
 * @returns {Promise<{ characters, settings, objects, source: 'universe' | 'series' }>}
 */
export async function getSeriesCanon(series) {
  const empty = { characters: [], settings: [], objects: [] };
  if (!series || typeof series !== 'object') return { ...empty, source: 'series' };

  if (series.universeId) {
    const universe = await getUniverse(series.universeId).catch(() => null);
    if (universe) {
      const resolved = pickAllOrNothing(universe, series);
      if (resolved) return resolved;
    }
  }
  return {
    characters: Array.isArray(series.characters) ? series.characters : [],
    settings: Array.isArray(series.settings) ? series.settings : [],
    objects: Array.isArray(series.objects) ? series.objects : [],
    source: 'series',
  };
}

// All-or-nothing: only treat the universe as the source when it has all
// three kinds populated. A half-migrated universe (only characters
// extracted, settings still on series) would otherwise silently mix
// stores — readers can't tell they're getting hybrid canon, and the user
// thinks they've fully migrated. Returning null here forces pure-series
// fallback, which keeps the migration state explicit: either the universe
// is complete or it isn't.
function pickAllOrNothing(universe, series) {
  const characters = Array.isArray(universe.characters) ? universe.characters : [];
  const settings = Array.isArray(universe.settings) ? universe.settings : [];
  const objects = Array.isArray(universe.objects) ? universe.objects : [];
  // If the series never populated a kind to begin with (empty on both
  // sides), don't require it from the universe either.
  const seriesC = Array.isArray(series?.characters) ? series.characters : [];
  const seriesS = Array.isArray(series?.settings) ? series.settings : [];
  const seriesO = Array.isArray(series?.objects) ? series.objects : [];
  const wantsCharacters = seriesC.length > 0;
  const wantsSettings = seriesS.length > 0;
  const wantsObjects = seriesO.length > 0;
  const universeCovers =
    (!wantsCharacters || characters.length > 0)
    && (!wantsSettings || settings.length > 0)
    && (!wantsObjects || objects.length > 0)
    && (characters.length + settings.length + objects.length > 0);
  if (!universeCovers) return null;
  return { characters, settings, objects, source: 'universe' };
}

/**
 * Synchronous variant for hot render paths that already have the universe
 * record in hand (e.g. visualStages.js loads it via getUniverse anyway).
 * Mirrors the per-kind fallback logic in `getSeriesCanon`.
 */
export function resolveSeriesCanonSync(series, universe) {
  if (universe) {
    const resolved = pickAllOrNothing(universe, series);
    if (resolved) return resolved;
  }
  return {
    characters: Array.isArray(series?.characters) ? series.characters : [],
    settings: Array.isArray(series?.settings) ? series.settings : [],
    objects: Array.isArray(series?.objects) ? series.objects : [],
    source: 'series',
  };
}
