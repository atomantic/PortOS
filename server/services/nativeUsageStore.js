/**
 * Persistence for collected native usage (#15255): one projection per source file,
 * plus whole-document snapshots. PostgreSQL is authoritative in a normal install;
 * the per-file JSON backend exists only for the documented dev/test escape hatch.
 * Machine-local, and holds hashed identities and counters only.
 */
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite, PATHS, readJSONFile } from '../lib/fileUtils.js';
import { toPgJson } from '../lib/pgJson.js';
import { createPgFileFacade, resolvePgBackend, POSTGRES_SETUP_HINT } from '../lib/pgFileFacade.js';

const rootDir = () => join(PATHS.data, 'native-usage');
const sourceDir = family => join(rootDir(), 'sources', family);
const snapshotPath = (kind, key) => join(rootDir(), 'snapshots', kind, `${key}.json`);
const listDirectories = dir => readdir(dir).catch(error => {
  if (error.code === 'ENOENT') return [];
  throw error;
});
const listJson = async dir => (await listDirectories(dir)).filter(name => name.endsWith('.json')).sort();
const readRow = path => readJSONFile(path, null, { logError: false, strict: true });
const readRows = async family => {
  const rows = await Promise.all((await listJson(sourceDir(family))).map(name => readRow(join(sourceDir(family), name))));
  return rows.filter(Boolean);
};

function makeFileBackend() {
  return {
    name: 'file',
    listSourceFacts: readRows,
    saveSource: ({ family, sourceKey, ...row }) => atomicWrite(join(sourceDir(family), `${sourceKey}.json`), { sourceKey, ...row, rereadRequested: false }),
    loadSourceProjections: readRows,
    async requestSourceReread() {
      for (const family of await listDirectories(join(rootDir(), 'sources'))) {
        for (const row of await readRows(family)) await atomicWrite(join(sourceDir(family), `${row.sourceKey}.json`), { ...row, rereadRequested: true });
      }
    },
    getSnapshot: (kind, key) => readRow(snapshotPath(kind, key)),
    saveSnapshot: (kind, key, payload) => atomicWrite(snapshotPath(kind, key), payload),
  };
}

function makePgBackend(db) {
  return {
    name: 'postgres',
    async listSourceFacts(family) {
      const { rows } = await db.query(
        'SELECT source_key, size_bytes, mtime_ns, validator, reread_requested FROM native_usage_sources WHERE family = $1',
        [family],
      );
      return rows.map(row => ({ sourceKey: row.source_key, sizeBytes: String(row.size_bytes), mtimeNs: String(row.mtime_ns),
        validator: row.validator, rereadRequested: row.reread_requested }));
    },
    async saveSource({ family, sourceKey, sizeBytes, mtimeNs, validator, projection }) {
      await db.query(
        `INSERT INTO native_usage_sources (family, source_key, size_bytes, mtime_ns, validator, reread_requested, projection, collected_at)
         VALUES ($1, $2, $3, $4, $5, FALSE, $6::jsonb, NOW())
         ON CONFLICT (family, source_key) DO UPDATE SET size_bytes = EXCLUDED.size_bytes, mtime_ns = EXCLUDED.mtime_ns,
           validator = EXCLUDED.validator, reread_requested = FALSE, projection = EXCLUDED.projection, collected_at = NOW()`,
        [family, sourceKey, sizeBytes, mtimeNs, validator, toPgJson(projection)],
      );
    },
    async loadSourceProjections(family) {
      const { rows } = await db.query(
        'SELECT source_key, validator, projection FROM native_usage_sources WHERE family = $1 ORDER BY source_key',
        [family],
      );
      return rows.map(row => ({ sourceKey: row.source_key, validator: row.validator, projection: row.projection }));
    },
    async requestSourceReread() {
      await db.query('UPDATE native_usage_sources SET reread_requested = TRUE');
    },
    async getSnapshot(kind, key) {
      const { rows } = await db.query('SELECT payload FROM native_usage_snapshots WHERE kind = $1 AND snapshot_key = $2', [kind, key]);
      return rows[0]?.payload ?? null;
    },
    async saveSnapshot(kind, key, payload) {
      await db.query(
        `INSERT INTO native_usage_snapshots (kind, snapshot_key, payload, collected_at) VALUES ($1, $2, $3::jsonb, NOW())
         ON CONFLICT (kind, snapshot_key) DO UPDATE SET payload = EXCLUDED.payload, collected_at = NOW()`,
        [kind, key, toPgJson(payload)],
      );
    },
  };
}

const facade = createPgFileFacade({
  makeFile: makeFileBackend,
  makePg: () => resolvePgBackend({
    requirement: `The native usage store requires PostgreSQL — ${POSTGRES_SETUP_HINT}`,
    loadDb: () => import('../lib/db.js'),
    makePg: makePgBackend,
  }),
});

/** Size, mtime and validator of each stored source, without loading its projection. */
export const listNativeUsageSourceFacts = async family => (await facade.getBackend()).listSourceFacts(family);
export const saveNativeUsageSource = async row => (await facade.getBackend()).saveSource(row);
export const loadNativeUsageSourceProjections = async family => (await facade.getBackend()).loadSourceProjections(family);
/** Marks every stored source for a re-read; one whose file is gone keeps counting. */
export const requestNativeUsageSourceReread = async () => (await facade.getBackend()).requestSourceReread();
export const getNativeUsageSnapshot = async (kind, key) => (await facade.getBackend()).getSnapshot(kind, key);
export const saveNativeUsageSnapshot = async (kind, key, payload) => (await facade.getBackend()).saveSnapshot(kind, key, payload);

/** Test seam: forget the backend and clear the file store under the current data root. */
export async function _resetNativeUsageStore() {
  facade.reset();
  await rm(rootDir(), { recursive: true, force: true });
}
