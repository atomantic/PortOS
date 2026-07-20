import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createCollectionStore, verifyCollectionVersions } from './collectionStore.js';
import { atomicWrite } from './fileUtils.js';

// Defer one tick so we can interleave per-id queue assertions.
const tick = () => new Promise((r) => setImmediate(r));

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'collstore-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('createCollectionStore — argument validation', () => {
  it('rejects missing dir', () => {
    expect(() => createCollectionStore({ type: 'x', schemaVersion: 1 })).toThrow(/dir/);
  });
  it('rejects missing type', () => {
    expect(() => createCollectionStore({ dir, schemaVersion: 1 })).toThrow(/type/);
  });
  it('rejects non-integer schemaVersion', () => {
    expect(() => createCollectionStore({ dir, type: 'x', schemaVersion: 1.5 })).toThrow(/schemaVersion/);
    expect(() => createCollectionStore({ dir, type: 'x', schemaVersion: 0 })).toThrow(/schemaVersion/);
  });
});

describe('loadTypeIndex / saveTypeIndex', () => {
  it('returns code-expected defaults when index.json is missing', async () => {
    const store = createCollectionStore({ dir, type: 'widgets', schemaVersion: 3 });
    const idx = await store.loadTypeIndex();
    expect(idx.schemaVersion).toBe(3);
    expect(idx.type).toBe('widgets');
    expect(idx.config).toEqual({});
    // Did NOT write to disk — pure load.
    expect(existsSync(join(dir, 'index.json'))).toBe(false);
  });

  it('uses defaultTypeIndexConfig as starting point', async () => {
    const store = createCollectionStore({
      dir, type: 'widgets', schemaVersion: 1,
      defaultTypeIndexConfig: { feature: 'on' },
    });
    const idx = await store.loadTypeIndex();
    expect(idx.config).toEqual({ feature: 'on' });
  });

  it('saveTypeIndex persists and updatedAt is restamped', async () => {
    const store = createCollectionStore({ dir, type: 'widgets', schemaVersion: 2 });
    const a = await store.saveTypeIndex({ config: { gated: true } });
    expect(a.config).toEqual({ gated: true });
    expect(a.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const onDisk = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'));
    expect(onDisk.schemaVersion).toBe(2);
    expect(onDisk.type).toBe('widgets');
    expect(onDisk.config.gated).toBe(true);
  });

  it('saveTypeIndex shallow-merges config (does not clobber existing keys)', async () => {
    const store = createCollectionStore({ dir, type: 'widgets', schemaVersion: 1 });
    await store.saveTypeIndex({ config: { a: 1 } });
    await store.saveTypeIndex({ config: { b: 2 } });
    const idx = await store.loadTypeIndex();
    expect(idx.config).toEqual({ a: 1, b: 2 });
  });

  it('concurrent saveTypeIndex calls serialize through the queue', async () => {
    const store = createCollectionStore({ dir, type: 'widgets', schemaVersion: 1 });
    await Promise.all([
      store.saveTypeIndex({ config: { a: 1 } }),
      store.saveTypeIndex({ config: { b: 2 } }),
      store.saveTypeIndex({ config: { c: 3 } }),
    ]);
    const idx = await store.loadTypeIndex();
    expect(idx.config).toEqual({ a: 1, b: 2, c: 3 });
  });
});

// Pins the documented `config`-slot convention (see the collectionStore header
// + the TypeIndexConfig typedef). These guarantees are load-bearing for the
// universeBuilder `config.runs` history-log pattern.
describe('config slot convention', () => {
  it('shallow-merge REPLACES an array slot (does not concat) — runs RMW must write the full array', async () => {
    const store = createCollectionStore({ dir, type: 'universes', schemaVersion: 1 });
    await store.saveTypeIndex({ config: { runs: [{ id: 'r1' }] } });
    // A naive patch with only the new entry replaces the whole array — proving
    // a consumer MUST load → append → write the full array (recordRun pattern).
    await store.saveTypeIndex({ config: { runs: [{ id: 'r2' }] } });
    const idx = await store.loadTypeIndex();
    expect(idx.config.runs).toEqual([{ id: 'r2' }]);
  });

  it('correct append pattern: load the slot, mutate a copy, write the full replacement (fenced)', async () => {
    const store = createCollectionStore({ dir, type: 'universes', schemaVersion: 1 });
    // Mirrors universeBuilder.recordRun: the load→append→write runs inside a
    // single queueTypeIndexWrite fence (writing the index directly, NOT via the
    // re-entrant saveTypeIndex) so concurrent appends don't clobber each other.
    const append = (run) => store.queueTypeIndexWrite(async () => {
      const current = await store.loadTypeIndex();
      const runs = Array.isArray(current.config?.runs) ? [...current.config.runs] : [];
      runs.push(run);
      await atomicWrite(store.typeIndexPath(), {
        schemaVersion: current.schemaVersion,
        type: current.type,
        config: { ...(current.config || {}), runs },
        updatedAt: new Date().toISOString(),
      });
    });
    await Promise.all([append({ id: 'r1' }), append({ id: 'r2' }), append({ id: 'r3' })]);
    const idx = await store.loadTypeIndex();
    expect(idx.config.runs.map((r) => r.id).sort()).toEqual(['r1', 'r2', 'r3']);
  });

  it('defaultTypeIndexConfig seeds a fresh slot but is NOT re-applied on later writes', async () => {
    const store = createCollectionStore({
      dir, type: 'universes', schemaVersion: 1,
      defaultTypeIndexConfig: { runs: [], featureFlags: { beta: false } },
    });
    // First write to a fresh (missing) index seeds the default, then merges the
    // patch over it — so the seeded featureFlags rides along on this first save.
    await store.saveTypeIndex({ config: { runs: [{ id: 'r1' }] } });
    const seeded = await store.loadTypeIndex();
    expect(seeded.config).toEqual({ runs: [{ id: 'r1' }], featureFlags: { beta: false } });
    // Overwriting featureFlags replaces it wholesale (one-level shallow merge).
    await store.saveTypeIndex({ config: { featureFlags: { beta: true } } });
    const idx = await store.loadTypeIndex();
    expect(idx.config.featureFlags).toEqual({ beta: true });
    expect(idx.config.runs).toEqual([{ id: 'r1' }]);
  });

  it('a default key absent from an EXISTING on-disk config is NOT re-injected on a later patch', async () => {
    // Pre-seed disk with a valid index whose config lacks `featureFlags`, so the
    // only way the key could reappear is if the default were re-merged on write.
    // It must NOT — saveTypeIndex shallow-merges the patch over the current
    // on-disk config, never over `defaultTypeIndexConfig`.
    writeFileSync(join(dir, 'index.json'), JSON.stringify({
      schemaVersion: 1, type: 'universes', config: { runs: [{ id: 'r0' }] },
      updatedAt: new Date().toISOString(),
    }));
    const store = createCollectionStore({
      dir, type: 'universes', schemaVersion: 1,
      defaultTypeIndexConfig: { runs: [], featureFlags: { beta: false } },
    });
    await store.saveTypeIndex({ config: { runs: [{ id: 'r0' }, { id: 'r1' }] } });
    const idx = await store.loadTypeIndex();
    expect(idx.config).toEqual({ runs: [{ id: 'r0' }, { id: 'r1' }] });
    expect('featureFlags' in idx.config).toBe(false);
  });
});

describe('saveOne / loadOne / deleteOne', () => {
  it('persists a record under {dir}/{id}/index.json', async () => {
    const store = createCollectionStore({ dir, type: 'widgets', schemaVersion: 1 });
    await store.saveOne('alpha', { id: 'alpha', name: 'A' });
    expect(existsSync(join(dir, 'alpha', 'index.json'))).toBe(true);
    const parsed = JSON.parse(await readFile(join(dir, 'alpha', 'index.json'), 'utf8'));
    expect(parsed).toEqual({ id: 'alpha', name: 'A' });
  });

  it('loadOne returns the on-disk record', async () => {
    const store = createCollectionStore({ dir, type: 'widgets', schemaVersion: 1 });
    await store.saveOne('alpha', { id: 'alpha', name: 'A' });
    expect(await store.loadOne('alpha')).toEqual({ id: 'alpha', name: 'A' });
  });

  it('loadOne returns null when the record is missing', async () => {
    const store = createCollectionStore({ dir, type: 'widgets', schemaVersion: 1 });
    expect(await store.loadOne('does-not-exist')).toBeNull();
  });

  it('loadOne runs sanitizeRecord on the parsed payload', async () => {
    const store = createCollectionStore({
      dir, type: 'widgets', schemaVersion: 1,
      sanitizeRecord: (r) => ({ ...r, sanitized: true }),
    });
    await store.saveOne('alpha', { id: 'alpha', name: 'A' });
    expect(await store.loadOne('alpha')).toEqual({ id: 'alpha', name: 'A', sanitized: true });
  });

  it('sanitizeRecord returning null surfaces as null from loadOne', async () => {
    const store = createCollectionStore({
      dir, type: 'widgets', schemaVersion: 1,
      sanitizeRecord: () => null,
    });
    await store.saveOne('alpha', { id: 'alpha', name: 'A' });
    expect(await store.loadOne('alpha')).toBeNull();
  });

  it('loadOne tolerates corrupted JSON without throwing', async () => {
    const store = createCollectionStore({ dir, type: 'widgets', schemaVersion: 1 });
    mkdirSync(join(dir, 'alpha'), { recursive: true });
    writeFileSync(join(dir, 'alpha', 'index.json'), '{not valid json');
    expect(await store.loadOne('alpha')).toBeNull();
  });

  it('saveOne throws synchronously on invalid ids (caller bug, fail fast)', () => {
    const store = createCollectionStore({ dir, type: 'widgets', schemaVersion: 1 });
    expect(() => store.saveOne('../escape', { id: 'x' })).toThrow(/invalid record id/);
    expect(() => store.saveOne('has/slash', { id: 'x' })).toThrow(/invalid record id/);
    expect(() => store.saveOne('', { id: 'x' })).toThrow(/invalid record id/);
    expect(() => store.saveOne(null, { id: 'x' })).toThrow(/invalid record id/);
  });

  it('saveOne throws synchronously on non-object records', () => {
    const store = createCollectionStore({ dir, type: 'widgets', schemaVersion: 1 });
    expect(() => store.saveOne('alpha', null)).toThrow(/plain object/);
    expect(() => store.saveOne('alpha', [])).toThrow(/plain object/);
    expect(() => store.saveOne('alpha', 'string')).toThrow(/plain object/);
  });

  it('honors a custom idPattern', async () => {
    const UUID = /^[0-9a-f-]{36}$/;
    const store = createCollectionStore({
      dir, type: 'widgets', schemaVersion: 1, idPattern: UUID,
    });
    expect(() => store.saveOne('not-a-uuid', { id: 'x' })).toThrow(/invalid record id/);
    const goodId = '12345678-1234-1234-1234-123456789012';
    await store.saveOne(goodId, { id: goodId });
    expect(await store.loadOne(goodId)).toEqual({ id: goodId });
  });

  it('deleteOne removes the full {dir}/{id}/ subtree', async () => {
    const store = createCollectionStore({ dir, type: 'widgets', schemaVersion: 1 });
    await store.saveOne('alpha', { id: 'alpha' });
    // Drop a sidecar to verify recursive removal.
    writeFileSync(join(dir, 'alpha', 'sidecar.png'), 'fake');
    await store.deleteOne('alpha');
    expect(existsSync(join(dir, 'alpha'))).toBe(false);
  });

  it('deleteOne is idempotent (missing id is a no-op)', async () => {
    const store = createCollectionStore({ dir, type: 'widgets', schemaVersion: 1 });
    await expect(store.deleteOne('alpha')).resolves.toBeUndefined();
  });
});

describe('listIds', () => {
  it('returns [] when the directory is missing', async () => {
    const store = createCollectionStore({
      dir: join(dir, 'nope'), type: 'widgets', schemaVersion: 1,
    });
    expect(await store.listIds()).toEqual([]);
  });

  it('returns only record-id directories — skips index.json, hidden, non-dir', async () => {
    const store = createCollectionStore({ dir, type: 'widgets', schemaVersion: 1 });
    await store.saveOne('alpha', { id: 'alpha' });
    await store.saveOne('beta', { id: 'beta' });
    await store.saveTypeIndex({});
    writeFileSync(join(dir, '.DS_Store'), '');
    writeFileSync(join(dir, 'loose-file.txt'), 'noise');
    const ids = await store.listIds();
    expect([...ids].sort()).toEqual(['alpha', 'beta']);
  });

  it('rejects entries that fail the idPattern', async () => {
    const store = createCollectionStore({
      dir, type: 'widgets', schemaVersion: 1,
      idPattern: /^[a-z]+$/,
    });
    mkdirSync(join(dir, 'good'), { recursive: true });
    writeFileSync(join(dir, 'good', 'index.json'), JSON.stringify({ id: 'good' }));
    mkdirSync(join(dir, 'BadCase'), { recursive: true });
    writeFileSync(join(dir, 'BadCase', 'index.json'), JSON.stringify({ id: 'BadCase' }));
    expect(await store.listIds()).toEqual(['good']);
  });
});

describe('loadAll', () => {
  it('returns every record', async () => {
    const store = createCollectionStore({ dir, type: 'widgets', schemaVersion: 1 });
    await store.saveOne('a', { id: 'a', n: 1 });
    await store.saveOne('b', { id: 'b', n: 2 });
    await store.saveOne('c', { id: 'c', n: 3 });
    const all = await store.loadAll();
    expect(all.map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('drops records the sanitizer rejects', async () => {
    const store = createCollectionStore({
      dir, type: 'widgets', schemaVersion: 1,
      sanitizeRecord: (r) => r.n > 1 ? r : null,
    });
    await store.saveOne('a', { id: 'a', n: 1 });
    await store.saveOne('b', { id: 'b', n: 2 });
    await store.saveOne('c', { id: 'c', n: 3 });
    const all = await store.loadAll();
    expect(all.map((r) => r.id).sort()).toEqual(['b', 'c']);
  });
});

describe('loadAllResult (#2728)', () => {
  it('returns every record with an empty failedIds when all load cleanly', async () => {
    const store = createCollectionStore({ dir, type: 'widgets', schemaVersion: 1 });
    await store.saveOne('a', { id: 'a', n: 1 });
    await store.saveOne('b', { id: 'b', n: 2 });
    const { records, failedIds } = await store.loadAllResult();
    expect(records.map((r) => r.id).sort()).toEqual(['a', 'b']);
    expect(failedIds).toEqual([]);
  });

  it('surfaces a corrupt record in failedIds while still returning the readable ones', async () => {
    const store = createCollectionStore({ dir, type: 'widgets', schemaVersion: 1 });
    await store.saveOne('good', { id: 'good' });
    // A record dir whose index.json is unparseable — loadOne(id) → null.
    mkdirSync(join(dir, 'broken'), { recursive: true });
    writeFileSync(join(dir, 'broken', 'index.json'), '{not valid json');
    const { records, failedIds } = await store.loadAllResult();
    expect(records.map((r) => r.id)).toEqual(['good']);
    expect(failedIds).toEqual(['broken']);
  });

  it('reports sanitizer-rejected records as failedIds (distinct from absent ones)', async () => {
    const store = createCollectionStore({
      dir, type: 'widgets', schemaVersion: 1,
      sanitizeRecord: (r) => r.n > 1 ? r : null,
    });
    await store.saveOne('a', { id: 'a', n: 1 });
    await store.saveOne('b', { id: 'b', n: 2 });
    const { records, failedIds } = await store.loadAllResult();
    expect(records.map((r) => r.id)).toEqual(['b']);
    expect(failedIds).toEqual(['a']);
  });

  it('loadAll stays a back-compat flatten of loadAllResult.records', async () => {
    const store = createCollectionStore({ dir, type: 'widgets', schemaVersion: 1 });
    await store.saveOne('good', { id: 'good' });
    mkdirSync(join(dir, 'broken'), { recursive: true });
    writeFileSync(join(dir, 'broken', 'index.json'), 'nope');
    const all = await store.loadAll();
    const { records } = await store.loadAllResult();
    expect(all.map((r) => r.id)).toEqual(['good']);
    expect(all).toEqual(records);
  });
});

describe('per-id write queue', () => {
  it('two saves to the same id serialize in submission order', async () => {
    const store = createCollectionStore({ dir, type: 'widgets', schemaVersion: 1 });
    const order = [];
    const a = store.queueRecordWrite('alpha', async () => { await tick(); order.push('a'); });
    const b = store.queueRecordWrite('alpha', async () => { order.push('b'); });
    await Promise.all([a, b]);
    expect(order).toEqual(['a', 'b']);
  });

  it('saves to different ids do NOT serialize', async () => {
    const store = createCollectionStore({ dir, type: 'widgets', schemaVersion: 1 });
    const order = [];
    // alpha yields; beta should not wait for alpha.
    const a = store.queueRecordWrite('alpha', async () => { await tick(); order.push('alpha-slow'); });
    const b = store.queueRecordWrite('beta',  async () => { order.push('beta-fast'); });
    await Promise.all([a, b]);
    expect(order).toEqual(['beta-fast', 'alpha-slow']);
  });

  it('a rejection on one id does not poison subsequent writes to that id', async () => {
    const store = createCollectionStore({ dir, type: 'widgets', schemaVersion: 1 });
    const bad = store.queueRecordWrite('alpha', async () => { throw new Error('nope'); });
    await expect(bad).rejects.toThrow('nope');
    // Next write to same id should still go through.
    const good = await store.queueRecordWrite('alpha', () => Promise.resolve('ok'));
    expect(good).toBe('ok');
  });

  it('queueRecordWrite rejects invalid ids', () => {
    const store = createCollectionStore({ dir, type: 'widgets', schemaVersion: 1 });
    expect(() => store.queueRecordWrite('../escape', () => null)).toThrow(/invalid record id/);
  });
});

describe('verifySchemaVersion', () => {
  it('returns ok when on-disk version matches code', async () => {
    const store = createCollectionStore({ dir, type: 'widgets', schemaVersion: 3 });
    await store.saveTypeIndex({});
    const status = await store.verifySchemaVersion();
    expect(status.ok).toBe(true);
    expect(status.onDisk).toBe(3);
    expect(status.expected).toBe(3);
  });

  it('returns ok (fresh install) when index.json is missing', async () => {
    const store = createCollectionStore({ dir, type: 'widgets', schemaVersion: 3 });
    const status = await store.verifySchemaVersion();
    expect(status.ok).toBe(true);
    expect(status.onDisk).toBeNull();
    expect(status.message).toMatch(/fresh install/);
  });

  it('reports a missed migration when on-disk version is lower', async () => {
    const store = createCollectionStore({ dir, type: 'widgets', schemaVersion: 5 });
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ schemaVersion: 4, type: 'widgets', config: {} }));
    const status = await store.verifySchemaVersion();
    expect(status.ok).toBe(false);
    expect(status.onDisk).toBe(4);
    expect(status.expected).toBe(5);
    expect(status.message).toMatch(/migration didn't run/);
  });

  it('reports a rollback when on-disk version is higher', async () => {
    const store = createCollectionStore({ dir, type: 'widgets', schemaVersion: 2 });
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ schemaVersion: 5, type: 'widgets', config: {} }));
    const status = await store.verifySchemaVersion();
    expect(status.ok).toBe(false);
    expect(status.onDisk).toBe(5);
    expect(status.message).toMatch(/rolled back/);
  });
});

describe('verifyCollectionVersions', () => {
  it('logs success per store and returns per-store statuses', async () => {
    const a = createCollectionStore({ dir: join(dir, 'a'), type: 'a', schemaVersion: 1 });
    const b = createCollectionStore({ dir: join(dir, 'b'), type: 'b', schemaVersion: 2 });
    await a.saveTypeIndex({});
    await b.saveTypeIndex({});
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const statuses = await verifyCollectionVersions([a, b]);
    spy.mockRestore();
    expect(statuses).toHaveLength(2);
    expect(statuses[0].ok).toBe(true);
    expect(statuses[1].ok).toBe(true);
  });

  it('logs to console.error on mismatch without throwing', async () => {
    const store = createCollectionStore({ dir, type: 'widgets', schemaVersion: 5 });
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ schemaVersion: 4, config: {} }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const [status] = await verifyCollectionVersions([store]);
    errSpy.mockRestore();
    expect(status.ok).toBe(false);
  });
});
