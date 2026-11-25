import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ world: null, refs: [], readonly: false, retained: false,
  missing: false, storeError: null, linkGate: null, linkStarted: null, queued: null,
  ingredientName: '', writes: 0, tail: Promise.resolve() }));

vi.mock('../../lib/db.js', () => ({
  query: async (sql, params) => {
    if (sql.includes('FROM catalog_identity_read_refs')) return { rows: state.refs.filter((ref) => ref.ingredientId === params[0] && !ref.deleted) };
    if (sql.includes('SELECT id FROM universes')) return { rows: state.missing ? [] : [{ id: params[0] }] };
    if (sql.includes('SELECT type FROM catalog_ingredients')) return { rows: [{ type: 'character' }] };
    if (sql.includes('INSERT INTO catalog_commit_receipts')) return { rowCount: 1 };
    if (sql.includes('FOR SHARE') || sql.includes('INSERT INTO catalog_ingredient_relations')
      || sql.includes('UPDATE catalog_commit_receipts')) return { rows: [] };
    throw new Error(`Unexpected membership query: ${sql}`);
  },
  withTransaction: async () => { throw new Error('Membership must use the universe store queue'); },
}));
vi.mock('../catalogDB/ingredients.js', () => ({
  getIngredient: async (id) => ({ id, type: 'character', name: state.ingredientName,
    payload: { physicalDescription: 'A coat' }, updatedAt: '2026-10-01T00:00:00.000Z' }),
  getIngredientIdentityIds: async (id) => [id, `${id}-alias`],
  createIngredient: async (input) => ({ ...input, id: input.id ?? 'new-primitive' }),
}));
vi.mock('../catalogDB/identityAccess.js', () => ({
  getCatalogIdentityAccess: async () => null,
  assertCatalogIdentityWritable: async (id) => {
    if (state.readonly) throw Object.assign(new Error('Identity is retained'), { code: 'CATALOG_IDENTITY_RETAINED', status: 409 });
    return id;
  },
  assertCatalogAssociationRemovable: async () => {
    if (state.retained) throw Object.assign(new Error('Association is retained'), { code: 'CATALOG_IDENTITY_RETAINED', status: 409 });
  },
}));
vi.mock('../catalogDB/refs.js', () => ({
  linkIngredientRelation: vi.fn(),
  linkIngredientToRef: async (ingredientId, refKind, refId, role) => {
    state.linkStarted?.resolve();
    if (state.linkGate) await state.linkGate.promise;
    const previous = state.refs.find((ref) => ref.ingredientId === ingredientId && ref.refKind === refKind && ref.refId === refId && ref.role === role);
    if (previous) previous.deleted = false;
    else state.refs.push({ ingredientId, refKind, refId, role });
  },
  unlinkIngredientFromRef: async (ingredientId, refKind, refId, role) => {
    for (const ref of state.refs) {
      if (ref.ingredientId === ingredientId && ref.refKind === refKind && ref.refId === refId && ref.role === role) ref.deleted = true;
    }
  },
}));
vi.mock('./catalogRefResolver.js', () => ({ describeCatalogRefs: async (refs) => refs }));
vi.mock('./catalogPrimitiveUsage.js', () => ({ assertCanonRemovable: vi.fn() }));
vi.mock('./catalogEvents.js', () => ({ catalogEvents: { emit: vi.fn() } }));
vi.mock('../universeBuilder.js', () => ({
  // The store owns its write queue. In particular, afterWrite must finish
  // before the next mutator reads the persisted record, even on no-op retries.
  updateUniverse: vi.fn((id, mutate, options = {}) => {
    state.queued?.resolve();
    const task = state.tail.then(async () => {
      if (state.storeError) throw state.storeError;
      if (state.missing) throw Object.assign(new Error('Universe not found'), { code: 'NOT_FOUND' });
      const client = options.transactional ? { query: (sql, params) => query(sql, params) } : null;
      const patch = await mutate(structuredClone(state.world), { client });
      if (patch) { state.world = { ...state.world, ...patch }; state.writes += 1; }
      await options.afterWrite?.(state.world, { client });
      return structuredClone(state.world);
    });
    state.tail = task.catch(() => {});
    return task;
  }),
}));

import { addPrimitiveToUniverse, createOwnedPrimitive, forkPrimitive, removePrimitiveFromUniverse } from './catalogPrimitives.js';
import { query } from '../../lib/db.js';
import { updateUniverse } from '../universeBuilder.js';
import { BIBLE_LIMITS } from '../../lib/bibleLimits.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const canonRef = () => ({ ingredientId: 'primitive', refKind: 'universe', refId: 'world', role: 'canon-character' });
const activeCanonRefs = () => state.refs.filter((ref) => ref.role === 'canon-character' && !ref.deleted);

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, { world: { id: 'world', characters: [] },
    refs: [{ ingredientId: 'primitive', refKind: 'universe', refId: 'world', role: 'owner' }],
    readonly: false, retained: false, missing: false, storeError: null,
    linkGate: null, linkStarted: null, queued: null, ingredientName: 'Example character', writes: 0, tail: Promise.resolve() });
});

describe('creative primitive universe membership', () => {
  it('reads the current ingredient after entering the universe write queue and guards catalog projection', async () => {
    state.world.places = [{ id: 'canon-place', ingredientId: 'existing-place' }];
    const turn = deferred();
    state.tail = turn.promise;
    state.queued = deferred();
    const add = addPrimitiveToUniverse('primitive', 'world', 'canon-character');
    await state.queued.promise;
    state.ingredientName = 'Edited while queued';
    turn.resolve();

    const result = await add;
    expect(result.universe.characters).toMatchObject([{ ingredientId: 'primitive', name: 'Edited while queued' }]);
    expect(updateUniverse).toHaveBeenCalledWith('world', expect.any(Function), expect.objectContaining({
      transactional: true,
      canonProjectionGuard: 'primitive',
      canonProjectionIdentityIds: expect.arrayContaining(['primitive', 'primitive-alias', 'existing-place']),
    }));
  });

  it.each([
    ['create', () => createOwnedPrimitive({ type: 'character', name: 'New character' }, 'world')],
    ['fork', () => forkPrimitive('primitive', { universeId: 'world', operationKey: 'fork-key' })],
  ])('guards the %s identity and every existing canon bucket', async (_operation, save) => {
    state.world.characters = [{ id: 'canon-character', ingredientId: 'primitive' }];
    state.world.places = [{ id: 'canon-place', ingredientId: 'existing-place' }];
    state.world.objects = [{ id: 'canon-object', ingredientId: 'existing-object' }];
    const { id } = await save();

    expect(state.world.characters.at(-1).ingredientId).toBe(id);
    expect(new Set(updateUniverse.mock.calls[0][2].canonProjectionIdentityIds)).toEqual(new Set([
      id, `${id}-alias`, 'primitive', 'existing-place', 'existing-object',
    ]));
  });

  it('guards the removed identity and remaining canon', async () => {
    state.world.characters = [{ id: 'canon-character', ingredientId: 'primitive-alias' }];
    state.world.places = [{ id: 'canon-place', ingredientId: 'existing-place' }];
    state.refs.push(canonRef());

    await removePrimitiveFromUniverse('primitive', 'world', 'canon-character');

    expect(state.world.characters).toEqual([]);
    expect(activeCanonRefs()).toEqual([]);
    expect(new Set(updateUniverse.mock.calls[0][2].canonProjectionIdentityIds)).toEqual(new Set([
      'primitive', 'primitive-alias', 'existing-place',
    ]));
  });

  it('serializes an overlapping removal after the add association finishes', async () => {
    state.linkGate = deferred();
    state.linkStarted = deferred();
    const add = addPrimitiveToUniverse('primitive', 'world', 'canon-character');
    await state.linkStarted.promise;
    state.queued = deferred();
    const remove = removePrimitiveFromUniverse('primitive', 'world', 'canon-character');
    await state.queued.promise;
    state.linkGate.resolve();
    await Promise.all([add, remove]);
    expect(state.world.characters).toEqual([]);
    expect(activeCanonRefs()).toEqual([]);
    expect(state.refs.find((ref) => ref.role === 'owner').deleted).not.toBe(true);
  });

  it('repairs a missing association on a no-op retry without duplicating alias canon', async () => {
    state.world.characters = [{ id: 'canon-existing', ingredientId: 'primitive-alias', name: 'Example character' }];
    await addPrimitiveToUniverse('primitive', 'world', 'canon-character');
    await addPrimitiveToUniverse('primitive', 'world', 'canon-character');
    expect(state.world.characters).toEqual([{ id: 'canon-existing', ingredientId: 'primitive-alias', name: 'Example character' }]);
    expect(state.writes).toBe(0);
    expect(activeCanonRefs()).toEqual([expect.objectContaining(canonRef())]);
  });

  it('refuses protected identities and retained associations before changing canon', async () => {
    state.readonly = true;
    await expect(addPrimitiveToUniverse('primitive', 'world', 'canon-character')).rejects.toMatchObject({ code: 'CATALOG_IDENTITY_RETAINED' });
    expect(updateUniverse).not.toHaveBeenCalled();
    state.readonly = false;
    state.retained = true;
    state.world.characters = [{ id: 'canon-existing', ingredientId: 'primitive' }];
    await expect(removePrimitiveFromUniverse('primitive', 'world', 'canon-character')).rejects.toMatchObject({ code: 'CATALOG_IDENTITY_RETAINED' });
    expect(updateUniverse).not.toHaveBeenCalled();
    expect(state.world.characters).toHaveLength(1);
  });

  it('does not promote an ordinary cross-universe reference into mutable canon', async () => {
    state.refs.push({ ingredientId: 'primitive', refKind: 'universe', refId: 'other-world', role: 'reference' });
    await expect(addPrimitiveToUniverse('primitive', 'other-world', 'canon-character')).rejects.toMatchObject({ code: 'CATALOG_UNIVERSE_CONFLICT' });
    expect(updateUniverse).not.toHaveBeenCalled();
    expect(state.world.characters).toEqual([]);
  });

  it('refuses a full canon container instead of leaving a reference to a discarded entry', async () => {
    state.world.characters = Array.from({ length: BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX }, (_, index) => ({
      id: `canon-${index}`, ingredientId: `existing-${index}`, name: `Existing ${index}`,
    }));
    const before = structuredClone(state.world);
    await expect(addPrimitiveToUniverse('primitive', 'world', 'canon-character')).rejects.toMatchObject({ status: 409 });
    expect(state.world).toEqual(before);
    expect(activeCanonRefs()).toEqual([]);
  });

  it('can explicitly remove a dangling canon association without hiding unrelated store failures', async () => {
    state.refs.push(canonRef());
    state.missing = true;
    await removePrimitiveFromUniverse('primitive', 'world', 'canon-character');
    expect(activeCanonRefs()).toEqual([]);
    state.missing = false;
    state.refs.push(canonRef());
    state.storeError = new Error('Store unavailable');
    await expect(removePrimitiveFromUniverse('primitive', 'world', 'canon-character')).rejects.toThrow('Store unavailable');
    expect(activeCanonRefs()).toHaveLength(1);
  });
});
