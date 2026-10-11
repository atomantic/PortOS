import { describe, expect, it, vi } from 'vitest';
import { runCleanupTestData } from './cleanup-test-data.js';

// Importing or exercising the injected workflow must never load production
// storage, provider, or peer-sync dependencies.
vi.mock('../server/services/universeBuilder.js', () => { throw new Error('Live universe service loaded'); });
vi.mock('../server/services/pipeline/series.js', () => { throw new Error('Live series service loaded'); });
vi.mock('../server/services/pipeline/issues.js', () => { throw new Error('Live issue service loaded'); });

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const U = uuid(1);
const S = `ser-${uuid(2)}`;
const REAL_S = `ser-${uuid(3)}`;
const CHILD_A = `iss-${uuid(4)}`;
const CHILD_B = `iss-${uuid(5)}`;
const REAL_I = `iss-${uuid(6)}`;

function fixtureStore(pageSize = 1000) {
  const universes = [
    { id: U, name: ' Test Work ' },
    { id: 'fixture-universe', name: 'Example Universe' },
    { id: uuid(7), name: 'Commit Universe Tour' },
    { id: uuid(8), name: 'Test Work', deleted: true },
  ];
  const series = [
    { id: S, name: ' Commit S ' },
    { id: 'ser-fixture', name: 'Example Series' },
    { id: REAL_S, name: 'Commit Series Tour' },
    { id: `ser-${uuid(9)}`, name: 'Commit S', deleted: true },
  ];
  const issues = [
    { id: CHILD_A, seriesId: S, number: 1 },
    { id: CHILD_B, seriesId: S, number: 2 },
    { id: 'iss-fixture-child', seriesId: 'ser-fixture', number: 1 },
    { id: 'iss-fixture-orphan', seriesId: REAL_S, number: 1 },
    { id: REAL_I, seriesId: REAL_S, number: 2 },
    { id: 'iss-already-deleted', seriesId: S, deleted: true },
  ];
  const failures = new Set();
  const attempts = [];
  const completed = [];
  const list = (records, key, options) => {
    expect(options.includeDeleted).toBe(false);
    if (failures.has(key)) throw new Error(`Enumeration unavailable: ${key}`);
    return records.filter(r => !r.deleted);
  };
  const remove = (records, kind) => async id => {
    const key = `${kind}:${id}`;
    attempts.push(key);
    if (failures.has(key)) throw new Error(`Delete unavailable: ${key}`);
    const record = records.find(r => r.id === id);
    if (!record || record.deleted) throw new Error('Repeated or missing tombstone');
    record.deleted = true;
    completed.push(key);
  };
  const services = {
    listUniverses: async options => list(universes, 'universes', options),
    listSeries: async options => list(series, 'series', options),
    listIssues: async options => {
      expect(options.paginated).toBe(true);
      const key = options.seriesId ? 'children' : 'all-issues';
      if (failures.has(`${key}:${options.offset}`)) throw new Error('Later issue page unavailable');
      const rows = list(issues, key, options).filter(i => !options.seriesId || i.seriesId === options.seriesId);
      return { items: rows.slice(options.offset, options.offset + pageSize), total: rows.length };
    },
    deleteUniverse: remove(universes, 'universe'),
    deleteSeries: remove(series, 'series'),
    deleteIssue: remove(issues, 'issue'),
  };
  const run = async (apply = true) => {
    const logs = [];
    const errors = [];
    const code = await runCleanupTestData({
      argv: ['node', 'cleanup-test-data.js', ...(apply ? ['--apply'] : [])],
      services,
      output: { log: line => logs.push(line), error: line => errors.push(line) },
    });
    return { code, logs: logs.join('\n'), errors: errors.join('\n') };
  };
  return { universes, series, issues, failures, attempts, completed, run };
}

const ORDER = [
  `universe:${U}`,
  'universe:fixture-universe',
  `issue:${CHILD_A}`,
  `issue:${CHILD_B}`,
  `series:${S}`,
  'issue:iss-fixture-child',
  'series:ser-fixture',
  'issue:iss-fixture-orphan',
];

function expectFailure(result) {
  expect(result.code).toBe(1);
  expect(result.errors).toContain('cleanup-test-data failed');
  expect(result.logs).not.toMatch(/✅|DRY-RUN complete|Now restart/);
}

describe('fixture cleanup CLI workflow', () => {
  it('defaults to dry-run, preserves selection and real records, and applies children before parents exactly once', async () => {
    const store = fixtureStore();
    const dry = await store.run(false);
    expect(dry.code).toBe(0);
    expect(dry.errors).toBe('');
    expect(store.attempts).toEqual([]);
    expect(dry.logs).toContain('DRY-RUN complete');

    const applied = await store.run();
    expect(applied.code).toBe(0);
    expect(applied.errors).toBe('');
    const targetLines = result => result.logs.split('\n').filter(line => /to delete:|cascading|Orphan fixture|^   - /.test(line));
    expect(targetLines(applied)).toEqual(targetLines(dry));
    expect(store.completed).toEqual(ORDER);
    expect(applied.logs).toContain('✅ Tombstoned 2 universe(s) + 2 series + 4 issue(s).');
    expect(store.universes.find(u => u.id === uuid(7)).deleted).toBeUndefined();
    expect(store.series.find(s => s.id === REAL_S).deleted).toBeUndefined();
    expect(store.issues.find(i => i.id === REAL_I).deleted).toBeUndefined();

    const rerun = await store.run();
    expect(rerun.code).toBe(0);
    expect(rerun.logs).toContain('✅ Tombstoned 0 universe(s) + 0 series + 0 issue(s).');
    expect(store.attempts).toEqual(ORDER);
  });

  it.each(['universes', 'series', 'children', 'all-issues'])('refuses all writes when %s enumeration fails', async key => {
    const store = fixtureStore();
    store.failures.add(key);
    expectFailure(await store.run());
    expect(store.attempts).toEqual([]);
    expect(store.completed).toEqual([]);
    expectFailure(await store.run(false));
    expect(store.attempts).toEqual([]);
  });

  it('plans every page before deleting a parent with over 1000 children or a late orphan', async () => {
    const store = fixtureStore();
    const extraChildren = Array.from({ length: 1001 }, (_, index) => ({
      id: `iss-${uuid(index + 100)}`, seriesId: S, number: index + 3,
    }));
    store.issues.push(...extraChildren, { id: 'iss-late-orphan', seriesId: REAL_S, number: 3 });
    const result = await store.run();
    expect(result.code).toBe(0);
    const parentPosition = store.completed.indexOf(`series:${S}`);
    expect(store.completed.slice(2, parentPosition)).toEqual(
      [CHILD_A, CHILD_B, ...extraChildren.map(child => child.id)].map(id => `issue:${id}`),
    );
    expect(store.completed).toContain('issue:iss-late-orphan');
    expect(result.logs).toContain('✅ Tombstoned 2 universe(s) + 2 series + 1006 issue(s).');
  });

  it.each(['children:2', 'all-issues:2'])('refuses all writes if a later %s page is unavailable', async key => {
    const store = fixtureStore(2);
    store.issues.push({ id: `iss-${uuid(20)}`, seriesId: S, number: 3 });
    store.failures.add(key);
    expectFailure(await store.run());
    expect(store.attempts).toEqual([]);
  });

  it('keeps the parent and remaining UUID child live after a child failure, then retries only remaining work', async () => {
    const store = fixtureStore();
    store.failures.add(`issue:${CHILD_B}`);
    const failed = await store.run();
    expectFailure(failed);
    expect(failed.errors).toContain('Failed to delete issue');
    expect(store.attempts).toEqual(ORDER.slice(0, 4));
    expect(store.completed).toEqual(ORDER.slice(0, 3));
    expect(store.issues.find(i => i.id === CHILD_B).deleted).toBeUndefined();
    expect(store.series.find(s => s.id === S).deleted).toBeUndefined();

    store.failures.clear();
    const retry = await store.run();
    expect(retry.code).toBe(0);
    expect(retry.logs).toContain('✅ Tombstoned 0 universe(s) + 2 series + 3 issue(s).');
    expect(store.completed).toEqual(ORDER);
    expect(store.attempts.slice(4)).toEqual(ORDER.slice(3));
    expect((await store.run()).code).toBe(0);
    expect(store.completed).toEqual(ORDER);
  });

  it.each([
    ['universe', 1],
    ['series', 4],
    ['orphan issue', 7],
  ])('stops on failed %s deletion without counting it, and safely resumes', async (kind, index) => {
    const store = fixtureStore();
    store.failures.add(ORDER[index]);
    const failed = await store.run();
    expectFailure(failed);
    expect(failed.errors).toContain(`Failed to delete ${kind}`);
    expect(store.attempts).toEqual(ORDER.slice(0, index + 1));
    expect(store.completed).toEqual(ORDER.slice(0, index));
    store.failures.clear();
    const retry = await store.run();
    expect(retry.code).toBe(0);
    expect(store.attempts.slice(index + 1)).toEqual(ORDER.slice(index));
    expect(store.completed).toEqual(ORDER);
    expect((await store.run()).code).toBe(0);
    expect(store.completed).toEqual(ORDER);
  });
});
