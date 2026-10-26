import { getUniverse } from './apiUniverseBuilder';
import { getCatalogIngredientCards } from './apiCatalog';

// Resolve by stable identity only. A retained shared original is immutable
// context; only ordinary local aliases may supply the canonical edit target.
export async function getCanonCatalogContext(universeId, ingredientId, kind, options) {
  const universe = await getUniverse(universeId, options);
  if (!universe || typeof universe !== 'object' || !universe.id) throw new Error('The owning universe context is unavailable.');
  const field = { character: 'characters', place: 'places', object: 'objects' }[kind];
  const entries = universe?.[field] || [];
  let matches = entries.filter(entry => entry.ingredientId === ingredientId);
  if (entries.some(entry => entry.ingredientId && entry.ingredientId !== ingredientId)) {
    const cards = await getCatalogIngredientCards(entries.map(entry => entry.ingredientId), options);
    const aliases = new Set(cards.filter(card => card.canonicalId === ingredientId && card.sharedIdentity?.writable !== false).map(card => card.id));
    matches = entries.filter(entry => entry.ingredientId === ingredientId || aliases.has(entry.ingredientId));
  }
  if (matches.length > 1) throw new Error('Multiple canon entries resolve to this identity. Review them in the universe before using creative actions.');
  return { universe, entry: matches[0] || null };
}
