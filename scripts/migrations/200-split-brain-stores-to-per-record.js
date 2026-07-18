/**
 * Split each monolithic brain entity store `data/brain/<type>.json` into
 * per-record files under `data/brain/<type>/<id>/index.json`, with a type-level
 * `data/brain/<type>/index.json` stamping `schemaVersion: 1`.
 *
 * Why (issue #725):
 *   Every brain entity store was a single `{ records: { <id>: record } }` file
 *   that `brainStorage.js` rewrote whole on every create/update/delete and
 *   parsed whole on every read (behind a 2s TTL cache + one global write mutex).
 *   That's fine at a dozen records but does not scale — and PortOS is
 *   distributed: other installs (and a user's federated peers) accumulate brain
 *   data on their own schedule, and we don't know how large those stores are.
 *   The per-record `collectionStore` layout reads/writes one record at a time
 *   and lets writes to different records proceed in parallel. See
 *   `server/lib/collectionStore.js`.
 *
 * What changes on disk (per type):
 *
 *     before:                         after:
 *     data/brain/                     data/brain/
 *     └── people.json                 ├── people/
 *         { records: {                │   ├── index.json     (schemaVersion: 1)
 *           "<id>": { … } } }         │   ├── <id>/
 *                                     │   │   └── index.json (the record)
 *                                     │   └── …
 *                                     └── people.json.bak-200   (renamed, not deleted)
 *
 * The legacy file is RENAMED to `<type>.json.bak-200`, never deleted — recovery
 * path stays open. A later migration (or manual cleanup) can remove the backups
 * once validated.
 *
 * Federation is UNAFFECTED. Brain federates strictly per-record through the
 * `brainStorage` API seams (`getRawRecords` / `appendChange` / `applyRemoteRecord`),
 * never by shipping a whole-store file — so the on-disk container shape is
 * orthogonal to the wire format and this split needs no `schemaVersions.js` bump
 * or wire-category change (brain is intentionally ungated there).
 *
 * TOMBSTONES are preserved. Brain keeps deleted records in place as
 * `{ _deleted: true, updatedAt, originInstanceId, deletedAt }` markers so the
 * last-writer-wins guard in `applyRemoteRecord` can reject a stale `create`
 * echoed back from a peer. The `map`-shape split writes every map value verbatim
 * (tombstones included), so no delete is silently resurrected by the upgrade.
 *
 * Idempotency: gate 1 (type index already at v1) makes a re-run after full
 * success a no-op; the per-record existing-id check finishes a partial run
 * without clobbering fresher post-crash state; a fresh install with no legacy
 * file stamps the type index so the boot verifier doesn't flag it missing.
 *
 * Records carry no record-shape `schemaVersion` — only the type-level layout
 * version (1, this migration's stamp) applies. Brain stores hold no cross-record
 * type-level state (no `runs[]` analog), so `config` is `{}`.
 */

import { makeSplitMigration } from './_lib.js';

// FROZEN snapshot of the brain entity types as of migration 200. The live list
// is `BRAIN_ENTITY_TYPES` in server/services/brainStorage.js, but a migration is
// a point-in-time record — it must NOT track later additions to that list (a
// type added after this migration gets its own later split), so it keeps its own
// copy exactly as migrations 080/081 do.
const BRAIN_ENTITY_TYPES = [
  'people', 'projects', 'ideas', 'admin', 'memories', 'links', 'buckets',
  'journals', 'inbox', 'songs',
];

// The type-level storage-layout version this migration stamps. Mirrors
// BRAIN_STORE_SCHEMA_VERSION in brainStorage.js.
const BRAIN_STORE_SCHEMA_VERSION = 1;

// Record ids are UUIDs for every type EXCEPT `journals`, which keys entries by
// calendar date (`YYYY-MM-DD`) so the same day converges across peers. Both
// shapes match the collectionStore default id allowlist — keep them in lockstep
// so a record whose id the store would accept gets split, and one it would
// reject (and silently drop from `listIds`) is left in the backup for manual
// recovery rather than written to a directory the store can never load.
const BRAIN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

// One split per brain entity type. `makeSplitMigration` joins its `typeDirName`
// and `legacyFilename` under `data/`, so the nested `brain/<type>` paths target
// `data/brain/<type>/` and `data/brain/<type>.json` respectively.
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
    // Sequential (not Promise.all) so the per-type log lines stay ordered and a
    // failure surfaces against the type that caused it. Each type's split is
    // independent — `onUnreadable: 'throw'` on one leaves the others' work in
    // place and keeps THIS migration pending for a retry.
    for (const up of perTypeSplits) {
      perType.push(await up(ctx));
    }
    return { ok: true, perType };
  },
};
