import { createHash } from 'node:crypto';
import { canonicalStringify } from '../../lib/objects.js';
import { ServerError } from '../../lib/errorHandler.js';
import { listSheetPointers } from '../../lib/sheetPointers.js';
import { sanitizeBiblePayload } from '../catalogDB/shared.js';

export const TABLES = Object.freeze({
  ingredients: ['catalog_ingredients', 'id = ANY($1)'],
  sources: ['catalog_ingredient_sources', 'ingredient_id = ANY($1)'],
  refs: ['catalog_ingredient_refs', 'ingredient_id = ANY($1)'],
  media: ['catalog_ingredient_media', 'ingredient_id = ANY($1)'],
  relations: ['catalog_ingredient_relations', 'from_id = ANY($1) OR to_id = ANY($1)'],
  revisions: ['catalog_ingredient_revisions', 'ingredient_id = ANY($1)'],
});
export const fail = (message, code = 'CATALOG_IDENTITY_CONFLICT', status = 409) => {
  throw new ServerError(message, { code, status });
};
export function bounded(value, maxBytes, label) {
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) fail(`${label} exceeds the supported bilateral evidence size; no reservation was made`);
  return value;
}
export const hash = value => createHash('sha256').update(canonicalStringify(value)).digest('hex');
export async function snapshot(client, ids) {
  const value = {};
  for (const [key, [table, where]] of Object.entries(TABLES)) {
    const { rows } = await client.query(`SELECT * FROM ${table} WHERE ${where}`, [ids]);
    value[key] = JSON.parse(JSON.stringify(rows)).map(row => Object.fromEntries(Object.entries(row)
      .filter(([column]) => !['sync_sequence', 'search_tsv', 'embedding', 'embedding_model'].includes(column))))
      .sort((a, b) => canonicalStringify(a).localeCompare(canonicalStringify(b)));
  }
  return bounded(value, 4 * 1024 * 1024 * Math.max(1, ids.length), 'Owner snapshot');
}
export async function lockCatalog(client) {
  await client.query(`LOCK TABLE ${Object.values(TABLES).map(([table]) => table).join(', ')}, catalog_identity_operations, catalog_ingredient_merges IN SHARE ROW EXCLUSIVE MODE`);
}
export function ingredient(value, id) {
  const row = value.ingredients.find(item => item.id === id && !item.deleted);
  if (!row) fail('Both original identities must exist and be live');
  return row;
}
export function validateSnapshot(value, id, owner) {
  for (const key of Object.keys(TABLES)) if (!Array.isArray(value?.[key])) fail('Malformed owner snapshot');
  if (value.ingredients.length !== 1 || value.ingredients[0].id !== id || value.ingredients[0].origin_instance_id !== owner) fail('Owner snapshot identity does not match requested owner and ID');
  for (const key of ['sources', 'refs', 'media', 'revisions']) if (value[key].some(row => row.ingredient_id !== id)) fail('Owner snapshot contains an unrelated identity');
  if (value.relations.some(row => row.from_id !== id && row.to_id !== id)) fail('Owner snapshot contains an unrelated relation');
  ingredient(value, id);
  bounded(value, 4 * 1024 * 1024, 'Owner snapshot');
  return value;
}
export function assertUnlocked(row) {
  if (row.payload?.locked !== false) fail('Both owner records must be explicitly unlocked', 'CATALOG_INGREDIENT_LOCKED');
}
function union(a, b, path, choices, conflicts) {
  if (canonicalStringify(a) === canonicalStringify(b)) return a;
  if (a == null || a === '') return b;
  if (b == null || b === '') return a;
  if (Array.isArray(a) && Array.isArray(b)) {
    const result = structuredClone(a);
    for (const item of b) {
      const index = item?.id ? result.findIndex(value => value?.id === item.id) : -1;
      if (index >= 0) result[index] = union(result[index], item, `${path}/${index}`, choices, conflicts);
      else if (!result.some(value => canonicalStringify(value) === canonicalStringify(item))) result.push(item);
    }
    return result;
  }
  if (typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    return Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map(key => [key,
      union(a[key], b[key], `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`, choices, conflicts)]));
  }
  if (!choices[path]) conflicts.push({ path, survivor: a, source: b });
  return choices[path] === 'source' ? b : a;
}
export function buildPlan(source, survivor, fieldChoices = {}, operationId) {
  const a = survivor.ingredients[0];
  const b = source.ingredients[0];
  if (!a || !b || a.id === b.id || a.type !== b.type || !a.origin_instance_id || !b.origin_instance_id
      || a.origin_instance_id === b.origin_instance_id) fail('Choose two same-type identities with different known owners');
  assertUnlocked(a); assertUnlocked(b);
  const conflicts = [];
  const content = row => ({ name: row.name, payload: row.payload, tags: row.tags });
  const proposed = union(content(a), content(b), '', fieldChoices, conflicts);
  proposed.payload.aliases = [...new Set([...(Array.isArray(proposed.payload.aliases) ? proposed.payload.aliases : []), a.name, b.name])]
    .filter(name => name !== proposed.name);
  const normalized = sanitizeBiblePayload(a.type, proposed.name, proposed.payload);
  const check = (value, next) => {
    if (Array.isArray(value) && Array.isArray(next) && next.length < value.length) fail('Union exceeds field capacity; no values were discarded');
    if (value && next && typeof value === 'object' && typeof next === 'object') for (const key of Object.keys(value)) check(value[key], next[key]);
  };
  check(proposed.payload, normalized);
  const archivedMedia = [a, b].flatMap(row => {
    const payload = row.payload || {};
    const pointers = [
      ...listSheetPointers(payload).map(pointer => ({ filename: pointer.filename, role: `sheet:${pointer.variant}` })),
      ...[payload.primaryImageRef, ...(Array.isArray(payload.imageRefs) ? payload.imageRefs : [])]
        .filter(filename => typeof filename === 'string' && filename).map(filename => ({ filename, role: 'archive:identity' })),
    ];
    return pointers.map(pointer => ({ ingredient_id: row.id, media_key: pointer.filename, kind: 'reference',
      role: pointer.role, caption: `Preserved from ${row.name}`, metadata: {}, created_at: row.created_at, deleted: false }));
  });
  const plan = { version: 1, operationId, sourceId: b.id, survivorId: a.id, sourceOwner: b.origin_instance_id,
    survivorOwner: a.origin_instance_id, source, survivor, fieldChoices, proposed, archivedMedia };
  bounded(plan, 8 * 1024 * 1024, 'Identity plan');
  // Commit adds a full revision. Reserve its complete payload before either
  // owner fences records; a valid plan must always fit the decision channel.
  bounded({ ...survivor, ingredients: [{ ...a, ...proposed }], revisions: [...survivor.revisions,
    { id: 'x'.repeat(80), ingredient_id: a.id, ...proposed, source: 'user', actor: 'catalog-shared-identity', created_at: 'x'.repeat(40) }] },
  4 * 1024 * 1024 - 4096, 'Projected canonical snapshot');
  return { plan, planHash: hash(plan), conflicts };
}
