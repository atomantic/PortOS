// Resolve explicit Catalog ownership and collect linked universe canon IDs.

import { BIBLE_KEYS } from '../storyBible.js';

// Ownership is explicit; legacy consumption links are evidence for review,
// never a reason to select an arbitrary style context.
//
// Explicit catalog owning-universe role and visible legacy/missing/conflicting ownership
// classification, independent of usage.
export const CATALOG_OWNER_ROLE = 'owner';

export function catalogUniverseContext(refs = []) {
  const universes = refs.filter((ref) => ref.refKind === 'universe' && !ref.deleted);
  const owners = [...new Map(universes.filter((ref) => ref.role === CATALOG_OWNER_ROLE)
    .map((ref) => [ref.refId, ref])).values()];
  const candidates = [...new Map(universes.map((ref) => [ref.refId, ref])).values()];
  const owner = owners.length === 1 && owners[0].resolved !== false ? owners[0] : null;
  return { status: owner ? 'owned' : owners.length > 1 ? 'conflict' : owners.length ? 'missing-owner' : 'needs-review',
    owner, candidates, owners };
}

// Take this snapshot inside the universe mutator. Reverse projection walks
// every canon bucket, including entries the Catalog-originated write leaves alone.
export function collectUniverseCanonIngredientIds(universe) {
  const ids = new Set();
  for (const field of BIBLE_KEYS) {
    const entries = universe[field];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) if (entry?.ingredientId) ids.add(entry.ingredientId);
  }
  return [...ids];
}
