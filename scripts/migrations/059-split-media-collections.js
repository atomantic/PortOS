/**
 * Split the monolithic `data/media-collections.json` into per-record files under `data/media-collections/{id}/index.json`, with a type-level `data/media-collections/index.json` stamping `schemaVersion: 1`.
 *
 * The legacy `{ collections: [...] }` shape serialized every write across every collection through one file-level queue and rewrote the whole ~200 KB document per item, so high-frequency render-filing
 * (pipeline cover filer, Universe Builder completion hook, image-gen auto-file) blocked unrelated writes. The per-record layout (`server/lib/collectionStore.js`) reads/writes one collection at a time.
 *
 * The legacy file is RENAMED to `media-collections.json.bak-059`, not deleted, so recovery stays open. Idempotent: a re-run after partial completion finishes the split; after full completion it is a no-op.
 * Collections carry no cross-record type-level state (no `runs[]` analog), so the type index `config` is `{}`, and no record-shape `schemaVersion`.
 *
 * Shares the split skeleton with 034 / 035 / 036 via `makeSplitMigration` but opts into three behaviors preserving what the old `listCollections` reader did (so the upgrade can't change which record survives):
 *   - `dedupe`: first-wins on a duplicate id within the legacy array.
 *   - `extraValid`: reject a blank/missing `name` (mirrors sanitizeCollection's read-time drop) so an unsanitizable leading row can't shadow a later valid duplicate. Inline, NOT imported: a migration is a frozen snapshot.
 *   - `onUnreadable: 'throw'`: keep the migration PENDING so a repaired unreadable file re-splits on the next boot instead of freezing collections as "migrated" while trapped in the file.
 */

import { makeSplitMigration } from './_lib.js';

// Match the collectionStore default `idPattern` so an id the store would reject (and silently drop from listIds) stays in the backup for manual recovery. Collection ids are random UUIDs or `uc-<universeId>` / `sc-<seriesId>`; all match.
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
