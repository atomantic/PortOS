import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const db = vi.hoisted(() => ({ state: null, failMedia: false, access: null }));
vi.mock('../lib/db.js', () => {
  const query = async (sql, params = []) => {
    const state = db.state;
    if (sql.includes('INSERT INTO catalog_commit_receipts')) {
      if (state.receipts[params[0]]) return { rows: [], rowCount: 0 };
      state.receipts[params[0]] = { fingerprint: params[1], ingredients: null };
      return { rows: [{ operation_key: params[0] }], rowCount: 1 };
    }
    if (sql.includes('SELECT fingerprint, ingredients')) return { rows: [structuredClone(state.receipts[params[0]])] };
    if (sql.includes('UPDATE catalog_commit_receipts')) {
      state.receipts[params[0]].ingredients = JSON.parse(params[1]);
      return { rows: [] };
    }
    if (sql.includes('FROM catalog_identity_read_refs')) return { rows: state.refs.filter((ref) => ref.ingredientId === params[0] && !ref.deleted)
      .map((ref) => ({ ...ref, resolved: !!state.universes[ref.refId] })) };
    if (sql.includes('SELECT id FROM universes')) return { rows: state.universes[params[0]] ? [{ id: params[0] }] : [] };
    if (sql.includes('SELECT id, name AS name FROM universes')) return { rows: params[0].filter((id) => state.universes[id]).map((id) => ({ id, name: state.universes[id] })) };
    if (sql.includes('SELECT type FROM catalog_ingredients')) return { rows: state.ingredients[params[0]] ? [{ type: state.ingredients[params[0]].type }] : [] };
    if (sql.includes('SELECT id FROM catalog_ingredients')) return { rows: state.ingredients[params[0]] ? [{ id: params[0] }] : [] };
    if (sql.includes('UPDATE catalog_ingredient_refs')) {
      state.refs = state.refs.map((ref) => ref.ingredientId === params[0] && ref.role === params[1] && ref.refId !== params[2] ? { ...ref, deleted: true } : ref);
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO catalog_ingredient_relations')) {
      state.relations.push({ fromId: params[0], toId: params[1], kind: 'forked-from' });
      return { rows: [] };
    }
    if (sql.includes('FROM catalog_identity_read_media')) return { rows: state.media
      .filter((media) => media.ingredientId === params[0] && !media.deleted && ['portrait', 'reference'].includes(media.kind))
      .map((media) => ({ media_key: media.mediaKey, kind: media.kind, caption: media.caption ?? null, metadata: {}, library: structuredClone(media.library || {}) })) };
    if (sql.includes('INSERT INTO catalog_ingredient_media')) {
      if (db.failMedia) throw new Error('Attachment write failed');
      state.media.push({ ingredientId: params[0], mediaKey: params[1], kind: params[2], role: 'fork-reference', caption: params[3], library: JSON.parse(params[5]) });
      return { rows: [] };
    }
    throw new Error(`Unexpected test query: ${sql.slice(0, 80)}`);
  };
  return { query, withTransaction: async (work) => {
    const before = structuredClone(db.state);
    return work({ query }).catch((error) => { db.state = before; throw error; });
  } };
});
vi.mock('../services/catalogDB/ingredients.js', async () => {
  const { sanitizeBiblePayload } = await import('../services/catalogDB/shared.js');
  return {
    getIngredient: async (id) => structuredClone(db.state.ingredients[id] || null),
    getIngredientIdentityIds: async (id) => [id],
    createIngredient: async (input, options) => {
      const ingredient = { ...structuredClone(input), id: input.id || `cat-${input.type}-new`,
        payload: sanitizeBiblePayload(input.type, input.name, input.payload), syncSequence: '1' };
      db.state.ingredients[ingredient.id] = ingredient;
      db.state.revisions.push({ ingredientId: ingredient.id, actor: options.actor, payload: structuredClone(ingredient.payload) });
      return ingredient;
    },
  };
});
vi.mock('../services/catalogDB/identityAccess.js', () => ({ assertCatalogIdentityWritable: async (id) => id, getCatalogIdentityAccess: async () => db.access }));
vi.mock('../services/catalogDB/refs.js', () => ({
  linkIngredientToRef: async (ingredientId, refKind, refId, role) => {
    const existing = db.state.refs.find((ref) => ref.ingredientId === ingredientId && ref.refKind === refKind && ref.refId === refId && ref.role === role);
    if (existing) existing.deleted = false;
    else db.state.refs.push({ ingredientId, refKind, refId, role });
  },
  unlinkIngredientFromRef: async () => {},
}));
vi.mock('../services/catalogPrimitiveUsage.js', () => ({ listPrimitiveUsages: async () => [] }));
vi.mock('../services/universeBuilder.js', () => ({
  updateUniverse: async (id, mutator, { afterWrite }) => {
    const { withTransaction } = await import('../lib/db.js');
    if (!db.state.canon[id]) throw Object.assign(new Error(`Universe not found: ${id}`), { code: 'NOT_FOUND' });
    return withTransaction(async (client) => {
      const current = db.state.canon[id];
      const patch = await mutator(structuredClone(current), { client });
      if (patch) Object.assign(current, patch);
      await afterWrite(current, { client });
      return current;
    });
  },
}));

import router from './catalogPrimitives.js';
import { createOwnedPrimitive } from '../services/catalogPrimitives.js';
import { BIBLE_LIMITS } from '../lib/storyBible.js';

const app = express();
app.use(express.json());
app.use('/api/catalog/ingredients/:id', router);
app.use(errorMiddleware);
const path = '/api/catalog/ingredients/cat-chr-source';
const operationKey = 'd48e7a1a-3f88-42a7-93ab-a2650562a290';

beforeEach(() => {
  db.failMedia = false;
  db.access = null;
  db.state = { universes: { first: 'First universe', second: 'Second universe' }, canon: { first: { characters: [] }, second: { characters: [] } },
    receipts: {}, relations: [], revisions: [],
    refs: [{ ingredientId: 'cat-chr-source', refKind: 'universe', refId: 'first', role: 'owner' }],
    ingredients: { 'cat-chr-source': { id: 'cat-chr-source', type: 'character', name: 'Example courier', tags: [], syncSequence: '72',
      payload: { physicalDescription: 'A blue coat.', locked: true, voiceId: 'local-voice', voiceCanon: { description: 'Quiet', approved: true },
        identityPack: { assets: [{ role: 'neutral', imageRef: 'coat.png', approved: true }] }, imageRefs: ['coat.png'], primaryImageRef: 'coat.png',
        props: [{ id: 'prop-1', name: 'Satchel', imageRef: 'satchel.png' }],
        forms: [{ id: 'older', label: 'Older' }], wardrobes: [{ id: 'outfit', name: 'Winter' }],
        relationshipLinks: [{ targetCharacterId: 'other', type: 'ally' }], sourceSeriesId: 'source-series',
        referenceSheets: { standard: 'sheet.png' }, referenceSheetRequests: { standard: 'running' },
        exportConsent: true, sessionId: 'session', providerId: 'provider' } } },
    media: [{ ingredientId: 'cat-chr-source', mediaKey: 'coat.png', kind: 'portrait', role: 'approved', library: { guide: true } },
      { ingredientId: 'cat-chr-source', mediaKey: 'voice.wav', kind: 'audio' }],
  };
});

describe('creative primitive ownership and forks', () => {
  it('stages ambiguous legacy uses, explicitly resolves ownership, and preserves existing identities and links', async () => {
    db.state.refs[0].role = 'canon-character';
    db.state.refs.push({ ingredientId: 'cat-chr-source', refKind: 'universe', refId: 'second', role: 'reference' });
    const before = structuredClone(db.state.ingredients);
    const preview = await request(app).get(`${path}/universe-context`);
    expect(preview.body).toMatchObject({ status: 'needs-review', owner: null, candidates: expect.any(Array) });
    const result = await request(app).put(`${path}/owner`).send({ universeId: 'second' });
    expect(result.status).toBe(200);
    expect(result.body.owner).toMatchObject({ refId: 'second', refName: 'Second universe' });
    expect(db.state.ingredients).toEqual(before);
    expect(db.state.refs.filter((ref) => ref.role !== 'owner')).toHaveLength(2);
  });

  it('refuses an implicit ownership move and a new cross-universe mutable link', async () => {
    const result = await request(app).put(`${path}/owner`).send({ universeId: 'second' });
    expect(result.status).toBe(409);
    expect(db.state.refs).toHaveLength(1);
  });

  it('forks independent identity and image associations, resets approvals/bindings, and replays the original result', async () => {
    const before = structuredClone(db.state.ingredients['cat-chr-source']);
    const input = { universeId: 'second', copyImages: true, operationKey };
    const result = await request(app).post(`${path}/fork`).send(input);
    expect(result.status).toBe(201);
    const fork = result.body;
    expect(fork.id).not.toBe(before.id);
    expect(fork.payload.voiceCanon.approved).toBe(false);
    expect(fork.payload.identityPack.assets[0].approved).toBe(false);
    expect(fork.payload.forms[0].id).not.toBe('older');
    expect(fork.payload.wardrobes[0].id).not.toBe('outfit');
    for (const field of ['voiceId', 'sourceSeriesId', 'exportConsent', 'sessionId', 'providerId']) expect(fork.payload[field]).toBeFalsy();
    expect(fork.payload.referenceSheets).toEqual({});
    expect(fork.payload.referenceSheetRequests).toEqual({});
    expect(fork.payload.relationshipLinks).toEqual([]);
    expect(db.state.ingredients[before.id]).toEqual(before);
    expect(db.state.relations).toEqual([{ fromId: fork.id, toId: before.id, kind: 'forked-from' }]);
    expect(db.state.revisions[0].actor).toBe('fork:cat-chr-source@72');
    expect(db.state.media.filter((media) => media.ingredientId === fork.id)).toEqual([
      expect.objectContaining({ mediaKey: 'coat.png', kind: 'portrait', library: { guide: true } }),
    ]);
    // The fork is a canon member of its universe, so its record page has a writable canon binding.
    expect(db.state.canon.second.characters).toEqual([expect.objectContaining({ ingredientId: fork.id, name: fork.name, locked: false })]);
    expect(db.state.refs).toContainEqual({ ingredientId: fork.id, refKind: 'universe', refId: 'second', role: 'canon-character' });
    db.state.ingredients[before.id].payload.physicalDescription = 'Later source edit';
    const replay = await request(app).post(`${path}/fork`).send(input);
    expect(replay.body).toEqual(fork);
    expect(Object.keys(db.state.ingredients)).toHaveLength(2);
    expect(db.state.canon.second.characters).toHaveLength(1);
    const mismatch = await request(app).post(`${path}/fork`).send({ ...input, name: 'Different submission' });
    expect(mismatch.status).toBe(409);
  });

  it('copies no assets by default and rolls back a failed attachment operation', async () => {
    const textOnly = await request(app).post(`${path}/fork`).send({ universeId: 'second', operationKey });
    expect(textOnly.body.payload.imageRefs).toEqual([]);
    expect(textOnly.body.payload.props[0].imageRef).toBeFalsy();
    expect(textOnly.body.payload.props[0].id).not.toBe('prop-1');
    expect(db.state.media).toHaveLength(2);
    const before = structuredClone(db.state);
    db.failMedia = true;
    const failed = await request(app).post(`${path}/fork`).send({ universeId: 'second', copyImages: true, operationKey: 'b0d52efa-a06a-47b8-81aa-393ea39c83f4' });
    expect(failed.status).toBe(500);
    expect(db.state).toEqual(before);
  });

  it('forks readable foreign and retained identities without granting writes, but refuses pending transitions', async () => {
    const before = structuredClone(db.state.ingredients['cat-chr-source']);
    for (const [reason, key] of [
      ['CATALOG_IDENTITY_FOREIGN', '3c4a1494-32a5-4d51-9d56-d7bad695f675'],
      ['CATALOG_IDENTITY_RETAINED', '755fe69a-b840-46ed-8b4a-5fc84382d098'],
    ]) {
      db.access = { writable: false, reason };
      const response = await request(app).post(`${path}/fork`).send({ universeId: 'second', operationKey: key });
      expect(response.status).toBe(201);
      expect(response.body.id).not.toBe(before.id);
      expect(db.state.ingredients[before.id]).toEqual(before);
    }
    db.access = { writable: false, reason: 'CATALOG_IDENTITY_FENCED' };
    const snapshot = structuredClone(db.state);
    const result = await request(app).post(`${path}/fork`).send({ universeId: 'second', operationKey: 'b27b9806-9984-42ae-9c5f-419249ea4121' });
    expect(result.status).toBe(409);
    expect(result.body.code).toBe('CATALOG_IDENTITY_FENCED');
    expect(db.state).toEqual(snapshot);
  });

  it('creates an independent same-universe redesign without changing its source or production uses', async () => {
    const before = structuredClone(db.state.ingredients['cat-chr-source']);
    const response = await request(app).post(`${path}/fork`).send({ universeId: 'first', name: 'Courier redesign', copyImages: true, operationKey });
    expect(response.status).toBe(201);
    expect(response.body.id).not.toBe(before.id);
    expect(response.body.name).toBe('Courier redesign');
    expect(db.state.ingredients[before.id]).toEqual(before);
    expect(db.state.refs).toContainEqual({ ingredientId: response.body.id, refKind: 'universe', refId: 'first', role: 'owner' });
    expect(db.state.relations).toContainEqual({ fromId: response.body.id, toId: before.id, kind: 'forked-from' });
  });

  it('seeds a redesign fork with only the picked images, their ages re-keyed, and the redesigned fields', async () => {
    const source = db.state.ingredients['cat-chr-source'];
    source.payload.imageRefs = ['coat.png', 'young.png', 'canon-only.png'];
    db.state.media.push(
      { ingredientId: 'cat-chr-source', mediaKey: 'young.png', kind: 'reference', role: 'upload', caption: 'At seven',
        library: { variant: { formId: 'older', age: 7, wardrobeId: 'outfit' }, likeness: false, review: { status: 'good' }, tags: ['rink'] } },
      { ingredientId: 'cat-chr-source', mediaKey: 'teen.png', kind: 'reference', role: 'upload', library: { variant: { age: 17 } } },
    );
    const before = structuredClone(db.state.ingredients['cat-chr-source']);
    const response = await request(app).post(`${path}/fork`).send({ universeId: 'first', name: 'Courier v2', seedImages: ['young.png', 'canon-only.png'],
      fields: { physicalDescription: 'A red coat.' }, operationKey });
    expect(response.status).toBe(201);
    const fork = response.body;
    expect(fork.payload.physicalDescription).toBe('A red coat.');
    expect(fork.payload.imageRefs).toEqual(['young.png', 'canon-only.png']);
    expect(fork.payload.primaryImageRef).toBe('young.png');
    expect(fork.payload.identityPack?.assets ?? []).toEqual([]);
    expect(db.state.media.filter((media) => media.ingredientId === fork.id)).toEqual([{ ingredientId: fork.id, mediaKey: 'young.png', kind: 'reference',
      role: 'fork-reference', caption: 'At seven', library: { variant: { formId: fork.payload.forms[0].id, age: 7, wardrobeId: fork.payload.wardrobes[0].id },
        tags: ['rink'], likeness: false, guide: false } }]);
    expect(db.state.ingredients[before.id]).toEqual(before);
  });

  it('refuses a fork whose picked image left the source or whose field is not a redesign field, writing nothing', async () => {
    const before = structuredClone(db.state);
    const missing = await request(app).post(`${path}/fork`).send({ universeId: 'first', seedImages: ['gone.png'], operationKey });
    expect(missing.status).toBe(409);
    expect(missing.body.code).toBe('CATALOG_FORK_SEED_MISSING');
    const field = await request(app).post(`${path}/fork`).send({ universeId: 'first', fields: { voiceId: 'x' }, operationKey: 'b0d52efa-a06a-47b8-81aa-393ea39c83f4' });
    expect(field.status).toBe(400);
    expect(db.state).toEqual(before);
  });

  it('refuses a fork into a full canon bucket, writing nothing', async () => {
    db.state.canon.first.characters = Array.from({ length: BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX }, (_, index) => ({ id: `character-${index}`, name: `Extra ${index}` }));
    const before = structuredClone(db.state);
    const response = await request(app).post(`${path}/fork`).send({ universeId: 'first', operationKey });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('UNIVERSE_CANON_FULL');
    expect(db.state).toEqual(before);
  });

  it('validates the public request before any write and requires a real destination', async () => {
    const before = structuredClone(db.state);
    expect((await request(app).post(`${path}/fork`).send({ universeId: 'second' })).status).toBe(400);
    expect((await request(app).post(`${path}/fork`).send({ universeId: 'missing', operationKey })).status).toBe(404);
    expect(db.state).toEqual(before);
  });

  it('uses the same explicit ownership contract for a non-bible creative type', async () => {
    const idea = await createOwnedPrimitive({ type: 'idea', name: 'Example premise', payload: { summary: 'A small idea.' }, tags: [] }, 'second', operationKey);
    expect(idea.payload.summary).toBe('A small idea.');
    expect(db.state.refs).toContainEqual({ ingredientId: idea.id, refKind: 'universe', refId: 'second', role: 'owner' });
  });
});
