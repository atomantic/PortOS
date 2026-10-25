// Ownership is explicit; legacy consumption links are evidence for review,
// never a reason to select an arbitrary style context.
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
