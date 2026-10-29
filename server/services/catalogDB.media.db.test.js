/**
 * Real Postgres regression tests for overlapping local image writes: portrait
 * replacements and the generated-image attach shared by the completion hook and
 * the mounted client (#13833). Query barriers hold one writer inside its
 * transaction while another reaches the row lock; no sleeps or simulated SQL
 * locking semantics.
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
vi.mock('./instanceIdentity.js', () => ({ getInstanceId: async () => 'example-local-instance', UNKNOWN_INSTANCE_ID: 'unknown' }));
vi.mock('./catalogMedia.js', () => ({
  readImageGenerationMetadata: async () => ({ prompt: 'Example portrait', seed: 42 }),
}));

const { checkHealth, ensureSchema, close, query } = await import('../lib/db.js');
const { requireDbOrSkip } = await import('../lib/dbTestGate.js');
const catalogDB = await import('./catalogDB.js');
const { mediaJobEvents } = await import('./mediaJobQueue/index.js');
const hook = await import('./catalogImageAttachHook.js');
const { mergeIngredients } = await import('./catalogDB/merge.js');

const health = await checkHealth();
if (health.connected) await ensureSchema();
const runDb = requireDbOrSkip('catalogDB.media.db.test', health.connected, health.error);
const ids = [];
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const liveRows = (id) => query(
  `SELECT media_key, kind, role, caption, metadata, library FROM catalog_ingredient_media
    WHERE ingredient_id = $1 AND deleted = false ORDER BY media_key, kind`, [id]).then((r) => r.rows);
const emitCompletion = (catalogAttach, filename) => mediaJobEvents.emit('completed', {
  kind: 'image', params: { catalogAttach }, result: { filename },
});

// Hold the first writer just after its in-transaction media read (the moment
// the pre-#13833 hook decided outside any lock), let the second writer reach
// the ingredient lock, then release.
async function holdFirstGeneratedReadThen(first, second) {
  const release = deferred();
  let held = false;
  let locks = 0;
  intercept = async (sql) => {
    if (sql.includes('FOR UPDATE')) locks += 1;
    if (!held && sql.includes('catalog_identity_read_media')) {
      held = true;
      return () => release.promise;
    }
  };
  const firstDone = first();
  await vi.waitFor(() => expect(held).toBe(true));
  const lockedBefore = locks;
  const secondDone = second();
  try {
    await vi.waitFor(() => expect(locks).toBeGreaterThan(lockedBefore));
  } finally {
    release.resolve();
  }
  return Promise.all([firstDone, secondDone]);
}

async function ingredient(payload) {
  const row = await catalogDB.createIngredient({ type: 'character', name: 'Example portrait subject', ...(payload ? { payload } : {}) });
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

describe.skipIf(!runDb)('atomic local image writes', () => {
  it('attaches refinement metadata atomically and retains exact feedback when rejecting a guide', async () => {
    const id = await ingredient();
    const feedback = '  Keep identity; shorten hair.\nPreserve the coat.  ';
    const library = { variant: { age: 27, formId: 'adult' }, guide: true,
      review: { status: 'good', feedback }, derivedFrom: { mediaKey: 'source.png', kind: 'reference' } };
    const attached = await catalogDB.attachMedia(id, 'refined.png', 'reference', { library });
    expect(attached.library).toEqual(library);
    await catalogDB.setPortraitMedia(id, 'refined.png', { library });
    await catalogDB.updateMediaLibrary(id, 'refined.png', 'reference', { review: { status: 'rejected' } });
    await catalogDB.updateMediaLibrary(id, 'refined.png', 'reference', { tags: ['retained'] });
    const portrait = await catalogDB.updateMediaLibrary(id, 'refined.png', 'portrait', { guide: true });
    expect(portrait.library.guide).toBe(false);
    const media = await catalogDB.listMediaForIngredient(id);
    expect(media.find(m => m.kind === 'reference').library).toEqual({
      ...library, guide: false, tags: ['retained'], review: { status: 'rejected', feedback },
    });
    expect(media.find(m => m.kind === 'portrait').library.guide).toBe(false);
  });
  it('leaves both attachments of an image out of likeness and puts both back', async () => {
    const id = await ingredient();
    await catalogDB.attachMedia(id, 'board.png', 'reference', { library: { guide: true } });
    await catalogDB.setPortraitMedia(id, 'board.png', { library: { tags: ['collage'] } });
    const out = await catalogDB.updateMediaLibrary(id, 'board.png', 'reference', { likeness: false });
    expect(out.library).toEqual({ guide: false, likeness: false });
    let media = await catalogDB.listMediaForIngredient(id);
    expect(media.find(m => m.kind === 'portrait').library).toEqual({ tags: ['collage'], guide: false, likeness: false });
    expect((await catalogDB.updateMediaLibrary(id, 'board.png', 'portrait', { guide: true })).library.guide).toBe(false);
    await catalogDB.updateMediaLibrary(id, 'board.png', 'portrait', { likeness: true });
    media = await catalogDB.listMediaForIngredient(id);
    expect(media.map(m => m.library.likeness)).toEqual([undefined, undefined]);
  });
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

  // Each ordering of the completion hook and the client's optimistic attach,
  // with the writers asking for different kinds: exactly one row survives.
  it.each([
    ['hook first', 'hook'],
    ['client first', 'client'],
  ])('leaves one generated attachment when the %s holds the lock', async (_label, leader) => {
    const id = await ingredient();
    await catalogDB.attachMedia(id, 'existing.png', 'reference');
    hook.initCatalogImageAttachHook();
    // The hook was told portrait; the client's auto request sees no portrait
    // either — without the lock both decide before either writes.
    const runHook = async () => {
      emitCompletion({ ingredientId: id, kind: 'portrait' }, 'render.png');
      await hook.__testing.settled();
    };
    const runClient = () => catalogDB.attachGeneratedMedia(id, 'render.png', { kind: 'reference' });
    const [a, b] = leader === 'hook' ? [runHook, runClient] : [runClient, runHook];
    const results = await holdFirstGeneratedReadThen(a, b);
    await hook.__testing.settled();
    const client = leader === 'hook' ? results[1] : results[0];
    expect(client.attached).toBe(leader === 'client');
    const renders = (await liveRows(id)).filter((row) => row.media_key === 'render.png');
    expect(renders).toHaveLength(1);
    expect(renders[0].kind).toBe(leader === 'hook' ? 'portrait' : 'reference');
  });

  it('keeps an explicit choice and its fields, and still allows a deliberate second kind', async () => {
    const id = await ingredient();
    const library = { tags: ['chosen'], review: { status: 'good', feedback: 'Keep' },
      derivedFrom: { mediaKey: 'source.png', kind: 'reference' } };
    await catalogDB.attachMedia(id, 'render.png', 'reference', {
      role: 'plate', caption: 'User caption', metadata: { prompt: 'User prompt' }, library,
    });
    hook.initCatalogImageAttachHook();
    // The explicit attach committed first, so the completion is a duplicate.
    emitCompletion({ ingredientId: id, kind: 'portrait', library: { tags: ['generated'],
      derivedFrom: { mediaKey: 'other.png', kind: 'reference' } } }, 'render.png');
    await hook.__testing.settled();
    expect(await liveRows(id)).toEqual([expect.objectContaining({
      media_key: 'render.png', kind: 'reference', role: 'plate', caption: 'User caption',
      metadata: { prompt: 'User prompt' }, library,
    })]);
    // A later explicit portrait choice of the same image is intentional.
    await catalogDB.setPortraitMedia(id, 'render.png');
    expect((await liveRows(id)).map((row) => row.kind)).toEqual(['portrait', 'reference']);
  });

  it('serializes an explicit reference attach behind the generated decision', async () => {
    const id = await ingredient();
    hook.initCatalogImageAttachHook();
    await holdFirstGeneratedReadThen(
      async () => {
        emitCompletion({ ingredientId: id }, 'render.png');
        await hook.__testing.settled();
      },
      () => catalogDB.attachMedia(id, 'render.png', 'reference', { role: 'plate', caption: 'Chosen later' }),
    );
    // The automatic attach landed once (portrait); the user's later explicit
    // reference choice is a deliberate second association with its own fields.
    expect(await liveRows(id)).toEqual([
      expect.objectContaining({ media_key: 'render.png', kind: 'portrait', role: null, caption: null,
        metadata: { prompt: 'Example portrait', seed: 42 } }),
      expect.objectContaining({ media_key: 'render.png', kind: 'reference', role: 'plate', caption: 'Chosen later' }),
    ]);
  });

  it('reports the portrait when a render is deliberately held as both kinds', async () => {
    const id = await ingredient();
    await catalogDB.attachMedia(id, 'both.png', 'reference');
    await catalogDB.setPortraitMedia(id, 'both.png');
    await catalogDB.attachMedia(id, 'both.png', 'reference', { caption: 'Touched later' });
    const result = await catalogDB.attachGeneratedMedia(id, 'both.png');
    expect(result).toMatchObject({ kind: 'portrait', attached: false, media: { kind: 'portrait' } });
  });

  // Merge takes the media table lock, then ingredient rows. An attach holding
  // the ingredient row before touching media would deadlock with it.
  it('orders an attach and an overlapping merge instead of deadlocking', async () => {
    const id = await ingredient({ locked: false });
    const sourceId = await ingredient({ locked: false });
    // The preview row-locks too, so take it before the attach holds the row.
    const preview = await mergeIngredients({ sourceId, survivorId: id });
    const release = deferred();
    let held = false;
    intercept = async (sql) => {
      if (!held && sql.includes('catalog_identity_read_media')) {
        held = true;
        return () => release.promise;
      }
    };
    const attach = catalogDB.attachGeneratedMedia(id, 'merge-race.png');
    await vi.waitFor(() => expect(held).toBe(true));
    const merge = mergeIngredients({ sourceId, survivorId: id, fieldChoices: preview.fieldChoices || {},
      dryRun: false, previewToken: preview.previewToken }).then(() => 'merged', (err) => err);
    try {
      await vi.waitFor(async () => {
        const waiting = await query('SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted');
        expect(waiting.rows[0].n).toBeGreaterThan(0);
      });
    } finally {
      release.resolve();
    }
    await expect(attach).resolves.toMatchObject({ attached: true });
    // The merge may still refuse its now-stale preview; it must not be the
    // deadlock victim (40P01) of the attach.
    const outcome = await merge;
    expect(outcome?.code === '40P01' ? outcome.message : null).toBeNull();
  });

  // The client files the newer render first; an explicit-portrait completion
  // queued before that choice must not replace it, whatever the hook guard saw.
  it.each([
    ['queued before', -60_000, { 'newer.png': 'portrait', 'older.png': 'reference' }],
    ['queued after', 60_000, { 'older.png': 'portrait' }],
  ])('files an explicit portrait %s a newer live portrait accordingly', async (_label, offset, expected) => {
    const id = await ingredient();
    await catalogDB.attachGeneratedMedia(id, 'newer.png');
    hook.initCatalogImageAttachHook();
    mediaJobEvents.emit('completed', { kind: 'image', params: { catalogAttach: { ingredientId: id, kind: 'portrait' } },
      result: { filename: 'older.png' }, queuedAt: new Date(Date.now() + offset).toISOString() });
    await hook.__testing.settled();
    expect(Object.fromEntries((await liveRows(id)).map((row) => [row.media_key, row.kind]))).toEqual(expected);
  });
});

describe.skipIf(!runDb)('findMediaOwnersByKeys', () => {
  it('names each image by its owner, preferring the caller\'s linked records and skipping detached rows', async () => {
    const lead = await catalogDB.createIngredient({ type: 'character', name: 'Example Lead' });
    const friend = await catalogDB.createIngredient({ type: 'character', name: 'Example Friend' });
    const rink = await catalogDB.createIngredient({ type: 'place', name: 'Example Rink' });
    ids.push(lead.id, friend.id, rink.id);
    await catalogDB.attachMedia(lead.id, 'owners-shared.png', 'reference');
    await catalogDB.setPortraitMedia(friend.id, 'owners-shared.png');
    await catalogDB.attachMedia(rink.id, 'owners-plate.png', 'reference');
    await catalogDB.attachMedia(rink.id, 'owners-gone.png', 'reference');
    await catalogDB.detachMedia(rink.id, 'owners-gone.png', 'reference');
    const keys = ['owners-shared.png', 'owners-plate.png', 'owners-gone.png', 'owners-unknown.png'];

    const unlinked = await catalogDB.findMediaOwnersByKeys(keys);
    expect(unlinked.get('owners-shared.png')).toMatchObject({ name: 'Example Friend', preferredId: null });
    expect(unlinked.get('owners-plate.png')).toMatchObject({ name: 'Example Rink', type: 'place' });
    expect([...unlinked.keys()].sort()).toEqual(['owners-plate.png', 'owners-shared.png']);

    const linked = await catalogDB.findMediaOwnersByKeys(keys, { preferIds: [lead.id] });
    expect(linked.get('owners-shared.png')).toMatchObject({ ingredientId: lead.id, name: 'Example Lead', preferredId: lead.id });
  });
});
