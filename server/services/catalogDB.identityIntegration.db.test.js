import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { checkHealth, close, ensureSchema, query } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import * as catalog from './catalogDB.js';
import { getCatalogIdentityAccess } from './catalogDB/identityAccess.js';
import { mergeIngredients } from './catalogDB/merge.js';
import { projectToCanon, projectToCatalog } from './catalogCanonProjection.js';

vi.mock('./instanceIdentity.js', () => ({ getInstanceId: async () => 'identity-test-local', UNKNOWN_INSTANCE_ID: 'unknown' }));
const health = await checkHealth().catch(error => ({ connected: false, error: error.message }));
const ready = requireDbOrSkip('shared identity integration', health.connected, health.error);
if (ready) await ensureSchema();
const ingredientIds = [];
const operations = [];
const universes = [];
const plain = value => JSON.parse(JSON.stringify(value));
const now = '2026-01-02T00:00:00.000Z';

async function fixture({ owned = false, state = 'committed', staleSourceReplica = false } = {}) {
  const prefix = `identity-read-${randomUUID()}`;
  const sourceId = `${prefix}-source`;
  const survivorId = `${prefix}-survivor`;
  const thirdId = `${prefix}-other`;
  const universeId = `${prefix}-universe`;
  const sourceOwner = owned ? 'identity-test-peer' : 'identity-test-local';
  const survivorOwner = owned ? 'identity-test-local' : 'identity-test-peer';
  ingredientIds.push(sourceId, survivorId, thirdId);
  operations.push(prefix);
  universes.push(universeId);
  await query('INSERT INTO universes(id, name) VALUES ($1, $2)', [universeId, 'Example context']);
  for (const [id, owner, name] of [[sourceId, sourceOwner, 'Original Example'], [survivorId, survivorOwner, 'Canonical Example'], [thirdId, 'identity-test-local', 'Other Example']]) {
    await query(`INSERT INTO catalog_ingredients (id, type, name, payload, origin_instance_id)
      VALUES ($1, 'character', $2, '{"locked":false,"aliases":["Original Example"]}'::jsonb, $3)`, [id, name, owner]);
  }
  const sourceRow = (await query('SELECT * FROM catalog_ingredients WHERE id = $1', [sourceId])).rows[0];
  const survivorRow = (await query('SELECT * FROM catalog_ingredients WHERE id = $1', [survivorId])).rows[0];
  const refs = [{ ingredient_id: sourceId, ref_kind: 'universe', ref_id: universeId, role: 'cast', created_at: now, updated_at: now, deleted: false }];
  const media = [{ ingredient_id: sourceId, media_key: `${prefix}.png`, kind: 'reference', role: 'sheet:front', caption: 'Original evidence', metadata: { prompt: 'Original example prompt' }, created_at: now, updated_at: now, deleted: false }];
  const sourceRevision = { id: `${prefix}-source-revision`, ingredient_id: sourceId, name: sourceRow.name, payload: { description: 'Original history' }, tags: [], source: 'user', created_at: now };
  const survivorRevision = { ...sourceRevision, id: `${prefix}-survivor-revision`, ingredient_id: survivorId, name: survivorRow.name };
  const source = { ingredients: [sourceRow], refs, media, sources: [{ ingredient_id: sourceId, scrap_id: `${prefix}-missing-scrap`, span: { start: 3, end: 9 }, extracted_at: now }], relations: [{ from_id: sourceId, to_id: thirdId, kind: 'knows', created_at: now, updated_at: now, deleted: false }], revisions: [sourceRevision] };
  const survivor = { ingredients: [survivorRow], refs: [], media: [], sources: [], relations: [], revisions: [survivorRevision] };
  const plan = plain({ version: 1, sourceId, survivorId, sourceOwner, survivorOwner, source, survivor, proposed: { name: survivorRow.name, payload: survivorRow.payload, tags: [] } });
  if (staleSourceReplica) await query("UPDATE catalog_ingredients SET name = 'Stale replica example' WHERE id = $1", [sourceId]);
  await query(`INSERT INTO catalog_identity_operations (id, source_id, survivor_id, source_owner, survivor_owner, local_owner, state, plan, plan_hash, current_snapshot)
    VALUES ($1,$2,$3,$4,$5,'identity-test-local',$6,$7::jsonb,'fixture',$8::jsonb)`,
  [prefix, sourceId, survivorId, sourceOwner, survivorOwner, state, JSON.stringify(plan), JSON.stringify(plain(survivor))]);
  return { id: prefix, sourceId, survivorId, thirdId, universeId, source, survivor, mediaKey: media[0].media_key, plan };
}

afterAll(async () => {
  if (!ready) return;
  await query('DELETE FROM catalog_identity_operations WHERE id = ANY($1)', [operations]);
  await query('DELETE FROM catalog_ingredients WHERE id = ANY($1)', [ingredientIds]);
  await query('DELETE FROM universes WHERE id = ANY($1)', [universes]);
  await close();
});

describe.skipIf(!ready)('shared identity catalog integration', () => {
  it('resolves old IDs and includes owner-only evidence in details, albums, facets and history while export stays original', async () => {
    const f = await fixture({ staleSourceReplica: true });
    expect((await catalog.getIngredient(f.sourceId)).id).toBe(f.survivorId);
    expect((await catalog.resolveIngredientsByIds([f.sourceId, f.survivorId])).map(row => row.id)).toEqual([f.survivorId]);
    expect((await catalog.listIngredients({ ids: [f.sourceId, f.survivorId] })).items.map(row => row.id)).toEqual([f.survivorId]);
    expect((await catalog.listIngredients({ refKind: 'universe', refId: f.universeId })).items.map(row => row.id)).toEqual([f.survivorId]);
    expect((await catalog.getCatalogFacets()).universes.find(row => row.refId === f.universeId).count).toBe(1);
    expect((await catalog.listIngredientsForRef('universe', f.universeId)).map(row => row.ingredient.id)).toEqual([f.survivorId]);
    expect(await catalog.listRefsForIngredient(f.survivorId)).toEqual([expect.objectContaining({ ingredientId: f.sourceId, refId: f.universeId })]);
    expect(await catalog.listMediaForIngredient(f.sourceId)).toEqual([expect.objectContaining({ ingredientId: f.sourceId, mediaKey: f.mediaKey, metadata: { prompt: 'Original example prompt' } })]);
    expect((await catalog.listRelationsForIngredient(f.survivorId)).outbound).toEqual([expect.objectContaining({ fromId: f.sourceId, toId: f.thirdId })]);
    expect((await catalog.listIngredientRevisions(f.survivorId)).items.map(row => row.ingredientId).sort()).toEqual([f.sourceId, f.survivorId].sort());
    expect((await catalog.getCatalogBundleForRef('universe', f.universeId)).ingredients).toEqual([]);
    const exported = (await catalog.exportSliceForRef('universe', f.universeId)).ingredients;
    expect(exported).toHaveLength(1);
    expect(exported[0]).toMatchObject({ id: f.sourceId, name: 'Original Example', originInstanceId: 'identity-test-local',
      refs: [expect.objectContaining({ ingredientId: f.sourceId, refId: f.universeId })],
      scraps: [],
      sources: [{ ingredientId: f.sourceId, scrapId: `${f.id}-missing-scrap`, span: { start: 3, end: 9 }, extractedAt: now }],
      media: [expect.objectContaining({ ingredientId: f.sourceId, mediaKey: f.mediaKey, metadata: { prompt: 'Original example prompt' }, retained: true })],
    });
    expect((await catalog.getIngredientChangesSince('0', 10000)).items.find(row => row.id === f.sourceId)?.name).toBe('Stale replica example');
  });

  it('refuses foreign and retained-original writes, including delayed attachments, while preserving contextual canon', async () => {
    const f = await fixture();
    expect(await getCatalogIdentityAccess(f.sourceId)).toMatchObject({ writable: false, reason: 'CATALOG_IDENTITY_RETAINED' });
    expect(await getCatalogIdentityAccess(f.survivorId)).toMatchObject({ writable: false, reason: 'CATALOG_IDENTITY_FOREIGN' });
    for (const change of [
      () => catalog.updateIngredient(f.survivorId, { name: 'Changed' }),
      () => catalog.attachMedia(f.survivorId, 'new.png', 'reference'),
      () => catalog.linkIngredientToRef(f.survivorId, 'universe', f.universeId, 'cast'),
      () => catalog.updateIngredient(f.sourceId, { name: 'Changed original' }),
    ]) await expect(change()).rejects.toMatchObject({ status: 409 });
    const updateUniverse = vi.fn();
    expect(await projectToCanon(f.sourceId, await catalog.getIngredient(f.sourceId), { updateUniverse })).toEqual({ universes: 0, written: 0, skipped: 1 });
    expect(updateUniverse).not.toHaveBeenCalled();
    expect(await projectToCatalog(f.universeId, { characters: [f.sourceId, f.survivorId].map(ingredientId => ({ ingredientId, name: 'Stale context', updatedAt: '2099-01-01T00:00:00Z' })) })).toEqual({ written: 0, skipped: 2 });
    expect((await query('SELECT id, name FROM catalog_ingredients WHERE id = $1', [f.sourceId])).rows[0]).toEqual({ id: f.sourceId, name: 'Original Example' });
  });

  it('allows only canonical-owner edits and refuses virtual evidence removal rather than reporting a no-op success', async () => {
    const f = await fixture({ owned: true });
    expect(await getCatalogIdentityAccess(f.survivorId)).toMatchObject({ writable: true });
    await catalog.updateIngredient(f.survivorId, { name: 'Owner revised example' });
    const remote = { ...(await catalog.getIngredient(f.survivorId)), name: 'Unverified peer edit', updatedAt: '2099-01-01T00:00:00Z' };
    expect(await catalog.upsertIngredientFromPeer(remote)).toMatchObject({ applied: false, protectedIdentity: true });
    expect(await catalog.upsertMediaFromPeer({ ingredientId: f.survivorId, mediaKey: 'peer.png', kind: 'reference', createdAt: now })).toMatchObject({ protectedIdentity: true });
    expect((await catalog.getIngredient(f.survivorId)).name).toBe('Owner revised example');
    await expect(catalog.updateIngredient(f.sourceId, { name: 'Wrong endpoint' })).rejects.toMatchObject({ code: 'CATALOG_IDENTITY_RETAINED' });
    await expect(catalog.detachMedia(f.survivorId, f.mediaKey, 'reference')).rejects.toMatchObject({ code: 'CATALOG_IDENTITY_RETAINED' });
    await expect(catalog.unlinkIngredientFromRef(f.survivorId, 'universe', f.universeId, 'cast')).rejects.toMatchObject({ code: 'CATALOG_IDENTITY_RETAINED' });
    await expect(catalog.unlinkIngredientRelation(f.survivorId, f.thirdId, 'knows')).rejects.toMatchObject({ code: 'CATALOG_IDENTITY_RETAINED' });
    await catalog.attachMedia(f.survivorId, 'own-new.png', 'reference');
    await catalog.detachMedia(f.survivorId, 'own-new.png', 'reference');
    expect((await catalog.listMediaForIngredient(f.survivorId)).map(row => row.mediaKey)).toEqual([f.mediaKey]);
    expect((await catalog.listIngredientRevisions(f.survivorId)).items.some(row => row.name === 'Owner revised example')).toBe(true);
  });

  it('keeps original canonical history across refreshed snapshots and does not resurrect owner-deleted media', async () => {
    const f = await fixture();
    await query('UPDATE catalog_identity_operations SET current_snapshot = $2::jsonb WHERE id = $1', [f.id, JSON.stringify({ ...plain(f.survivor), revisions: [] })]);
    expect((await catalog.listIngredientRevisions(f.survivorId)).items.some(row => row.id === `${f.id}-survivor-revision`)).toBe(true);
    const owned = await fixture({ owned: true });
    await query(`UPDATE catalog_identity_operations SET plan = jsonb_set(plan, '{survivor,media}', $2::jsonb) WHERE id = $1`, [owned.id, JSON.stringify([{ ...owned.source.media[0], ingredient_id: owned.survivorId, media_key: 'deleted-owner.png' }])]);
    expect((await catalog.listMediaForIngredient(owned.survivorId)).some(row => row.mediaKey === 'deleted-owner.png')).toBe(false);
  });

  it('shows unchosen original image and sheet pointers as attributed retained evidence', async () => {
    const f = await fixture({ owned: true });
    const archived = [f.sourceId, f.survivorId].map((ingredient_id, index) => ({
      ingredient_id, media_key: `unchosen-${index}.png`, kind: 'reference', role: index ? 'sheet:front' : 'archive:identity',
      caption: 'Preserved original pointer', metadata: {}, created_at: now, deleted: false,
    }));
    await query("UPDATE catalog_identity_operations SET plan = jsonb_set(plan, '{archivedMedia}', $2::jsonb) WHERE id = $1", [f.id, JSON.stringify(archived)]);
    const media = await catalog.listMediaForIngredient(f.survivorId);
    expect(media.filter(row => row.mediaKey.startsWith('unchosen-'))).toEqual(expect.arrayContaining([
      expect.objectContaining({ ingredientId: f.sourceId, mediaKey: 'unchosen-0.png', retained: true }),
      expect.objectContaining({ ingredientId: f.survivorId, mediaKey: 'unchosen-1.png', retained: true }),
    ]));
    await expect(catalog.detachMedia(f.survivorId, 'unchosen-1.png', 'reference')).rejects.toMatchObject({ code: 'CATALOG_IDENTITY_RETAINED' });
  });

  it('fences prepared writes and excludes both shared members from a local merge', async () => {
    for (const state of ['proposed', 'prepared', 'committed', 'recovery_prepared']) {
      const f = await fixture({ owned: true, state });
      await expect(mergeIngredients({ sourceId: f.survivorId, survivorId: f.thirdId })).rejects.toMatchObject({ code: 'CATALOG_IDENTITY_OVERLAP' });
      if (state === 'prepared' || state === 'recovery_prepared') {
        await expect(catalog.attachMedia(f.survivorId, 'blocked.png', 'reference')).rejects.toMatchObject({ code: 'CATALOG_IDENTITY_FENCED' });
      }
    }
  });

  it.each([['prepared', 'aborted'], ['recovery_prepared', 'recovered']])('retries a peer update held during %s after %s', async (state, terminal) => {
    const f = await fixture({ state });
    const row = (await query('SELECT * FROM catalog_ingredients WHERE id = $1', [f.survivorId])).rows[0];
    const incoming = { id: row.id, type: row.type, name: 'Owner edit after unfreeze', payload: row.payload,
      originInstanceId: row.origin_instance_id, createdAt: row.created_at.toISOString(), updatedAt: '2099-01-01T00:00:00Z' };
    expect(await catalog.upsertIngredientFromPeer(incoming)).toMatchObject({ identityPending: true, applied: false });
    const media = { ingredientId: row.id, mediaKey: 'late-reference.png', kind: 'reference', createdAt: now };
    expect(await catalog.upsertMediaFromPeer(media)).toMatchObject({ identityPending: true, applied: false });
    await query('UPDATE catalog_identity_operations SET state = $2 WHERE id = $1', [f.id, terminal]);
    expect(await catalog.upsertIngredientFromPeer(incoming)).toMatchObject({ applied: true });
    await catalog.upsertMediaFromPeer(media);
    expect((await catalog.getIngredient(f.survivorId)).name).toBe(incoming.name);
    expect((await catalog.listMediaForIngredient(f.survivorId)).some(item => item.mediaKey === media.mediaKey)).toBe(true);
  });
});
