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
 *
 * Shares the split skeleton with 034 / 035 / 036 via `makeSplitMigration`, but
 * opts into three behaviors the others don't need (each preserves what the old
 * monolithic `listCollections` reader did, so the upgrade can't change which
 * record survives):
 *   - `dedupe` — first-wins on a duplicate id within the legacy array.
 *   - `extraValid` — reject a blank/missing `name` (mirrors sanitizeCollection's
 *     read-time drop) so an unsanitizable leading row can't shadow a later valid
 *     duplicate of the same id. Kept inline, NOT imported from the service: a
 *     migration is a frozen snapshot and must not shift if sanitizeCollection
 *     later evolves.
 *   - `onUnreadable: 'throw'` — keep the migration PENDING (not marked applied)
 *     so a repaired unreadable file re-splits on the next boot, instead of
 *     freezing the collections as "migrated" while still trapped in the file.
 */

import { makeSplitMigration } from './_lib.js';

// Match the collectionStore default `idPattern` so a record whose id the store
// would accept gets split, and one it would reject (and silently drop from
// listIds) is left in the backup for manual recovery rather than written to a
// directory the store can never load. Collection ids are random UUIDs or the
// deterministic `uc-<universeId>` / `sc-<seriesId>` forms — all match.
const VALID_COLLECTION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export default makeSplitMigration({
  migrationLabel: 'migration 059',
  typeDirName: 'media-collections',
  legacyFilename: 'media-collections.json',
  backupSuffix: '.bak-059',
  typeSchemaVersion: 1,
  typeLabel: 'mediaCollections',
  recordsKey: 'collections',
  idPattern: VALID_COLLECTION_ID,
  recordNoun: 'collection',
  dedupe: true,
  extraValid: (record) => typeof record.name === 'string' && !!record.name.trim(),
  onUnreadable: 'throw',
});
