/**
 * Real Postgres regression tests for overlapping local portrait replacements.
 * Query barriers hold one replacement after demotion while another writer
 * reaches the row lock; no sleeps or simulated SQL locking semantics.
 */
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

let intercept = null;
vi.mock('../lib/db.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    withTransaction: (fn) => actual.withTransaction((client) => fn({
      query: async (sql, params) => {
        const after = await intercept?.(sql, params);
        const result = await client.query(sql, params);
        await after?.();
        return result;
      },
    })),
  };
});
vi.mock('./mediaJobQueue/index.js', () => ({ mediaJobEvents: new EventEmitter() }));
vi.mock('./catalogMedia.js', () => ({
  readImageGenerationMetadata: async () => ({ prompt: 'Example portrait', seed: 42 }),
}));

const { checkHealth, ensureSchema, close, query } = await import('../lib/db.js');
const { requireDbOrSkip } = await import('../lib/dbTestGate.js');
const catalogDB = await import('./catalogDB.js');
const { mediaJobEvents } = await import('./mediaJobQueue/index.js');
const hook = await import('./catalogImageAttachHook.js');

const health = await checkHealth();
if (health.connected) await ensureSchema();
const runDb = requireDbOrSkip('catalogDB.media.db.test', health.connected, health.error);
const ids = [];
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

async function ingredient() {
  const row = await catalogDB.createIngredient({ type: 'character', name: 'Example portrait subject' });
  ids.push(row.id);
  return row.id;
}

afterEach(() => {
  intercept = null;
  hook.__testing.reset();
});
afterAll(async () => {
  for (const id of ids) await catalogDB.deleteIngredient(id, { hard: true });
  await close();
});

describe.skipIf(!runDb)('atomic local portrait replacement', () => {
  it.each([false, true])('serializes generic and dedicated writes (existing portrait: %s)', async (existing) => {
    const id = await ingredient();
    if (existing) await catalogDB.setPortraitMedia(id, 'old.png');
    let demoted = false;
    const release = deferred();
    let locks = 0;
    intercept = async (sql, params) => {
      if (sql.includes('FOR UPDATE')) locks += 1;
      if (sql.includes('UPDATE catalog_ingredient_media') && params[1] === 'first.png') {
        return async () => { demoted = true; await release.promise; };
      }
    };
    const first = catalogDB.setPortraitMedia(id, 'first.png');
    await vi.waitFor(() => expect(demoted).toBe(true));
    const second = catalogDB.attachMedia(id, 'second.png', 'portrait', { caption: 'Selected' });
    try {
      await vi.waitFor(() => expect(locks).toBe(2));
    } finally {
      release.resolve();
      await Promise.all([first, second]);
    }
    const live = await catalogDB.listMediaForIngredient(id);
    expect(live.map((row) => row.mediaKey)).toEqual(['second.png']);
    expect(live[0].caption).toBe('Selected');
    const tombstones = await query(
      'SELECT media_key, deleted, deleted_at FROM catalog_ingredient_media WHERE ingredient_id = $1 AND media_key <> $2',
      [id, 'second.png'],
    );
    expect(tombstones.rows).toHaveLength(existing ? 2 : 1);
    expect(tombstones.rows.every((row) => row.deleted && row.deleted_at)).toBe(true);
  });

  it('serializes a generation completion with a local portrait write and retains provenance', async () => {
    const id = await ingredient();
    await catalogDB.setPortraitMedia(id, 'old.png');
    let demoted = false;
    const release = deferred();
    let locks = 0;
    intercept = async (sql, params) => {
      if (sql.includes('FOR UPDATE')) locks += 1;
      if (sql.includes('UPDATE catalog_ingredient_media') && params[1] === 'manual.png') {
        return async () => { demoted = true; await release.promise; };
      }
    };
    hook.initCatalogImageAttachHook();
    const manual = catalogDB.setPortraitMedia(id, 'manual.png');
    await vi.waitFor(() => expect(demoted).toBe(true));
    mediaJobEvents.emit('completed', {
      kind: 'image',
      params: { catalogAttach: { ingredientId: id, kind: 'portrait' } },
      result: { filename: 'generated.png' },
    });
    try {
      await vi.waitFor(() => expect(locks).toBe(2));
    } finally {
      release.resolve();
      await manual;
    }
    await vi.waitFor(async () => {
      const live = await catalogDB.listMediaForIngredient(id);
      expect(live.map((row) => row.mediaKey)).toEqual(['generated.png']);
      expect(live[0].metadata).toEqual({ prompt: 'Example portrait', seed: 42 });
    });
  });

  it('rolls back demotion when insertion fails, and leaves other media kinds additive', async () => {
    const id = await ingredient();
    await catalogDB.setPortraitMedia(id, 'old.png', { metadata: { prompt: 'Original' } });
    for (const kind of ['reference', 'audio', 'video', 'document']) {
      await catalogDB.attachMedia(id, 'first-asset', kind);
      await catalogDB.attachMedia(id, 'second-asset', kind);
    }
    intercept = async (sql) => {
      if (sql.includes('INSERT INTO catalog_ingredient_media')) throw new Error('Injected insertion failure');
    };
    await expect(catalogDB.attachMedia(id, 'broken.png', 'portrait')).rejects.toThrow('Injected insertion failure');
    const live = await catalogDB.listMediaForIngredient(id);
    expect(live.filter((row) => row.kind === 'portrait')).toMatchObject([
      { mediaKey: 'old.png', metadata: { prompt: 'Original' } },
    ]);
    for (const kind of ['reference', 'audio', 'video', 'document']) {
      expect(live.filter((row) => row.kind === kind)).toHaveLength(2);
    }
  });
});
