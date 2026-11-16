/**
 * Split each monolithic brain entity store `data/brain/<type>.json` into per-record files under `data/brain/<type>/<id>/index.json`, with a type-level
 * `data/brain/<type>/index.json` stamping `schemaVersion: 1` (issue #725).
 *
 * Each store was one `{ records: { <id>: record } }` file that `brainStorage.js` rewrote whole on every write and parsed whole on every read; that does not scale on
 * federated installs of unknown size. The per-record `collectionStore` layout (`server/lib/collectionStore.js`) reads/writes one record at a time, in parallel across records.
 *
 * On disk, per type: `people.json` becomes `people/index.json` (schemaVersion 1) plus `people/<id>/index.json` (the record). The legacy file is RENAMED to
 * `<type>.json.bak-200`, never deleted, so recovery stays open.
 *
 * Federation is UNAFFECTED: brain federates per-record through the `brainStorage` seams (`getRawRecords` / `appendChange` / `applyRemoteRecord`), so the container shape is
 * orthogonal to the wire format and no `schemaVersions.js` bump is needed.
 *
 * TOMBSTONES are preserved: deleted records stay as `{ _deleted: true, updatedAt, originInstanceId, deletedAt }` markers so the last-writer-wins guard in `applyRemoteRecord`
 * can reject a stale `create` echoed from a peer. The split writes every map value verbatim, so no delete is resurrected.
 *
 * Idempotency: gate 1 (type index already at v1) makes a re-run a no-op; the per-record existing-id check finishes a partial run without clobbering fresher post-crash state;
 * a fresh install with no legacy file stamps the type index so the boot verifier doesn't flag it. Records carry no record-shape `schemaVersion`, and brain stores hold no
 * cross-record type-level state, so `config` is `{}`.
 */

import { makeSplitMigration } from './_lib.js';

// FROZEN snapshot of the brain entity types as of migration 200 (live list: `BRAIN_ENTITY_TYPES` in server/services/brainStorage.js). A migration is point-in-time and must NOT
// track later additions; a type added later gets its own split, as in migrations 080/081.
const BRAIN_ENTITY_TYPES = [
  'people', 'projects', 'ideas', 'admin', 'memories', 'links', 'buckets',
  'journals', 'inbox', 'songs',
];

// The type-level storage-layout version this migration stamps. Mirrors
// BRAIN_STORE_SCHEMA_VERSION in brainStorage.js.
const BRAIN_STORE_SCHEMA_VERSION = 1;

// Record ids are UUIDs for every type EXCEPT `journals` (keyed by `YYYY-MM-DD`). Keep in lockstep with the collectionStore default id allowlist so an id the store would reject
// (and silently drop from `listIds`) stays in the backup for manual recovery instead of a directory the store can never load.
const BRAIN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

// One split per brain entity type; `makeSplitMigration` joins `typeDirName` and `legacyFilename` under `data/`.
const perTypeSplits = BRAIN_ENTITY_TYPES.map((type) => makeSplitMigration({
  migrationLabel: `migration 200 (brain/${type})`,
  typeDirName: `brain/${type}`,
  legacyFilename: `brain/${type}.json`,
  backupSuffix: '.bak-200',
  typeSchemaVersion: BRAIN_STORE_SCHEMA_VERSION,
  typeLabel: type,
  recordsKey: 'records',
  recordsShape: 'map',
  idPattern: BRAIN_ID_PATTERN,
  recordNoun: `brain ${type} record`,
  onUnreadable: 'throw', // keep pending so a repaired file re-splits next boot
}).up);

export default {
  up: async (ctx) => {
    const perType = [];
    const failures = [];
    // Sequential so per-type log lines stay ordered. Each type is INDEPENDENT: a corrupt legacy file for one must NOT abort the others (brainStorage reads only the per-record dirs, so an
    // un-split type loads as empty). Run every type, collect outcomes, THEN re-throw an aggregate, which keeps the migration PENDING for retry while healthy types become gate-1 no-ops.
    for (let i = 0; i < perTypeSplits.length; i++) {
      try {
        perType.push(await perTypeSplits[i](ctx));
      } catch (err) {
        failures.push(BRAIN_ENTITY_TYPES[i]);
        console.error(`❌ migration 200 (brain/${BRAIN_ENTITY_TYPES[i]}): ${err.message}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `migration 200: ${failures.length} brain store(s) failed to split (${failures.join(', ')}) — ` +
        `repair the unreadable legacy file(s) and reboot to retry; the healthy stores were split.`,
      );
    }
    return { ok: true, perType };
  },
};
