/**
 * setIngredientPayloadKey writes ONE payload key under the row lock, and a later
 * whole-payload save (the profile form) keeps a place's greybox through the
 * bible sanitizer. `*.db.test.js` → runs ONLY via `npm run test:db` against
 * `portos_test`; every row is scoped to this run's nonce.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';

const { checkHealth, close, ensureSchema, query } = await import('../../lib/db.js');
const { requireDbOrSkip } = await import('../../lib/dbTestGate.js');
const { createIngredient, getIngredient, setIngredientLock, setIngredientPayloadKey, updateIngredient, updateIngredientPayloadKeys } = await import('./ingredients.js');

const health = await checkHealth().catch((error) => ({ connected: false, error: error.message }));
const ready = requireDbOrSkip('services/catalogDB/payloadKey.db.test', health.connected, health.error);
if (ready) await ensureSchema();

const P = `pkey-${randomUUID()}`;
const scene = { version: 1, source: 'spec', parts: [{ id: 'floor', type: 'box', size: [4, 0.1, 4] }], shots: [] };

afterAll(async () => {
  if (ready) await query('DELETE FROM catalog_ingredients WHERE id LIKE $1', [`${P}%`]);
  await close();
});

describe.skipIf(!ready)('setIngredientPayloadKey', () => {
  it('sets, survives a whole-payload profile save, and clears one key without touching the rest', async () => {
    const created = await createIngredient({ id: `${P}-plc`, type: 'place', name: 'Rink', payload: { description: 'Roller rink' } });
    const set = await setIngredientPayloadKey(created.id, 'greybox', scene, { source: 'refine' });
    expect(set.payload).toMatchObject({ description: 'Roller rink', greybox: { parts: [{ id: 'floor' }] } });

    // The profile form saves the whole payload through the sanitizer.
    const saved = await updateIngredient(created.id, { payload: { ...set.payload, notes: 'edited' } });
    expect(saved.payload.greybox).toMatchObject({ source: "spec", parts: [{ id: "floor" }] });

    const cleared = await setIngredientPayloadKey(created.id, 'greybox', null);
    expect(cleared.payload).not.toHaveProperty('greybox');
    expect(cleared.payload.notes).toBe('edited');
  });

  it('normalizes a valid greybox and drops a malformed one on ordinary writes', async () => {
    const place = await createIngredient({ id: `${P}-ord`, type: 'place', name: 'Ordinary', payload: { description: 'd' } });
    const normalized = await updateIngredient(place.id, { payload: { description: 'd', greybox: { parts: [{ id: 'f', type: 'box', size: [1, 1, 1] }] } } });
    expect(normalized.payload.greybox).toMatchObject({ version: 1, source: 'spec', zones: [], parts: [{ id: 'f', position: [0, 0, 0] }] });
    const dropped = await updateIngredient(place.id, { payload: { description: 'd', greybox: { parts: 'bad' } } });
    expect(dropped.payload).not.toHaveProperty('greybox');
  });

  it('keeps a photoreal look on a place with no canon link through a profile save, and drops a malformed one (#14946)', async () => {
    const created = await createIngredient({ id: `${P}-look`, type: 'place', name: 'Unlinked', payload: { description: 'd' } });
    const look = { version: 1, materials: [], lights: [{ id: 'key', type: 'point', position: [0, 3, 0], watts: 100 }] };
    const set = await setIngredientPayloadKey(created.id, 'photoreal', look);
    const saved = await updateIngredient(created.id, { payload: { ...set.payload, notes: 'edited' } });
    expect(saved.payload.photoreal.lights).toEqual([expect.objectContaining({ id: 'key', watts: 100 })]);
    const dropped = await updateIngredient(created.id, { payload: { description: 'd', photoreal: { materials: 'bad' } } });
    expect(dropped.payload).not.toHaveProperty('photoreal');
  });

  it('keeps a town map through a profile save, and drops a malformed one', async () => {
    const created = await createIngredient({ id: `${P}-town`, type: 'place', name: 'Town', payload: { description: 'd' } });
    const town = { version: 1, seed: 3, sets: [], streets: [{ id: 'main', kind: 'road', sides: 'houses', width: 9, points: [[0, 0], [100, 0]] }] };
    const set = await setIngredientPayloadKey(created.id, 'town', town);
    const saved = await updateIngredient(created.id, { payload: { ...set.payload, notes: 'edited' } });
    expect(saved.payload.town).toEqual(town);
    const dropped = await updateIngredient(created.id, { payload: { description: 'd', town: { ...town, streets: 'bad' } } });
    expect(dropped.payload).not.toHaveProperty('town');
  });

  it('keeps the lock behavior: type guard and idempotent write', async () => {
    const place = await createIngredient({ id: `${P}-lock`, type: 'place', name: 'Lockable' });
    await setIngredientLock(place.id, true);
    expect((await getIngredient(place.id)).payload.locked).toBe(true);
    const idea = await createIngredient({ id: `${P}-idea`, type: 'idea', name: 'Idea' });
    await expect(setIngredientLock(idea.id, true)).rejects.toMatchObject({ status: 400 });
  });

  it('returns null for a missing row', async () => {
    expect(await setIngredientPayloadKey(`${P}-gone`, 'greybox', scene)).toBeNull();
  });
});

describe.skipIf(!ready)('updateIngredientPayloadKeys', () => {
  it('applies several keys from the locked payload in one write and reports the prior clock', async () => {
    const created = await createIngredient({ id: `${P}-chr`, type: 'character', name: 'Example Hero',
      payload: { referenceSheetImageRef: 'a.png', referenceSheets: { profile: 'b.png' } } });
    const { ingredient, priorUpdatedAt } = await updateIngredientPayloadKeys(created.id, (payload) => ({
      referenceSheetImageRef: null, referenceSheets: { ...payload.referenceSheets, extra: 'c.png' },
    }));
    expect(priorUpdatedAt).toBe(created.updatedAt);
    expect(ingredient.payload).not.toHaveProperty('referenceSheetImageRef');
    expect(ingredient.payload.referenceSheets).toEqual({ profile: 'b.png', extra: 'c.png' });
  });

  it('writes nothing when the guard or updater refuses', async () => {
    const created = await createIngredient({ id: `${P}-ref`, type: 'character', name: 'Refused', payload: { referenceSheetImageRef: 'a.png' } });
    await expect(updateIngredientPayloadKeys(created.id, () => { throw Object.assign(new Error('changed'), { status: 409 }); }))
      .rejects.toMatchObject({ status: 409 });
    await expect(updateIngredientPayloadKeys(created.id, () => ({ referenceSheetImageRef: null }), {
      guard: () => { throw Object.assign(new Error('locked'), { status: 409 }); },
    })).rejects.toMatchObject({ status: 409 });
    expect((await getIngredient(created.id)).payload.referenceSheetImageRef).toBe('a.png');
    expect(await updateIngredientPayloadKeys(`${P}-gone`, () => ({}))).toBeNull();
  });
});
