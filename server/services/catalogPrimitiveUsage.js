import { query } from '../lib/db.js';
import { ServerError } from '../lib/errorHandler.js';
import { getIngredientIdentityIds } from './catalogDB/ingredients.js';
import { matchCharactersInText, matchPlacesInText, matchObjectsInText } from '../lib/scenePrompt.js';

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
  if (rows[0]?.blocked) throw new ServerError('Before deleting this universe, remove its primitives from their containers and delete them from Catalog. Reassign or delete its FableLoom stories and Voice Studio profiles first.',
    { status: 409, code: 'UNIVERSE_PRIMITIVES_IN_USE' });
}

// Only the selected identity's small name/alias projection crosses this read
// boundary. Queries are batched by universe; canon cardinality adds no SQL.
export async function listPrimitiveUsages(ingredientId, refs) {
  const universeIds = [...new Set(refs.filter((ref) => ref.refKind === 'universe' && ref.resolved !== false).map((ref) => ref.refId))];
  if (!universeIds.length) return [];
  const identityIds = await getIngredientIdentityIds(ingredientId);
  const { rows: universes } = await query(`SELECT u.id, jsonb_agg(jsonb_build_object(
      'id', entry->>'id', 'name', entry->>'name', 'aliases', COALESCE(entry->'aliases', '[]'::jsonb), 'kind', kinds.kind)) AS entries
    FROM universes u
    CROSS JOIN LATERAL (VALUES ('character', 'characters'), ('place', 'places'), ('object', 'objects')) kinds(kind, field)
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(NULLIF(u.data->kinds.field, 'null'::jsonb), '[]'::jsonb)) entry
    WHERE u.id = ANY($1) AND u.deleted = false AND entry->>'ingredientId' = ANY($2) AND NULLIF(entry->>'id', '') IS NOT NULL
    GROUP BY u.id`, [universeIds, identityIds]);
  if (!universes.length) return [];
  const scope = universes.map((universe) => universe.id);
  const canonIds = universes.flatMap((universe) => universe.entries.map((entry) => entry.id));
  const [stories, voices, issues] = await Promise.all([
    query(`SELECT id, name, universe_id,
      jsonb_path_query_array(data, '$.**.characterId') || jsonb_path_query_array(data, '$.**.protagonistCharacterId')
      || jsonb_path_query_array(data, '$.**.placeId') || jsonb_path_query_array(data, '$.**.objectId')
      || jsonb_path_query_array(data, '$.**.canonId') || jsonb_path_query_array(data, '$.**.objectIds[*]') AS canon_ids
      FROM fableloom_stories WHERE universe_id = ANY($1) AND deleted = false`, [scope]),
    query(`SELECT id, data->>'name' AS name, universe_id, character_id, approval_status FROM voice_profiles
      WHERE universe_id = ANY($1) AND character_id = ANY($2) AND approval_status <> 'retired'`, [scope, canonIds]),
    query(`SELECT i.id, i.series_id, s.name AS series_name, s.universe_id,
      COALESCE(NULLIF(i.data->>'title', ''), 'Issue ' || COALESCE(i.number::text, i.id)) AS name,
      concat_ws(E'\n\n', i.data#>>'{stages,prose,output}', i.data#>>'{stages,prose,input}',
        i.data#>>'{stages,idea,output}', i.data#>>'{stages,idea,input}',
        i.data#>>'{stages,comicScript,output}', i.data#>>'{stages,teleplay,output}') AS corpus
      FROM pipeline_series s JOIN pipeline_issues i ON i.series_id = s.id AND i.deleted = false
      WHERE s.universe_id = ANY($1) AND s.deleted = false`, [scope]),
  ]);
  const byUniverse = new Map(universes.map((universe) => [universe.id, universe.entries]));
  const uses = [];
  for (const story of stories.rows) {
    if ((byUniverse.get(story.universe_id) || []).some((entry) => story.canon_ids.includes(entry.id)))
      uses.push({ refKind: 'fableloom', refId: story.id, refName: story.name || story.id, role: 'canon', resolved: true, derived: true });
  }
  for (const voice of voices.rows) {
    if ((byUniverse.get(voice.universe_id) || []).some((entry) => entry.kind === 'character' && entry.id === voice.character_id))
      uses.push({ refKind: 'voice-profile', refId: voice.id, refName: voice.name || 'Voice profile', role: `${voice.approval_status} voice`, resolved: true, derived: true });
  }
  const matchers = { character: matchCharactersInText, place: matchPlacesInText, object: matchObjectsInText };
  for (const issue of issues.rows) {
    const entries = byUniverse.get(issue.universe_id) || [];
    if (!Object.entries(matchers).some(([kind, match]) => match(issue.corpus, entries.filter((entry) => entry.kind === kind)).length)) continue;
    uses.push({ refKind: 'series', refId: issue.series_id, refName: issue.series_name || issue.series_id, role: 'prose-mention', resolved: true, derived: true });
    uses.push({ refKind: 'issue', refId: issue.id, refName: issue.name || issue.id, role: 'prose-mention', resolved: true, derived: true });
  }
  return [...new Map(uses.map((use) => [`${use.refKind}:${use.refId}:${use.role}`, use])).values()];
}
