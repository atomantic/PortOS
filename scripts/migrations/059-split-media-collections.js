/**
 * Split the monolithic `data/media-collections.json` into per-record files
 * under `data/media-collections/{id}/index.json`, with a type-level
 * `data/media-collections/index.json` stamping `schemaVersion: 1`.
 *
 * Why:
 *   The legacy single-file shape (`{ collections: [...] }`) serialized every
 *   write across every collection through one file-level queue and rewrote the
 *   whole ~200 KB document per item. High-frequency render-filing (pipeline
 *   cover filer, Universe Builder completion hook, image-gen auto-file) calls
 *   `addItem` constantly, so unrelated writes blocked each other. The new
 *   per-record layout reads/writes one collection at a time and per-id writes
 *   don't serialize against each other. See `server/lib/collectionStore.js`.
 *
 * What changes on disk:
 *
 *     before:                              after:
 *     data/                                data/
 *     └── media-collections.json           ├── media-collections/
 *                                          │   ├── index.json     (schemaVersion: 1)
 *                                          │   ├── <id-1>/
 *                                          │   │   └── index.json (the collection record)
 *                                          │   └── <id-2>/
 *                                          │       └── index.json
 *                                          └── media-collections.json.bak-059
 *
 * The legacy file is RENAMED, not deleted — recovery path stays open. A later
 * migration (or manual cleanup) can remove `.bak-059` once validated.
 *
 * Idempotency: a re-run after partial completion safely finishes the split; a
 * re-run after full completion is a no-op.
 *
 * Unlike universes, collections carry no cross-record type-level state (there is
 * no `runs[]` analog), so the type index `config` is an empty object. Collection
 * records carry no record-shape `schemaVersion` — only the type-level layout
 * version (1, this migration's stamp) applies.
 */

import { readFile, writeFile, rename, mkdir, stat, readdir } from 'fs/promises';
import { join } from 'path';

const TYPE_DIR_NAME = 'media-collections';
const LEGACY_FILENAME = 'media-collections.json';
const BACKUP_SUFFIX = '.bak-059';
const TYPE_SCHEMA_VERSION = 1;
const TYPE_LABEL = 'mediaCollections';

const fileExists = (path) => stat(path).then(() => true, (err) => {
  if (err.code === 'ENOENT') return false;
  throw err;
});

// Two read variants so we distinguish "missing file" from "present but
// unparseable" — the latter is a recovery-required state we report through
// the migration's return value rather than crashing the boot.
const readJsonStrict = async (path) => {
  const raw = await readFile(path, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return null;
  return JSON.parse(raw);
};

const readJsonTolerant = async (path) => {
  const raw = await readFile(path, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return { __unreadable: true }; }
};

const writeJson = (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + '\n');

// Match the collectionStore default `idPattern` so a record whose id the store
// would accept gets split, and one it would reject (and silently drop from
// listIds) is left in the backup for manual recovery rather than written to a
// directory the store can never load. Collection ids are random UUIDs or the
// deterministic `uc-<universeId>` / `sc-<seriesId>` forms — all match.
const VALID_COLLECTION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export default {
  async up({ rootDir }) {
    const dataDir = join(rootDir, 'data');
    const typeDir = join(dataDir, TYPE_DIR_NAME);
    const typeIndexPath = join(typeDir, 'index.json');
    const legacyPath = join(dataDir, LEGACY_FILENAME);
    const backupPath = legacyPath + BACKUP_SUFFIX;

    // Idempotency gate 1: type index already at v1 → nothing to do. A re-run
    // after full success lands here. Read strictly — a corrupted index.json
    // is unexpected and we want the loud throw at this layer.
    const typeIndex = await readJsonStrict(typeIndexPath);
    if (typeIndex && typeIndex.schemaVersion >= TYPE_SCHEMA_VERSION) {
      console.log(`📦 migration 059: media-collections already at schemaVersion=${typeIndex.schemaVersion} — no-op`);
      return { ok: true, reason: 'already-applied' };
    }

    const legacyExists = await fileExists(legacyPath);
    const backupExists = await fileExists(backupPath);

    // Idempotency gate 2: fresh install — no legacy file, no backup, just
    // stamp the type index so verifyCollectionVersions doesn't flag missing.
    if (!legacyExists && !backupExists) {
      await mkdir(typeDir, { recursive: true });
      await writeJson(typeIndexPath, {
        schemaVersion: TYPE_SCHEMA_VERSION,
        type: TYPE_LABEL,
        updatedAt: new Date().toISOString(),
        config: {},
      });
      console.log(`📦 migration 059: fresh install — stamped data/media-collections/index.json @ v${TYPE_SCHEMA_VERSION}`);
      return { ok: true, reason: 'fresh-install' };
    }

    // Recovery gate: the previous run split records but didn't finish renaming
    // the legacy file. Use whichever file is present as the source of truth —
    // prefer the live file if both somehow exist (split must not have happened).
    const sourcePath = legacyExists ? legacyPath : backupPath;
    const doc = await readJsonTolerant(sourcePath);
    if (!doc || typeof doc !== 'object' || doc.__unreadable) {
      // THROW (don't return) so the runner does NOT mark this migration applied
      // — it records any migration whose up() *resolves* (run-migrations.js:70-71),
      // so returning here would freeze the split as "done" with nothing migrated,
      // and the collections would stay orphaned in the unreadable file even after
      // the user repairs it. Throwing keeps it pending so a repaired file is
      // re-split on the next boot; server boot itself survives via the
      // runMigrations().catch() in server/index.js.
      throw new Error(`migration 059: ${sourcePath} is unreadable — repair or remove it, then reboot to retry the split`);
    }

    const collections = Array.isArray(doc.collections) ? doc.collections : [];

    // Pre-flight: find any already-split records so we don't double-write the
    // ones we've already moved. Helps partial-completion recovery. Use
    // `withFileTypes: true` so we skip stray non-directory entries without
    // statting INTO them (an ENOTDIR would crash the whole migration).
    const existingIds = new Set();
    if (await fileExists(typeDir)) {
      const entries = await readdir(typeDir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const name = entry.name;
        if (name === 'index.json' || name.startsWith('.')) continue;
        if (!entry.isDirectory()) continue;
        const candidatePath = join(typeDir, name, 'index.json');
        if (await fileExists(candidatePath)) existingIds.add(name);
      }
    }

    await mkdir(typeDir, { recursive: true });

    let written = 0;
    let skipped = 0;
    let invalid = 0;
    for (const record of collections) {
      if (!record || typeof record !== 'object') {
        invalid += 1;
        continue;
      }
      const id = typeof record.id === 'string' ? record.id : null;
      if (!id || !VALID_COLLECTION_ID.test(id)) {
        invalid += 1;
        console.warn(`⚠️ migration 059: skipping record with invalid id "${id}" (left in backup for manual recovery)`);
        continue;
      }
      if (existingIds.has(id)) {
        // Already split — either in a prior partial run (trust the on-disk
        // per-record file, which may hold fresher post-crash state) OR earlier
        // in THIS loop (a duplicate id within the legacy array). For the
        // duplicate case this preserves the old monolithic `listCollections`
        // first-wins dedup (`seen.has(id)` → skip), so the upgrade can't flip
        // which record survives (live vs tombstone, or item membership).
        skipped += 1;
        continue;
      }
      const recordDir = join(typeDir, id);
      await mkdir(recordDir, { recursive: true });
      await writeJson(join(recordDir, 'index.json'), record);
      existingIds.add(id); // first-wins: later duplicates of this id are skipped above
      written += 1;
    }

    // Stamp the type-level index AFTER all records land so a crash mid-split
    // leaves the type index missing — the next boot's gate 1 won't trip, and
    // gate 2/recovery re-runs the loop.
    await writeJson(typeIndexPath, {
      schemaVersion: TYPE_SCHEMA_VERSION,
      type: TYPE_LABEL,
      updatedAt: new Date().toISOString(),
      config: {},
    });

    // Backup the legacy file. Skip if it's already been backed up (recovery
    // path was driven from the backup). Renaming preserves data; manual
    // restore is `mv media-collections.json.bak-059 media-collections.json`.
    if (legacyExists) {
      await rename(legacyPath, backupPath);
    }

    console.log(
      `📦 migration 059: split ${written} collection(s) into data/media-collections/<id>/index.json ` +
      `(${skipped} already split, ${invalid} invalid); stamped index.json @ v${TYPE_SCHEMA_VERSION}; ` +
      `legacy file backed up as ${LEGACY_FILENAME}${BACKUP_SUFFIX}`,
    );

    return { ok: true, reason: 'split', written, skipped, invalid };
  },
};
