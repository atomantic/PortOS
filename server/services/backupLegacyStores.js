/**
 * Restore-time conversion of stores a snapshot carries in a layout older than a
 * split migration (#12626).
 *
 * Migrations 059 and 200 split monolithic stores into per-record directories
 * and gate on their OUTPUT: a type index already at v1 makes them a no-op. A
 * restore copies a pre-split snapshot's monolith back without removing the live
 * per-record directory (file restore is additive), so the boot re-run finds the
 * live index, skips, and the restored records are never read. Folder restores
 * keep the live ledger and never re-run the migration at all.
 *
 * So after a successful transfer the live directory is parked as
 * `<typeDir>.pre-restore-<timestamp>` and the frozen migration runs against the
 * install immediately, splitting the restored monolith exactly as an upgrade
 * would have. The migrations are invoked, never re-implemented, so a restore
 * converts with the same semantics the install crossed when it upgraded.
 *
 * A full restore whose ledger lacks the split also lacks the migrations an
 * upgrade ran BEFORE it (081 builds `brain/inbox.json` from `inbox_log.jsonl`
 * and normalizes journals). Running the split alone and leaving those to the
 * next boot would run them after it, writing monoliths nothing reads (#12813).
 * So that restore replays the restored ledger's pending migrations through the
 * split with the real runner, and parks every live store of that split the
 * snapshot carries no split index for, so the result is an in-order upgrade.
 */
import { rename, stat } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { PATHS, readJSONFileStrict } from '../lib/fileUtils.js';
import { DEFAULT_MIGRATIONS_DIR, appliedFilePath, readAppliedList, scanMigrationFiles } from '../../scripts/lib/migrationLedger.js';

// Frozen with the migrations they invoke: migration 200's type list as of 200.
const BRAIN_SPLIT_TYPES = [
  'people', 'projects', 'ideas', 'admin', 'memories', 'links', 'buckets',
  'journals', 'inbox', 'songs',
];

const BRAIN_SPLIT_MIGRATION = '200-split-brain-stores-to-per-record.js';
const MEDIA_COLLECTIONS_SPLIT_MIGRATION = '059-split-media-collections.js';
const loadBrainSplit = () => import('../../scripts/migrations/200-split-brain-stores-to-per-record.js');
const loadMediaCollectionsSplit = () => import('../../scripts/migrations/059-split-media-collections.js');

const LEGACY_SPLIT_STORES = Object.freeze([
  ...BRAIN_SPLIT_TYPES.map(type => ({
    store: `brain/${type}`,
    scopes: ['brain', `brain/${type}.json`],
    legacyFile: `brain/${type}.json`,
    backupSuffix: '.bak-200',
    migration: BRAIN_SPLIT_MIGRATION,
    loadMigration: loadBrainSplit,
    // Earlier migrations create some Brain monoliths (081 the inbox, 190 the
    // songs), so a replay converts a type the snapshot has no monolith for.
    replayRoot: 'brain',
    // Migration 200 throws on a records container that is present but not a map.
    readable: doc => doc.records == null || (typeof doc.records === 'object' && !Array.isArray(doc.records)),
  })),
  {
    store: 'media-collections',
    scopes: ['media-collections', 'media-collections.json'],
    legacyFile: 'media-collections.json',
    backupSuffix: '.bak-059',
    migration: MEDIA_COLLECTIONS_SPLIT_MIGRATION,
    loadMigration: loadMediaCollectionsSplit,
    replayRoot: null,
    readable: () => true,
  },
]);

const exists = path => stat(path).then(
  () => true,
  error => { if (error.code === 'ENOENT') return false; throw error; },
);

/**
 * The split stores a restore of `scope` installs in their pre-split layout: the
 * snapshot carries the monolith but no `<typeDir>/index.json`. A snapshot with
 * both carries a stray monolith setup-data re-seeded after the split, which is
 * not legacy. An unreadable monolith is reported but never converted, so its
 * live store is not parked for a split that would throw.
 *
 * `ledger` is the snapshot's migration ledger, passed only for a full restore
 * (which installs it). When it lacks a split migration, the restore replays the
 * ledger's pending migrations through that split (`migrations`), and every live
 * store of that split the snapshot has no split index for is converted too.
 */
export async function snapshotLegacySplitStores(srcDir, scope, { ledger = null, migrationsDir = DEFAULT_MIGRATIONS_DIR } = {}) {
  const recorded = !scope && Array.isArray(ledger) ? new Set(ledger) : null;
  const replays = entry => recorded !== null && !recorded.has(entry.migration);
  const stores = [];
  for (const entry of LEGACY_SPLIT_STORES) {
    if (scope && !entry.scopes.includes(scope)) continue;
    if (await exists(join(srcDir, entry.store, 'index.json'))) continue;
    const carriesMonolith = await exists(join(srcDir, entry.legacyFile));
    if (!carriesMonolith) {
      // Only a live store needs parking for a replay to rebuild it.
      const rebuilt = replays(entry) && entry.replayRoot
        && await exists(join(srcDir, entry.replayRoot)) && await exists(join(PATHS.data, entry.store));
      if (!rebuilt) continue;
      stores.push({ ...entry, carriesMonolith, readable: true });
      continue;
    }
    const { ok, value } = await readJSONFileStrict(join(srcDir, entry.legacyFile), null, { logError: false });
    const readable = ok && value !== null && typeof value === 'object' && !Array.isArray(value) && entry.readable(value);
    stores.push({ ...entry, carriesMonolith, readable });
  }
  // Migrations take the install root and join `data/` themselves. Refuse before
  // any transfer, so a store that cannot be converted is never restored over.
  if (stores.some(entry => entry.readable) && basename(PATHS.data) !== 'data') {
    throw new Error(`Cannot convert restored legacy stores: data directory ${PATHS.data} is not <install>/data`);
  }
  const through = stores.filter(entry => entry.readable && replays(entry)).map(entry => entry.migration).sort().at(-1) ?? null;
  const migrations = through ? { through, names: pendingThrough(await scanMigrationFiles(migrationsDir), recorded, through) } : null;
  return { stores, migrations };
}

const pendingThrough = (files, applied, through) => files.slice(0, files.indexOf(through) + 1).filter(file => !applied.has(file));

/** The result-facing projection of `snapshotLegacySplitStores` for a preview. */
export const describeLegacySplitStores = ({ stores, migrations }) => ({
  stores: stores.map(({ store, legacyFile, readable }) => ({
    store, legacyFile, status: readable ? 'pending' : 'unreadable', parkedAs: null,
  })),
  migrations: migrations && { status: 'pending', ...migrations },
});

/**
 * Park each convertible store's live directory (and a live migration backup the
 * split's own rename would overwrite), then run the frozen split migrations:
 * through the runner when the restored ledger lacks the split, alone otherwise.
 * Call only after the transfer and ledger adoption succeeded, inside the
 * live-restore owners.
 */
export async function convertRestoredLegacySplitStores({ stores, migrations }, { migrationsDir = DEFAULT_MIGRATIONS_DIR } = {}) {
  if (stores.length === 0) return { stores: [], migrations: null };
  const rootDir = dirname(PATHS.data);
  // Decided again from the ledger the transfer installed: replaying through a
  // split the live ledger already records would park stores nothing rebuilds.
  const applied = migrations ? new Set(await readAppliedList(appliedFilePath(rootDir))) : new Set();
  const through = migrations && !applied.has(migrations.through) ? migrations.through : null;
  const replays = entry => through !== null && !applied.has(entry.migration);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const results = [];
  const direct = new Set();
  for (const entry of stores) {
    if (!entry.carriesMonolith && !replays(entry)) continue;
    if (!entry.readable) {
      console.warn(`⚠️ Restore left ${entry.legacyFile} in its pre-split layout: the snapshot copy is unreadable`);
      results.push({ store: entry.store, legacyFile: entry.legacyFile, status: 'unreadable', parkedAs: null });
      continue;
    }
    const liveDir = join(PATHS.data, entry.store);
    const parkedAs = `${entry.store}.pre-restore-${stamp}`;
    const parked = await rename(liveDir, join(PATHS.data, parkedAs)).then(
      () => true,
      error => { if (error.code === 'ENOENT') return false; throw error; },
    );
    const liveBackup = join(PATHS.data, `${entry.legacyFile}${entry.backupSuffix}`);
    if (await exists(liveBackup)) await rename(liveBackup, `${liveBackup}.pre-restore-${stamp}`);
    results.push({ store: entry.store, legacyFile: entry.legacyFile, status: 'converted', parkedAs: parked ? parkedAs : null });
    if (!replays(entry)) direct.add(entry.loadMigration);
  }

  const failed = (error) => {
    const parked = results.filter(result => result.parkedAs).map(result => result.parkedAs);
    return new Error(`Converting restored legacy stores failed: ${error.message}${parked.length ? `. Previous stores are parked as ${parked.join(', ')}` : ''}`, { cause: error });
  };
  let replayed = null;
  if (through !== null) {
    const names = pendingThrough(await scanMigrationFiles(migrationsDir), applied, through);
    const { runMigrations } = await import('../../scripts/run-migrations.js');
    await runMigrations({ rootDir, migrationsDir, through }).catch((error) => { throw failed(error); });
    // The runner skips silently for some roots (a worktree checkout); a split
    // it never recorded left the parked stores unrebuilt.
    if (!(await readAppliedList(appliedFilePath(rootDir))).includes(through)) {
      throw failed(new Error(`the migration run did not apply ${through}`));
    }
    replayed = { status: 'applied', through, names };
  }
  // One run per migration: 200 splits every Brain type, and a type whose live
  // index was not parked is a gate-1 no-op.
  for (const load of direct) {
    const { default: migration } = await load();
    await migration.up({ rootDir }).catch((error) => { throw failed(error); });
  }
  for (const result of results.filter(result => result.status === 'converted')) {
    console.log(`📦 Restore converted ${result.legacyFile} to per-record files${result.parkedAs ? `; previous store parked as ${result.parkedAs}` : ''}`);
  }
  return { stores: results, migrations: replayed };
}
