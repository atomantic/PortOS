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
 */
import { rename, stat } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { PATHS, readJSONFileStrict } from '../lib/fileUtils.js';

// Frozen with the migrations they invoke: migration 200's type list as of 200.
const BRAIN_SPLIT_TYPES = [
  'people', 'projects', 'ideas', 'admin', 'memories', 'links', 'buckets',
  'journals', 'inbox', 'songs',
];

const loadBrainSplit = () => import('../../scripts/migrations/200-split-brain-stores-to-per-record.js');
const loadMediaCollectionsSplit = () => import('../../scripts/migrations/059-split-media-collections.js');

const LEGACY_SPLIT_STORES = Object.freeze([
  ...BRAIN_SPLIT_TYPES.map(type => ({
    store: `brain/${type}`,
    scopes: ['brain', `brain/${type}.json`],
    legacyFile: `brain/${type}.json`,
    backupSuffix: '.bak-200',
    loadMigration: loadBrainSplit,
    // Migration 200 throws on a records container that is present but not a map.
    readable: doc => doc.records == null || (typeof doc.records === 'object' && !Array.isArray(doc.records)),
  })),
  {
    store: 'media-collections',
    scopes: ['media-collections', 'media-collections.json'],
    legacyFile: 'media-collections.json',
    backupSuffix: '.bak-059',
    loadMigration: loadMediaCollectionsSplit,
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
 */
export async function snapshotLegacySplitStores(srcDir, scope) {
  const found = [];
  for (const entry of LEGACY_SPLIT_STORES) {
    if (scope && !entry.scopes.includes(scope)) continue;
    if (!await exists(join(srcDir, entry.legacyFile))) continue;
    if (await exists(join(srcDir, entry.store, 'index.json'))) continue;
    const { ok, value } = await readJSONFileStrict(join(srcDir, entry.legacyFile), null, { logError: false });
    const readable = ok && value !== null && typeof value === 'object' && !Array.isArray(value) && entry.readable(value);
    found.push({ ...entry, readable });
  }
  return found;
}

/** The result-facing projection of `snapshotLegacySplitStores` for a preview. */
export const describeLegacySplitStores = stores => stores.map(({ store, legacyFile, readable }) => ({
  store, legacyFile, status: readable ? 'pending' : 'unreadable', parkedAs: null,
}));

/**
 * Park each convertible store's live directory (and a live migration backup the
 * split's own rename would overwrite), then run the frozen split migrations.
 * Call only after the transfer succeeded, inside the live-restore owners.
 */
export async function convertRestoredLegacySplitStores(stores) {
  if (stores.length === 0) return [];
  // Migrations take the install root and join `data/` themselves.
  if (basename(PATHS.data) !== 'data') {
    throw new Error(`Cannot convert restored legacy stores: data directory ${PATHS.data} is not <install>/data`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const results = [];
  for (const entry of stores) {
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
  }

  // One run per migration: 200 splits every Brain type, and a type whose live
  // index was not parked is a gate-1 no-op.
  const loaders = [...new Set(stores.filter(entry => entry.readable).map(entry => entry.loadMigration))];
  const rootDir = dirname(PATHS.data);
  for (const load of loaders) {
    const { default: migration } = await load();
    await migration.up({ rootDir }).catch((error) => {
      const parked = results.filter(result => result.parkedAs).map(result => result.parkedAs);
      throw new Error(`Converting restored legacy stores failed: ${error.message}${parked.length ? `. Previous stores are parked as ${parked.join(', ')}` : ''}`, { cause: error });
    });
  }
  for (const result of results.filter(result => result.status === 'converted')) {
    console.log(`📦 Restore converted ${result.legacyFile} to per-record files${result.parkedAs ? `; previous store parked as ${result.parkedAs}` : ''}`);
  }
  return results;
}
