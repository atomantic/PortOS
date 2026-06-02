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
 *
 * Shares the split skeleton with 035 / 036 / 059 via `makeSplitMigration`. The
 * only universe-specific bits are the `config.runs` carry-over (cross-record
 * `runs[]` travels with the type-level index) and the id pattern.
 */

import { makeSplitMigration } from './_lib.js';

// Match `UNIVERSE_ID_RE` in server/services/universeBuilder.js so an oddly-id'd
// record (8–80 alphanumerics + hyphens) round-trips through the split without
// being misclassified as a stray directory entry.
const VALID_UNIVERSE_ID = /^[A-Za-z0-9-]{8,80}$/;

export default makeSplitMigration({
  migrationLabel: 'migration 034',
  typeDirName: 'universes',
  legacyFilename: 'universe-builder.json',
  backupSuffix: '.bak-034',
  typeSchemaVersion: 5,
  typeLabel: 'universes',
  recordsKey: 'universes',
  idPattern: VALID_UNIVERSE_ID,
  recordNoun: 'universe',
  // Cross-record `runs[]` moves into `config.runs` so it travels with the
  // type-level index (fresh install → empty).
  buildConfig: (doc) => ({ runs: Array.isArray(doc?.runs) ? doc.runs : [] }),
});
