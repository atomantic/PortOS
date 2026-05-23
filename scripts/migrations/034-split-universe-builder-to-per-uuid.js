/**
 * Split the monolithic `data/universe-builder.json` into per-record files
 * under `data/universes/{id}/index.json`, with a type-level
 * `data/universes/index.json` stamping `schemaVersion: 5`.
 *
 * Why:
 *   The legacy single-file shape (`{ universes: [...], runs: [...] }`)
 *   serializes every write across every universe — at 30+ universes and
 *   ~50KB per record, edits to one universe forced a 1.4MB rewrite under
 *   a single-tail queue. The new layout reads/writes one record at a time
 *   and per-id writes don't serialize against each other.
 *
 * What changes on disk:
 *
 *     before:                              after:
 *     data/                                data/
 *     └── universe-builder.json            ├── universes/
 *                                          │   ├── index.json     (schemaVersion: 5, runs[])
 *                                          │   ├── <uuid-1>/
 *                                          │   │   └── index.json (the universe record)
 *                                          │   └── <uuid-2>/
 *                                          │       └── index.json
 *                                          └── universe-builder.json.bak-034
 *
 * The legacy file is RENAMED, not deleted — recovery path stays open if a
 * downstream issue surfaces after the migration runs. Future cleanup (or a
 * later migration) can remove `.bak-034` once the new shape is fully
 * validated in production.
 *
 * Idempotency: a re-run after partial completion (some records split, some
 * not) safely finishes the split. A re-run after full completion is a no-op.
 *
 * Per-record schema:
 *   Each record carries `schemaVersion` (the record-shape version, currently
 *   4) — distinct from the type-level `schemaVersion` (currently 5, this
 *   migration's bump). See `server/lib/collectionStore.js` header for the
 *   distinction between layout-version and record-shape-version.
 */

import { readFile, writeFile, rename, mkdir, stat, readdir } from 'fs/promises';
import { join } from 'path';

const TYPE_DIR_NAME = 'universes';
const LEGACY_FILENAME = 'universe-builder.json';
const BACKUP_SUFFIX = '.bak-034';
const TYPE_SCHEMA_VERSION = 5;
const TYPE_LABEL = 'universes';

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

// Match `UNIVERSE_ID_RE` in server/services/universeBuilder.js so an oddly-id'd
// record (8–80 alphanumerics + hyphens) round-trips through the split without
// being misclassified as a stray directory entry.
const VALID_UNIVERSE_ID = /^[A-Za-z0-9-]{8,80}$/;

export default {
  async up({ rootDir }) {
    const dataDir = join(rootDir, 'data');
    const typeDir = join(dataDir, TYPE_DIR_NAME);
    const typeIndexPath = join(typeDir, 'index.json');
    const legacyPath = join(dataDir, LEGACY_FILENAME);
    const backupPath = legacyPath + BACKUP_SUFFIX;

    // Idempotency gate 1: type index already at v5 → nothing to do. A re-run
    // after full success lands here. Read strictly — a corrupted index.json
    // is unexpected and we want the loud throw at this layer.
    const typeIndex = await readJsonStrict(typeIndexPath);
    if (typeIndex && typeIndex.schemaVersion >= TYPE_SCHEMA_VERSION) {
      console.log(`📦 migration 034: universes already at schemaVersion=${typeIndex.schemaVersion} — no-op`);
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
        config: { runs: [] },
      });
      console.log(`📦 migration 034: fresh install — stamped data/universes/index.json @ v${TYPE_SCHEMA_VERSION}`);
      return { ok: true, reason: 'fresh-install' };
    }

    // Recovery gate: the previous run split records but didn't finish renaming
    // the legacy file. Use whichever file is present as the source of truth —
    // prefer the live file if both somehow exist (split must not have happened).
    const sourcePath = legacyExists ? legacyPath : backupPath;
    const doc = await readJsonTolerant(sourcePath);
    if (!doc || typeof doc !== 'object' || doc.__unreadable) {
      console.warn(`⚠️ migration 034: ${sourcePath} unreadable — skipping. Resolve manually before next boot.`);
      return { ok: false, reason: 'unreadable' };
    }

    const universes = Array.isArray(doc.universes) ? doc.universes : [];
    const runs = Array.isArray(doc.runs) ? doc.runs : [];

    // Pre-flight: find any already-split records so we don't double-write the
    // ones we've already moved. Helps partial-completion recovery.
    // Use `withFileTypes: true` so we skip stray non-directory entries (e.g.
    // user-left `.bak` files, editor swap files) without statting INTO them —
    // `stat('foo.bak/index.json')` would raise ENOTDIR which our fileExists
    // helper rethrows, crashing the whole migration.
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
    for (const record of universes) {
      if (!record || typeof record !== 'object') {
        invalid += 1;
        continue;
      }
      const id = typeof record.id === 'string' ? record.id : null;
      if (!id || !VALID_UNIVERSE_ID.test(id)) {
        invalid += 1;
        console.warn(`⚠️ migration 034: skipping record with invalid id "${id}"`);
        continue;
      }
      if (existingIds.has(id)) {
        // Already split in a prior partial run — leave it alone. The
        // monolithic record may have stale state (in-flight writes after the
        // crash), so trusting the already-split per-record file is safer.
        skipped += 1;
        continue;
      }
      const recordDir = join(typeDir, id);
      await mkdir(recordDir, { recursive: true });
      await writeJson(join(recordDir, 'index.json'), record);
      written += 1;
    }

    // Stamp the type-level index AFTER all records land so a crash mid-split
    // leaves the type index missing — the next boot's gate 1 won't trip, and
    // gate 2/recovery re-runs the loop. Cross-record `runs[]` moves into
    // `config.runs` so it travels with the type-level index.
    await writeJson(typeIndexPath, {
      schemaVersion: TYPE_SCHEMA_VERSION,
      type: TYPE_LABEL,
      updatedAt: new Date().toISOString(),
      config: { runs },
    });

    // Backup the legacy file. Skip if it's already been backed up (recovery
    // path was driven from the backup). Renaming preserves data; manual
    // restore is `mv universe-builder.json.bak-034 universe-builder.json`.
    if (legacyExists) {
      await rename(legacyPath, backupPath);
    }

    console.log(
      `📦 migration 034: split ${written} universe(s) into data/universes/<id>/index.json ` +
      `(${skipped} already split, ${invalid} invalid); stamped index.json @ v${TYPE_SCHEMA_VERSION}; ` +
      `legacy file backed up as ${LEGACY_FILENAME}${BACKUP_SUFFIX}`,
    );

    return { ok: true, reason: 'split', written, skipped, invalid };
  },
};
