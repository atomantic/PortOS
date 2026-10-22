import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { runMigrations, listPendingMigrations } from '../../scripts/run-migrations.js';

const state = vi.hoisted(() => ({ liveData: null }));
vi.mock('../lib/fileUtils.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: () => state.liveData }));

const { snapshotLegacySplitStores, describeLegacySplitStores, convertRestoredLegacySplitStores } = await import('./backupLegacyStores.js');

// The real, frozen migrations whose order #12813 is about, re-exported from a
// scratch directory so the run stays bounded to them.
const REAL_MIGRATIONS = [
  '021-link-orphan-universe-collections.js',
  '038-canonicalize-linked-collection-ids.js',
  '059-split-media-collections.js',
  '080-brain-tombstone-and-synclog-cleanup.js',
  '081-brain-daily-log-inbox-sync.js',
  '190-seed-songbook-songs.js',
  '200-split-brain-stores-to-per-record.js',
];
const LATER = '999-later-example.js';
const migrationsRoot = new URL('../../scripts/migrations/', import.meta.url);

const writeJson = (path, value) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};
const read = path => readFileSync(path, 'utf8');

describe('restore of a snapshot from before a store split replays earlier migrations in order (#12813)', () => {
  let base;
  let migrationsDir;
  let snapshotRoot;
  let liveRoot;
  let directRoot;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-01T12:00:00.000Z'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    base = createTempDataRoot('portos-legacy-stores-');
    migrationsDir = join(base, 'migrations');
    mkdirSync(migrationsDir);
    for (const file of REAL_MIGRATIONS) {
      writeFileSync(join(migrationsDir, file), `export { default } from ${JSON.stringify(new URL(file, migrationsRoot).href)};`);
    }
    writeFileSync(join(migrationsDir, LATER), `
import { writeFileSync } from 'fs';
import { join } from 'path';
export default { up({ rootDir }) { writeFileSync(join(rootDir, 'data', 'later-marker.txt'), 'ran'); } };
`);
    snapshotRoot = join(base, 'snapshot');
    liveRoot = join(base, 'live');
    directRoot = join(base, 'direct');
    state.liveData = join(liveRoot, 'data');

    // A current, fully migrated install with records of its own.
    const live = state.liveData;
    for (const type of ['inbox', 'journals', 'people']) {
      writeJson(join(live, 'brain', type, 'index.json'), { schemaVersion: 1, type, config: {} });
    }
    writeJson(join(live, 'brain', 'inbox', 'inb-live-1', 'index.json'), { text: 'Live capture' });
    writeJson(join(live, 'media-collections', 'index.json'), { schemaVersion: 1, type: 'mediaCollections', config: {} });
    writeJson(join(live, 'migrations.applied.json'), [...REAL_MIGRATIONS, LATER]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(base, { recursive: true, force: true });
  });

  /** Restore `snapshotRoot` into the live install the way a full restore does. */
  async function restore() {
    const ledger = JSON.parse(read(join(snapshotRoot, 'data', 'migrations.applied.json')));
    const legacy = await snapshotLegacySplitStores(join(snapshotRoot, 'data'), undefined, { ledger, migrationsDir });
    const preview = describeLegacySplitStores(legacy);
    cpSync(join(snapshotRoot, 'data'), state.liveData, { recursive: true }); // rsync is additive
    const result = await convertRestoredLegacySplitStores(legacy, { migrationsDir });
    return { preview, result };
  }

  async function upgradeDirectly() {
    cpSync(snapshotRoot, directRoot, { recursive: true });
    await runMigrations({ rootDir: directRoot, migrationsDir });
  }

  it('builds and splits the inbox and normalizes journals exactly as an upgrade of the same root', async () => {
    const data = join(snapshotRoot, 'data');
    writeJson(join(data, 'migrations.applied.json'), REAL_MIGRATIONS.slice(0, 3));
    mkdirSync(join(data, 'brain'), { recursive: true });
    writeFileSync(join(data, 'brain', 'inbox_log.jsonl'), `${JSON.stringify({ id: 'inb-example-1', text: 'Example capture', capturedAt: '2025-03-01T09:00:00.000Z' })}\n`);
    writeJson(join(data, 'brain', 'journals.json'), { records: {
      '2025-03-01': { id: 'jrnl-example-uuid', date: '2025-03-01', content: 'Example day', obsidianPath: 'Daily/2025-03-01.md' },
    } });

    const { preview, result } = await restore();

    expect(preview.migrations).toEqual({
      status: 'pending',
      through: '200-split-brain-stores-to-per-record.js',
      names: REAL_MIGRATIONS.slice(3),
    });
    expect(result.migrations).toEqual({ ...preview.migrations, status: 'applied' });
    expect(result.stores.map(({ store, status }) => [store, status])).toEqual([
      ['brain/people', 'converted'], ['brain/journals', 'converted'], ['brain/inbox', 'converted'],
    ]);
    // The replay stops at the split; the next boot runs what follows.
    await expect(listPendingMigrations({ rootDir: liveRoot, migrationsDir })).resolves.toEqual([LATER]);
    expect(existsSync(join(state.liveData, 'later-marker.txt'))).toBe(false);
    await runMigrations({ rootDir: liveRoot, migrationsDir });
    await upgradeDirectly();

    for (const record of ['brain/inbox/inb-example-1/index.json', 'brain/journals/2025-03-01/index.json']) {
      expect(read(join(state.liveData, record))).toBe(read(join(directRoot, 'data', record)));
    }
    const journal = JSON.parse(read(join(state.liveData, 'brain/journals/2025-03-01/index.json')));
    expect(journal).not.toHaveProperty('id');
    expect(journal).toMatchObject({ createdAt: expect.any(String), updatedAt: expect.any(String) });
    expect(existsSync(join(state.liveData, 'brain', 'inbox', 'inb-live-1'))).toBe(false);
    const parkedInbox = result.stores.find(store => store.store === 'brain/inbox').parkedAs;
    expect(JSON.parse(read(join(state.liveData, parkedInbox, 'inb-live-1', 'index.json')))).toEqual({ text: 'Live capture' });
  });

  it('runs 021 and 038 before splitting a pre-059 media-collections store', async () => {
    const data = join(snapshotRoot, 'data');
    writeJson(join(data, 'migrations.applied.json'), []);
    writeJson(join(data, 'universe-builder.json'), { universes: [{ id: 'uni-example', name: 'Example' }] });
    writeJson(join(data, 'media-collections.json'), { collections: [{ id: 'col-example', name: 'universe: example', items: [] }] });

    const { result } = await restore();

    expect(result.migrations).toMatchObject({ status: 'applied', through: '059-split-media-collections.js', names: REAL_MIGRATIONS.slice(0, 3) });
    await runMigrations({ rootDir: liveRoot, migrationsDir });
    await upgradeDirectly();

    // 021 links the collection to its universe; 038 then re-keys it to the canonical id.
    const record = 'media-collections/uc-uni-example/index.json';
    expect(read(join(state.liveData, record))).toBe(read(join(directRoot, 'data', record)));
    expect(JSON.parse(read(join(state.liveData, record)))).toMatchObject({ universeId: 'uni-example', name: 'Universe: Example' });
  });

  it('converts with the split alone when the restored ledger already records it', async () => {
    const data = join(snapshotRoot, 'data');
    writeJson(join(data, 'migrations.applied.json'), REAL_MIGRATIONS);
    writeJson(join(data, 'brain', 'people.json'), { records: { 'p-example': { name: 'Example Person' } } });

    const { preview, result } = await restore();

    expect(preview.migrations).toBeNull();
    expect(result).toMatchObject({ migrations: null, stores: [{ store: 'brain/people', status: 'converted' }] });
    expect(JSON.parse(read(join(state.liveData, 'brain', 'people', 'p-example', 'index.json')))).toEqual({ name: 'Example Person' });
    // Stores the snapshot carries no monolith for are left alone without a replay.
    expect(existsSync(join(state.liveData, 'brain', 'inbox', 'inb-live-1'))).toBe(true);
  });

  it('keeps a folder restore to the snapshot monoliths and never replays', async () => {
    const data = join(snapshotRoot, 'data');
    writeJson(join(data, 'brain', 'journals.json'), { records: { '2025-03-01': { date: '2025-03-01' } } });
    const legacy = await snapshotLegacySplitStores(data, 'brain', { ledger: [], migrationsDir });
    expect(legacy.migrations).toBeNull();
    expect(legacy.stores.map(entry => entry.store)).toEqual(['brain/journals']);
  });
});
