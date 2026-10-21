// Local identity consolidation. Source rows remain live on the wire and revision identities survive;
// the receipt is also the exact recovery input, not a best-effort undo log.
import { createHash, randomUUID } from 'node:crypto';
import { withTransaction, query } from '../../lib/db.js';
import { canonicalStringify } from '../../lib/objects.js';
import { ServerError } from '../../lib/errorHandler.js';
import { getInstanceId, UNKNOWN_INSTANCE_ID } from '../instanceIdentity.js';
import { listSheetPointers } from '../../lib/sheetPointers.js';
import { sanitizeBiblePayload } from './shared.js';
import { catalogMergeSchema } from '../../lib/catalogValidation.js';

const TABLES = Object.freeze({
  ingredients: ['catalog_ingredients', 'id = ANY($1)'],
  sources: ['catalog_ingredient_sources', 'ingredient_id = ANY($1)'],
  refs: ['catalog_ingredient_refs', 'ingredient_id = ANY($1)'],
  media: ['catalog_ingredient_media', 'ingredient_id = ANY($1)'],
  relations: ['catalog_ingredient_relations', 'from_id = ANY($1) OR to_id = ANY($1)'],
  revisions: ['catalog_ingredient_revisions', 'ingredient_id = ANY($1)'],
});
const fail = (message, code = 'CATALOG_MERGE_CONFLICT') => {
  throw new ServerError(message, { status: 409, code });
};
const fingerprint = value => createHash('sha256').update(canonicalStringify(value)).digest('hex');
const plain = value => JSON.parse(JSON.stringify(value));
const empty = value => value == null || value === '';

async function snapshot(client, ids) {
  const result = {};
  for (const [key, [table, where]] of Object.entries(TABLES)) {
    const { rows } = await client.query(`SELECT * FROM ${table} WHERE ${where}`, [ids]);
    result[key] = plain(rows).sort((a, b) => canonicalStringify(a).localeCompare(canonicalStringify(b)));
  }
  return result;
}

function assertOwnedUnlocked(rows, instanceId) {
  if (!instanceId || instanceId === UNKNOWN_INSTANCE_ID) fail('Local instance identity is unavailable');
  for (const row of rows) {
    if (row.origin_instance_id !== instanceId) fail('Both ingredients must belong to this instance', 'CATALOG_MERGE_FOREIGN');
    if (row.payload?.locked !== false) fail('Both ingredients must be explicitly unlocked', 'CATALOG_INGREDIENT_LOCKED');
  }
}

// Object fields recurse; lists union without truncation. Every unequal populated
// scalar needs an explicit choice. The receipt preserves the unchosen originals.
function unionValue(survivor, source, path, choices, conflicts) {
  if (canonicalStringify(survivor) === canonicalStringify(source)) return survivor;
  if (empty(survivor)) return source;
  if (empty(source)) return survivor;
  if (Array.isArray(survivor) && Array.isArray(source)) {
    const result = [...survivor];
    for (const value of source) {
      const index = value?.id ? result.findIndex(existing => existing?.id === value.id) : -1;
      if (index >= 0) result[index] = unionValue(result[index], value, `${path}/${index}`, choices, conflicts);
      else if (!result.some(existing => canonicalStringify(existing) === canonicalStringify(value))) result.push(value);
    }
    return result;
  }
  if (typeof survivor === 'object' && typeof source === 'object' && !Array.isArray(survivor) && !Array.isArray(source)) {
    return Object.fromEntries([...new Set([...Object.keys(survivor), ...Object.keys(source)])].map(key => [key,
      unionValue(survivor[key], source[key], `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`, choices, conflicts)]));
  }
  const choice = choices[path];
  if (!choice) conflicts.push({ path, survivor, source });
  return choice === 'source' ? source : survivor;
}

async function lockState(client, ids, writing) {
  if (writing) {
    // Catalog link/attachment writers do not all lock the owning ingredient.
    // Row locks alone therefore miss phantom attachments after the preview.
    // Short DB-only table locks cover those existing writers without imposing
    // a new lock protocol on every caller. No provider/file/peer work runs here.
    await client.query(`LOCK TABLE ${Object.values(TABLES).map(([table]) => table).join(', ')}, catalog_identity_operations, catalog_ingredient_merges IN SHARE ROW EXCLUSIVE MODE`);
  }
  await client.query('SELECT id FROM catalog_ingredients WHERE id = ANY($1) ORDER BY id FOR UPDATE', [ids]);
}

export async function mergeIngredients(input) {
  const body = catalogMergeSchema.parse(input);
  const { sourceId, survivorId, fieldChoices, dryRun } = body;
  if (sourceId === survivorId) fail('Choose two different ingredient identities');
  const instanceId = await getInstanceId();
  return withTransaction(async client => {
    const ids = [sourceId, survivorId].sort();
    await lockState(client, ids, !dryRun);
    const active = await client.query(`SELECT id FROM catalog_ingredient_merges
      WHERE restored_at IS NULL AND (source_id = ANY($1) OR survivor_id = ANY($1))`, [ids]);
    if (active.rowCount) fail('Recover the existing merge before merging either identity again');
    const shared = await client.query(`SELECT id FROM catalog_identity_operations
      WHERE state IN ('proposed', 'prepared', 'committed', 'recovery_prepared')
        AND (source_id = ANY($1) OR survivor_id = ANY($1))`, [ids]);
    if (shared.rowCount) fail('Complete or recover the shared identity operation before merging either identity', 'CATALOG_IDENTITY_OVERLAP');
    const before = await snapshot(client, ids);
    const source = before.ingredients.find(row => row.id === sourceId && !row.deleted);
    const survivor = before.ingredients.find(row => row.id === survivorId && !row.deleted);
    if (!source || !survivor) fail('Both ingredients must exist and be live');
    assertOwnedUnlocked([source, survivor], instanceId);
    if (source.type !== survivor.type) fail('Ingredient types must match');
    const conflicts = [];
    const proposed = unionValue(
      { name: survivor.name, payload: survivor.payload, tags: survivor.tags },
      { name: source.name, payload: source.payload, tags: source.tags }, '', fieldChoices, conflicts,
    );
    // Alternate names remain discoverable even when the chosen display name differs.
    proposed.payload.aliases = [...new Set([...(Array.isArray(proposed.payload.aliases) ? proposed.payload.aliases : []), source.name, survivor.name])]
      .filter(name => name !== proposed.name);
    const sanitized = sanitizeBiblePayload(source.type, proposed.name, proposed.payload);
    const checkArrayCapacity = (value, normalized, path = 'payload') => {
      if (Array.isArray(value) && Array.isArray(normalized) && normalized.length < value.length) {
        fail(`Merged ${path} exceeds the supported capacity or contains incompatible entries; no values were discarded`);
      }
      if (value && normalized && typeof value === 'object' && typeof normalized === 'object') {
        for (const key of Object.keys(value)) checkArrayCapacity(value[key], normalized[key], `${path}/${key}`);
      }
    };
    checkArrayCapacity(proposed.payload, sanitized);
    const previewToken = fingerprint({ before, proposed, fieldChoices });
    if (dryRun) return { sourceId, survivorId, proposed, conflicts, previewToken,
      counts: Object.fromEntries(Object.entries(before).map(([key, rows]) => [key, rows.length])) };
    if (conflicts.length) fail('Resolve every populated scalar conflict before merging');
    if (body.previewToken !== previewToken) fail('Catalog changed or choices changed; preview the merge again', 'CATALOG_MERGE_STALE');

    await client.query(`UPDATE catalog_ingredients SET name = $2, payload = $3::jsonb, tags = $4,
      embedding = NULL, embedding_model = NULL WHERE id = $1`,
    [survivorId, proposed.name, JSON.stringify(proposed.payload), proposed.tags]);
    // Copy only live associations; retain the original rows and collision
    // provenance in the receipt rather than overwriting survivor captions/spans.
    await client.query(`INSERT INTO catalog_ingredient_refs (ingredient_id, ref_kind, ref_id, role, created_at)
      SELECT $2, ref_kind, ref_id, role, created_at FROM catalog_ingredient_refs
      WHERE ingredient_id = $1 AND deleted = false
      ON CONFLICT (ingredient_id, ref_kind, ref_id, role) DO UPDATE SET deleted = false, deleted_at = NULL`, [sourceId, survivorId]);
    const hasPortrait = before.media.some(row => row.ingredient_id === survivorId && row.kind === 'portrait' && !row.deleted);
    const mediaCopies = new Map();
    const rememberMedia = row => {
      const key = JSON.stringify([row.media_key, row.kind]);
      if (!mediaCopies.has(key)) mediaCopies.set(key, row);
    };
    // Reference rows win a collision with a demoted portrait's converted key.
    // Both originals (including distinct metadata) stay in the receipt.
    for (const row of before.media.filter(row => row.ingredient_id === sourceId && !row.deleted)
      .sort((a, b) => Number(a.kind === 'portrait') - Number(b.kind === 'portrait'))) {
      rememberMedia({ ...row, kind: hasPortrait && row.kind === 'portrait' ? 'reference' : row.kind });
    }
    // Choosing one canonical pointer must not make its unchosen image disappear.
    // Archive every original pointer as a reference; never promote it to canon.
    for (const row of [survivor, source]) {
      const payload = row.payload || {};
      const pointers = [
        ...listSheetPointers(payload).map(pointer => ({ filename: pointer.filename, role: `sheet:${pointer.variant}` })),
        ...[payload.primaryImageRef, ...(Array.isArray(payload.imageRefs) ? payload.imageRefs : [])]
          .filter(filename => typeof filename === 'string' && filename).map(filename => ({ filename, role: 'archive:reference' })),
      ];
      for (const pointer of pointers.filter(pointer => typeof pointer.filename === 'string' && pointer.filename)) rememberMedia({ media_key: pointer.filename, kind: 'reference', role: pointer.role,
        caption: `Preserved from ${row.name}`, metadata: {}, created_at: row.created_at });
    }
    for (const row of mediaCopies.values()) {
      await client.query(`INSERT INTO catalog_ingredient_media (ingredient_id, media_key, kind, role, caption, metadata, created_at, library)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb)
        ON CONFLICT (ingredient_id, media_key, kind) DO UPDATE SET deleted = false, deleted_at = NULL`,
      [survivorId, row.media_key, row.kind, row.role, row.caption, JSON.stringify(row.metadata), row.created_at, JSON.stringify(row.library || {})]);
    }
    await client.query(`INSERT INTO catalog_ingredient_relations (from_id, to_id, kind, created_at)
      SELECT CASE WHEN from_id = $1 THEN $2 ELSE from_id END,
             CASE WHEN to_id = $1 THEN $2 ELSE to_id END, kind, created_at
      FROM catalog_ingredient_relations WHERE (from_id = $1 OR to_id = $1) AND deleted = false
        AND NOT (from_id = ANY($3) AND to_id = ANY($3))
      ON CONFLICT (from_id, to_id, kind) DO UPDATE SET deleted = false, deleted_at = NULL`, [sourceId, survivorId, ids]);
    await client.query(`INSERT INTO catalog_ingredient_revisions (id, ingredient_id, name, payload, tags, source, actor)
      VALUES ($1, $2, $3, $4::jsonb, $5, 'user', 'catalog-merge')`,
    [`cat-rev-${randomUUID()}`, survivorId, proposed.name, JSON.stringify(proposed.payload), proposed.tags]);
    const after = await snapshot(client, ids);
    const id = randomUUID();
    await client.query(`INSERT INTO catalog_ingredient_merges
      (id, source_id, survivor_id, before_state, after_fingerprint) VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [id, sourceId, survivorId, JSON.stringify({ ...before, decision: { scope: 'local', fieldChoices, proposed } }), fingerprint(after)]);
    return { id, sourceId, survivorId, merged: true, scope: 'local' };
  });
}

const RECEIPT_SUMMARY = `id, source_id AS "sourceId", survivor_id AS "survivorId",
  created_at AS "createdAt", restored_at AS "restoredAt"`;

export async function getIngredientMergeHistory(ingredientId, { limit = 10, offset = 0 } = {}) {
  const pageSize = Math.min(50, Math.max(1, limit));
  const start = Math.max(0, offset);
  const { rows } = await query(`SELECT ${RECEIPT_SUMMARY},
    jsonb_build_object('ingredients', jsonb_array_length(before_state->'ingredients'),
      'revisions', jsonb_array_length(before_state->'revisions'), 'media', jsonb_array_length(before_state->'media'),
      'refs', jsonb_array_length(before_state->'refs'), 'sources', jsonb_array_length(before_state->'sources'),
      'relations', jsonb_array_length(before_state->'relations')) AS counts
    FROM catalog_ingredient_merges WHERE source_id = $1 OR survivor_id = $1
    ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`, [ingredientId, pageSize + 1, start]);
  return { items: rows.slice(0, pageSize), nextOffset: rows.length > pageSize ? start + pageSize : null };
}

export async function getIngredientMergeReceipt(id) {
  const { rows: [receipt] } = await query(`SELECT ${RECEIPT_SUMMARY}, before_state AS "beforeState"
    FROM catalog_ingredient_merges WHERE id = $1`, [id]);
  if (!receipt) throw new ServerError('Merge receipt not found', { status: 404 });
  return receipt;
}

export async function recoverIngredientMerge(id) {
  const instanceId = await getInstanceId();
  return withTransaction(async client => {
    // Same order as apply: table locks before any receipt/ingredient row lock.
    await lockState(client, [], true);
    const { rows: [receipt] } = await client.query('SELECT * FROM catalog_ingredient_merges WHERE id = $1 FOR UPDATE', [id]);
    if (!receipt) throw new ServerError('Merge receipt not found', { status: 404 });
    if (receipt.restored_at) return { id, restored: true };
    const ids = [receipt.source_id, receipt.survivor_id].sort();
    const current = await snapshot(client, ids);
    assertOwnedUnlocked(current.ingredients, instanceId);
    if (fingerprint(current) !== receipt.after_fingerprint) fail('Merged state changed; recovery would overwrite later work', 'CATALOG_MERGE_STALE');
    await client.query('UPDATE catalog_ingredient_merges SET restored_at = NOW() WHERE id = $1', [id]);
    // Source rows never moved. Restore only the two records and associations
    // captured by this operation; unrelated ingredients and assets are untouched.
    for (const key of ['refs', 'media', 'relations']) {
      const [table, where] = TABLES[key];
      await client.query(`UPDATE ${table} SET deleted = true, deleted_at = NOW() WHERE ${where}`, [ids]);
      const rows = receipt.before_state[key];
      if (!rows.length) continue;
      const columns = Object.keys(rows[0]).filter(column => !['sync_sequence', 'updated_at'].includes(column));
      const keys = key === 'refs' ? ['ingredient_id', 'ref_kind', 'ref_id', 'role']
        : key === 'media' ? ['ingredient_id', 'media_key', 'kind'] : ['from_id', 'to_id', 'kind'];
      const updates = columns.filter(column => !keys.includes(column)).map(column => `${column} = EXCLUDED.${column}`);
      await client.query(`INSERT INTO ${table} (${columns.join(', ')})
        SELECT ${columns.join(', ')} FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb)
        ON CONFLICT (${keys.join(', ')}) DO UPDATE SET ${updates.join(', ')}`, [JSON.stringify(rows)]);
    }
    // Keep the merge revision as an audit event. Recovery adds a new snapshot;
    // the receipt retains the complete before/after identity history.
    for (const row of receipt.before_state.ingredients) {
      await client.query(`UPDATE catalog_ingredients SET name = $2, payload = $3::jsonb, tags = $4,
        embedding = $5, embedding_model = $6, deleted = $7, deleted_at = $8 WHERE id = $1`,
      [row.id, row.name, JSON.stringify(row.payload), row.tags, row.embedding, row.embedding_model, row.deleted, row.deleted_at]);
    }
    for (const row of receipt.before_state.ingredients) {
      await client.query(`INSERT INTO catalog_ingredient_revisions (id, ingredient_id, name, payload, tags, source, actor)
        VALUES ($1, $2, $3, $4::jsonb, $5, 'user', 'catalog-merge-recovery')`,
      [`cat-rev-${randomUUID()}`, row.id, row.name, JSON.stringify(row.payload), row.tags]);
    }
    return { id, restored: true };
  });
}
