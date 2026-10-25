import { query } from '../lib/db.js';
import { ServerError } from '../lib/errorHandler.js';
import { getIngredientIdentityIds } from './catalogDB/ingredients.js';

// Exact identity pointers only. Prose matches are reported separately as
// inferred mentions and never establish ownership or consolidate identity.
const mentionsCanon = (value, entryId) => {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => (
    (['characterId', 'protagonistCharacterId', 'placeId', 'objectId', 'canonId'].includes(key) && item === entryId)
    || (key === 'objectIds' && Array.isArray(item) && item.includes(entryId))
  ) || (typeof item === 'object' && mentionsCanon(item, entryId)));
};

async function findCanonDependencies(universeId, kind, entryId) {
  const { rows: stories } = await query('SELECT id, name, data FROM fableloom_stories WHERE universe_id = $1 AND deleted = false', [universeId]);
  const uses = stories.filter((story) => mentionsCanon(story.data, entryId)).map((story) => ({
    refKind: 'fableloom', refId: story.id, refName: story.name, role: 'canon', resolved: true, derived: true,
  }));
  if (kind === 'character') {
    const { rows: voices } = await query(`SELECT id, data->>'name' AS name, approval_status FROM voice_profiles
      WHERE universe_id = $1 AND character_id = $2 AND approval_status <> 'retired'`, [universeId, entryId]);
    uses.push(...voices.map((voice) => ({ refKind: 'voice-profile', refId: voice.id, refName: voice.name || 'Voice profile',
      role: `${voice.approval_status} voice`, resolved: true, derived: true })));
  }
  return uses;
}

export async function assertCanonRemovable(universeId, kind, entryId) {
  const uses = await findCanonDependencies(universeId, kind, entryId);
  if (uses.length) throw new ServerError('Remove or reassign this canon entry in its FableLoom stories and Voice Studio profiles before removing it from the universe.',
    { status: 409, code: 'UNIVERSE_CANON_IN_USE' });
}

export async function assertUniversePrimitivesRemovable(universeId) {
  const { rows } = await query(`SELECT
    EXISTS(SELECT 1 FROM catalog_identity_read_refs r JOIN catalog_ingredients i ON i.id = catalog_canonical_ingredient_id(r.ingredient_id)
      WHERE r.ref_kind = 'universe' AND r.ref_id = $1 AND r.role = 'owner' AND r.deleted = false AND i.deleted = false)
    OR EXISTS(SELECT 1 FROM fableloom_stories WHERE universe_id = $1 AND deleted = false)
    OR EXISTS(SELECT 1 FROM voice_profiles WHERE universe_id = $1 AND approval_status <> 'retired') AS blocked`, [universeId]);
  if (rows[0]?.blocked) throw new ServerError('This universe owns creative primitives or has FableLoom/voice bindings. Archive or reassign those records before deleting it.',
    { status: 409, code: 'UNIVERSE_PRIMITIVES_IN_USE' });
}

export async function listPrimitiveUsages(ingredientId, refs) {
  const universeIds = [...new Set(refs.filter((ref) => ref.refKind === 'universe' && ref.resolved !== false).map((ref) => ref.refId))];
  if (!universeIds.length) return [];
  const identityIds = new Set(await getIngredientIdentityIds(ingredientId));
  const { rows } = await query('SELECT id, data FROM universes WHERE id = ANY($1) AND deleted = false', [universeIds]);
  const uses = [];
  for (const universe of rows) {
    const entries = ['characters', 'places', 'objects'].flatMap((field) => (universe.data?.[field] || [])
      .filter((entry) => identityIds.has(entry?.ingredientId)).map((entry) => ({ ...entry, field })));
    if (!entries.length) continue;
    const { getUniverseCanonUsage } = await import('./canonUsage.js');
    const mentions = await getUniverseCanonUsage(universe.id);
    for (const entry of entries) {
      const kind = { characters: 'character', places: 'place', objects: 'object' }[entry.field];
      uses.push(...await findCanonDependencies(universe.id, kind, entry.id));
      for (const series of mentions[entry.field]?.[entry.id] || []) {
        uses.push({ refKind: 'series', refId: series.seriesId, refName: series.seriesName, role: 'prose-mention', resolved: true, derived: true });
        uses.push(...series.issueIds.map((id) => ({ refKind: 'issue', refId: id, role: 'prose-mention', derived: true })));
      }
    }
  }
  return [...new Map(uses.map((use) => [`${use.refKind}:${use.refId}:${use.role}`, use])).values()];
}
