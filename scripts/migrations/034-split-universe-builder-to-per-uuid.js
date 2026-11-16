/**
 * Split the monolithic `data/universe-builder.json` into per-record files under `data/universes/{id}/index.json`, with a type-level `data/universes/index.json` stamping `schemaVersion: 5`.
 *
 * The legacy `{ universes: [...], runs: [...] }` shape serialized every write across every universe (at 30+ universes, ~50KB each, one edit forced a 1.4MB rewrite under a single-tail queue); the per-record layout
 * reads/writes one at a time. The legacy file is RENAMED to `universe-builder.json.bak-034`, not deleted, so recovery stays open. Idempotent: a re-run after partial completion finishes the split; after full completion it is a no-op.
 *
 * Each record carries `schemaVersion` (record shape, currently 4), distinct from the type-level `schemaVersion` (layout, currently 5, this migration's bump); see the `server/lib/collectionStore.js` header.
 * Shares the split skeleton with 035 / 036 / 059 via `makeSplitMigration`; the only universe-specific bits are the `config.runs` carry-over (cross-record `runs[]` travels with the type-level index) and the id pattern.
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
  // Corrupt source must stay pending (not stamped applied) so a repaired file re-splits.
  onUnreadable: 'throw',
  // Cross-record `runs[]` moves into `config.runs` so it travels with the
  // type-level index (fresh install → empty).
  buildConfig: (doc) => ({ runs: Array.isArray(doc?.runs) ? doc.runs : [] }),
});
