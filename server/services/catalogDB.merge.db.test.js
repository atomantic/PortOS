import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { checkHealth, ensureSchema, query, close } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import { mergeIngredients, recoverIngredientMerge, getIngredientMergeHistory, getIngredientMergeReceipt } from './catalogDB/merge.js';
import { getIngredient, getIngredientTimestamps, listIngredients, resolveIngredientsByIds, listIngredientRevisions, updateIngredient } from './catalogDB/ingredients.js';
import { attachMedia, listMediaForIngredient } from './catalogDB/media.js';
import { linkIngredientRelation, listRelationsForIngredient, listRefsForIngredient, listSourcesForIngredient } from './catalogDB/refs.js';
import { exportSliceForRef, getCatalogStats } from './catalogDB/facets.js';
import { projectToCanon, projectToCatalog } from './catalogCanonProjection.js';
import { upsertIngredientFromPeer } from './catalogDB/sync.js';

vi.mock('./instanceIdentity.js', () => ({ getInstanceId: async () => 'example-local-instance', UNKNOWN_INSTANCE_ID: 'unknown' }));
const health = await checkHealth().catch(error => ({ connected: false, error: error.message }));
const ready = requireDbOrSkip('catalog local merge', health.connected, health.error);
if (ready) await ensureSchema();
const ids = [];
const scraps = [];
async function pair() {
  const sourceId = `merge-test-${randomUUID()}`;
  const survivorId = `merge-test-${randomUUID()}`;
  ids.push(sourceId, survivorId);
  for (const [id, name, payload] of [
    [sourceId, 'Example Pilot', { locked: false, description: 'Original biography', imageRefs: ['original.png'] }],
    [survivorId, 'Example Pilot (Cast)', { locked: false, description: 'Performance notes', imageRefs: ['cast.png'] }],
  ]) {
    await query(`INSERT INTO catalog_ingredients (id, type, name, payload, origin_instance_id)
      VALUES ($1, 'character', $2, $3::jsonb, 'example-local-instance')`, [id, name, JSON.stringify(payload)]);
    await query(`INSERT INTO catalog_ingredient_revisions (id, ingredient_id, name, payload)
      VALUES ($1, $2, $3, $4::jsonb)`, [`rev-${randomUUID()}`, id, name, JSON.stringify(payload)]);
  }
  return { sourceId, survivorId, fieldChoices: { '/name': 'survivor', '/payload/description': 'source' } };
}
async function apply(input) {
  const preview = await mergeIngredients(input);
  return mergeIngredients({ ...input, dryRun: false, previewToken: preview.previewToken });
}
afterAll(async () => {
  if (!ready) return;
  await query('DELETE FROM catalog_ingredient_merges WHERE source_id = ANY($1)', [ids]);
  await query('DELETE FROM catalog_ingredient_refs WHERE ingredient_id = ANY($1)', [ids]);
  await query('DELETE FROM catalog_ingredients WHERE id = ANY($1)', [ids]);
  await query('DELETE FROM catalog_scraps WHERE id = ANY($1)', [scraps]);
  await close();
});

describe.skipIf(!ready)('recoverable local catalog merge', () => {
  it('preserves identities, history, assets and provenance through source-ID lookups and background attachments', async () => {
    const input = await pair();
    const { sourceId, survivorId } = input;
    await attachMedia(sourceId, 'source-sheet.png', 'reference', { role: 'sheet:standard', metadata: { prompt: 'Example sheet prompt' } });
    await attachMedia(survivorId, 'cast-portrait.png', 'portrait');
    await query(`INSERT INTO catalog_ingredient_refs (ingredient_id, ref_kind, ref_id, role)
      VALUES ($1, 'music-video', 'example-video', 'cast')`, [sourceId]);
    const scrapId = `scrap-${randomUUID()}`;
    scraps.push(scrapId);
    await query("INSERT INTO catalog_scraps (id, title, raw_text, source_kind) VALUES ($1, 'Example notes', 'Example source', 'text')", [scrapId]);
    await query('INSERT INTO catalog_ingredient_sources (ingredient_id, scrap_id, span) VALUES ($1, $2, $3::jsonb)', [sourceId, scrapId, JSON.stringify({ start: 1, end: 5 })]);
    const { rows: [sourceBefore] } = await query('SELECT * FROM catalog_ingredients WHERE id = $1', [sourceId]);
    const statsBefore = await getCatalogStats();
    const result = await apply(input);
    const statsAfter = await getCatalogStats();
    expect(Number(statsAfter.byType.character)).toBe(Number(statsBefore.byType.character) - 1);
    const exported = await exportSliceForRef('music-video', 'example-video');
    expect(exported.ingredients.map(row => row.id)).toEqual(expect.arrayContaining([sourceId, survivorId]));
    expect(exported.ingredients.find(row => row.id === sourceId).media.map(row => row.mediaKey)).toEqual(['source-sheet.png']);
    expect(result.scope).toBe('local');
    await expect(linkIngredientRelation(sourceId, survivorId, 'related-to')).rejects.toThrow('identity to itself');
    expect((await getIngredient(sourceId)).id).toBe(survivorId);
    expect((await getIngredient(sourceId)).payload.imageRefs).toEqual(['cast.png', 'original.png']);
    expect((await resolveIngredientsByIds([sourceId, survivorId])).map(row => row.id)).toEqual([survivorId]);
    const timestamps = await getIngredientTimestamps([sourceId, survivorId]);
    expect(timestamps.get(sourceId)).toBe(timestamps.get(survivorId));
    expect((await listIngredients({ ids: [sourceId, survivorId] })).items.map(row => row.id)).toEqual([survivorId]);
    expect((await listRefsForIngredient(sourceId)).map(row => row.refId)).toContain('example-video');
    expect((await listSourcesForIngredient(survivorId)).map(row => row.ingredientId)).toContain(sourceId);
    expect((await listMediaForIngredient(sourceId)).map(row => row.mediaKey)).toEqual(expect.arrayContaining(['source-sheet.png', 'cast-portrait.png']));
    const revisions = await listIngredientRevisions(survivorId);
    expect(new Set(revisions.items.map(row => row.ingredientId))).toEqual(new Set([sourceId, survivorId]));
    const historyPage = await getIngredientMergeHistory(survivorId);
    expect(historyPage.nextOffset).toBeNull();
    expect(historyPage.items[0]).not.toHaveProperty('beforeState');
    const history = [await getIngredientMergeReceipt(historyPage.items[0].id)];
    expect(history[0].beforeState.media.find(row => row.media_key === 'source-sheet.png').metadata.prompt).toBe('Example sheet prompt');
    expect(history[0].beforeState.revisions).toHaveLength(2);
    expect(history[0].beforeState.decision.fieldChoices).toEqual(input.fieldChoices);
    // Source stays byte-identical and live for peers that do not know local aliases.
    expect((await query('SELECT * FROM catalog_ingredients WHERE id = $1', [sourceId])).rows[0]).toEqual(sourceBefore);
    await expect(query('UPDATE catalog_ingredients SET deleted = true WHERE id = $1', [sourceId])).rejects.toThrow('protected');
    expect(await upsertIngredientFromPeer({ ...await getIngredient(sourceId), id: sourceId, updatedAt: new Date(Date.now() + 10000).toISOString() })).toEqual({ applied: false, isInsert: false });
    await attachMedia(sourceId, 'late-job.png', 'reference');
    expect((await listMediaForIngredient(survivorId)).map(row => row.mediaKey)).toContain('late-job.png');
    await expect(recoverIngredientMerge(result.id)).rejects.toMatchObject({ code: 'CATALOG_MERGE_STALE' });
  });

  it('previews conflicts without writes and rejects ownership, locks, stale previews and alias chains', async () => {
    const input = await pair();
    const unresolved = await mergeIngredients({ sourceId: input.sourceId, survivorId: input.survivorId });
    expect(unresolved.conflicts.map(row => row.path)).toEqual(expect.arrayContaining(['/name', '/payload/description']));
    await expect(mergeIngredients({ ...input, fieldChoices: {}, dryRun: false, previewToken: unresolved.previewToken })).rejects.toMatchObject({ code: 'CATALOG_MERGE_CONFLICT' });
    const preview = await mergeIngredients(input);
    await attachMedia(input.sourceId, 'new-reference.png', 'reference');
    await expect(mergeIngredients({ ...input, dryRun: false, previewToken: preview.previewToken })).rejects.toMatchObject({ code: 'CATALOG_MERGE_STALE' });
    await query("UPDATE catalog_ingredients SET payload = payload || '{\"locked\":true}'::jsonb WHERE id = $1", [input.sourceId]);
    await expect(mergeIngredients(input)).rejects.toMatchObject({ code: 'CATALOG_INGREDIENT_LOCKED' });
    await query("UPDATE catalog_ingredients SET payload = payload || '{\"locked\":false}'::jsonb, origin_instance_id = 'example-peer' WHERE id = $1", [input.sourceId]);
    await expect(mergeIngredients(input)).rejects.toMatchObject({ code: 'CATALOG_MERGE_FOREIGN' });
    await query("UPDATE catalog_ingredients SET origin_instance_id = 'example-local-instance' WHERE id = $1", [input.sourceId]);
    await apply(input);
    const another = await pair();
    await expect(mergeIngredients({ ...another, sourceId: input.survivorId })).rejects.toThrow('existing merge');
  });

  it('recovers an untouched merge without dropping audit history and leaves synchronized link tombstones', async () => {
    const input = await pair();
    await attachMedia(input.sourceId, 'recover-sheet.png', 'reference', { caption: 'Original caption' });
    const result = await apply(input);
    expect(await recoverIngredientMerge(result.id)).toEqual({ id: result.id, restored: true });
    expect(await recoverIngredientMerge(result.id)).toEqual({ id: result.id, restored: true });
    expect((await getIngredient(input.sourceId)).id).toBe(input.sourceId);
    expect((await getIngredient(input.survivorId)).payload.description).toBe('Performance notes');
    expect((await listMediaForIngredient(input.sourceId)).map(row => row.mediaKey)).toContain('recover-sheet.png');
    expect(await listMediaForIngredient(input.survivorId)).toEqual([]);
    expect((await query('SELECT deleted FROM catalog_ingredient_media WHERE ingredient_id = $1', [input.survivorId])).rows.every(row => row.deleted)).toBe(true);
    expect((await listIngredientRevisions(input.survivorId)).items.map(row => row.actor)).toContain('catalog-merge-recovery');
    expect((await getIngredientMergeHistory(input.sourceId)).items[0].restoredAt).not.toBeNull();
  });

  it('revives collided relationships and keeps both portraits visible', async () => {
    const input = await pair();
    const other = await pair();
    await attachMedia(input.sourceId, 'old-portrait.png', 'reference', { caption: 'Existing reference metadata' });
    await attachMedia(input.sourceId, 'old-portrait.png', 'portrait');
    await attachMedia(input.survivorId, 'kept-portrait.png', 'portrait');
    await query(`INSERT INTO catalog_ingredient_relations (from_id, to_id, kind, deleted)
      VALUES ($1, $3, 'related-to', false), ($2, $3, 'related-to', true)`, [input.sourceId, input.survivorId, other.sourceId]);
    await apply(input);
    const media = await listMediaForIngredient(input.survivorId);
    expect(media.filter(row => row.kind === 'portrait').map(row => row.mediaKey)).toEqual(['kept-portrait.png']);
    expect(media.filter(row => row.mediaKey === 'old-portrait.png')).toHaveLength(1);
    expect(media.find(row => row.mediaKey === 'old-portrait.png')).toMatchObject({ kind: 'reference', caption: 'Existing reference metadata' });
    expect((await listRelationsForIngredient(input.sourceId)).outbound.map(row => row.other.id)).toContain(other.sourceId);
  });

  it('requires a choice for conflicting objects sharing a stable array ID', async () => {
    const input = await pair();
    for (const [id, description] of [[input.sourceId, 'Heavy coat'], [input.survivorId, 'Light jacket']]) {
      await query("UPDATE catalog_ingredients SET payload = payload || $2::jsonb WHERE id = $1", [id,
        JSON.stringify({ wardrobes: [{ id: 'example-costume', name: 'Travel', description }] })]);
    }
    const preview = await mergeIngredients(input);
    expect(preview.conflicts.map(row => row.path)).toContain('/payload/wardrobes/0/description');
    input.fieldChoices['/payload/wardrobes/0/description'] = 'source';
    await apply(input);
    expect((await getIngredient(input.survivorId)).payload.wardrobes).toEqual([{ id: 'example-costume', name: 'Travel', description: 'Heavy coat' }]);
  });

  it('guards archived canon snapshots and lets an explicit catalog edit refresh alias-backed canon', async () => {
    const input = await pair();
    await query(`INSERT INTO catalog_ingredient_refs (ingredient_id, ref_kind, ref_id, role)
      VALUES ($1, 'universe', 'example-universe', 'canon-character')`, [input.sourceId]);
    await apply(input);
    const oldEntry = { id: 'example-entry', ingredientId: input.sourceId, name: 'Old context',
      description: 'Must not replace merged payload', updatedAt: new Date(Date.now() + 10000).toISOString() };
    expect(await projectToCatalog('example-universe', { characters: [oldEntry] })).toEqual({ written: 0, skipped: 1 });
    expect((await getIngredient(input.survivorId)).payload.description).toBe('Original biography');
    const updated = await getIngredient(input.sourceId);
    let projected;
    const stats = await projectToCanon(input.sourceId, updated, { updateUniverse: async (_id, mutate, options) => {
      projected = await mutate({ characters: [oldEntry] });
      // The synchronous echo cannot race the source alias against the survivor.
      expect(await projectToCatalog('example-universe', projected, {
        guardToken: options.canonProjectionGuard,
        guardIdentityIds: options.canonProjectionIdentityIds,
      })).toEqual({ written: 0, skipped: 1 });
      return projected;
    } });
    expect(stats.written).toBe(1);
    expect(projected.characters[0]).toMatchObject({ ingredientId: input.survivorId, name: updated.name, description: 'Original biography' });
  });

  it('admits only one overlapping apply of the same reviewed preview', async () => {
    const input = await pair();
    const preview = await mergeIngredients(input);
    const request = { ...input, dryRun: false, previewToken: preview.previewToken };
    const results = await Promise.allSettled([mergeIngredients(request), mergeIngredients(request)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected').reason.status).toBe(409);
    expect((await getIngredientMergeHistory(input.sourceId)).items).toHaveLength(1);
  });

  it('keeps both files viewable when canonical primary and sheet pointers conflict', async () => {
    const input = await pair();
    for (const [id, key] of [[input.sourceId, 'source'], [input.survivorId, 'survivor']]) {
      await query('UPDATE catalog_ingredients SET payload = payload || $2::jsonb WHERE id = $1', [id,
        JSON.stringify({ primaryImageRef: `${key}-primary.png`, referenceSheetImageRef: `${key}-standard.png`,
          referenceSheets: { blueprint: `${key}-blueprint.png` } })]);
    }
    Object.assign(input.fieldChoices, { '/payload/primaryImageRef': 'survivor',
      '/payload/referenceSheetImageRef': 'survivor', '/payload/referenceSheets/blueprint': 'survivor' });
    await apply(input);
    const media = await listMediaForIngredient(input.survivorId);
    expect(media.map(row => row.mediaKey)).toEqual(expect.arrayContaining([
      'source-primary.png', 'survivor-primary.png', 'source-standard.png', 'survivor-standard.png',
      'source-blueprint.png', 'survivor-blueprint.png',
    ]));
    expect((await listIngredients({ ids: [input.survivorId] })).items[0].thumbnailKey).toBeNull();
    expect(media.filter(row => row.role === 'sheet:blueprint').map(row => row.mediaKey)).toEqual(expect.arrayContaining(['source-blueprint.png', 'survivor-blueprint.png']));
    expect((await getIngredient(input.survivorId)).payload.referenceSheets.blueprint).toBe('survivor-blueprint.png');
  });

  it('pages summary history and loads archived snapshots only by receipt', async () => {
    const input = await pair();
    const first = await apply(input);
    await recoverIngredientMerge(first.id);
    const second = await apply(input);
    const page = await getIngredientMergeHistory(input.survivorId, { limit: 1 });
    expect(page.items.map(row => row.id)).toEqual([second.id]);
    expect(page.nextOffset).toBe(1);
    expect(page.items[0]).not.toHaveProperty('beforeState');
    const next = await getIngredientMergeHistory(input.survivorId, { limit: 1, offset: page.nextOffset });
    expect(next.items.map(row => row.id)).toEqual([first.id]);
    expect(next.nextOffset).toBeNull();
    expect((await getIngredientMergeReceipt(first.id)).beforeState.ingredients.map(row => row.id)).toContain(input.sourceId);
  });

  it('refuses recovery after a new lock or canonical edit', async () => {
    const input = await pair();
    const result = await apply(input);
    await updateIngredient(input.survivorId, { payload: { ...(await getIngredient(input.survivorId)).payload, locked: true } });
    await expect(recoverIngredientMerge(result.id)).rejects.toMatchObject({ code: 'CATALOG_INGREDIENT_LOCKED' });
  });
});
