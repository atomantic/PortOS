# Migrate media collections to a per-record `createCollectionStore`

PLAN.md item: `[media-collections-per-record-store]`

## Context

Today every media collection lives in one monolithic `data/media-collections.json`
(`{ collections: [...] }`). Every mutator — `addItem`, `bulkUpdateCollectionItems`,
`removeItem`, `mergeMediaCollectionsFromSync`, `pruneTombstonedCollections` — does a
`listCollections (read whole file) → modify → atomicWrite (whole file)` round, all
serialized through a **single** file-level write tail (`serializeFileWrite` in
`server/services/mediaCollections.js:164`).

The pain: high-frequency render-filing (pipeline `coverUniverseFiler`, Universe Builder
completion hook, image-gen auto-file) calls `addItem` constantly, and each call
serializes against every *unrelated* collection's write **and** rewrites the entire
~200 KB document per image. The fix is the same per-record split we already shipped for
universes (migration 034), series, and issues: `createCollectionStore`
(`server/lib/collectionStore.js`), where writes to different record ids run in parallel
and each write touches only one record's file.

This is a federation-touching refactor: the sync layer reads the whole collection list
in several places, so the migration must preserve every reader/writer's behavior while
swapping the storage substrate. The public API of `mediaCollections.js` stays identical —
all 20+ callers (routes, pipeline, importer/exporter, peerSync, dataSync, tombstoneGc)
are untouched.

## Design overview

The change is contained to **five** areas. The service's public surface does not change,
so no caller is modified.

### Target on-disk layout
```
data/media-collections/
├── index.json          // { schemaVersion: 1, type: 'mediaCollections', updatedAt, config: {} }
├── <id-1>/index.json   // one collection record
└── <id-2>/index.json
```
Collection ids are `randomUUID()`, `uc-<universeId>`, or `sc-<seriesId>` — all match the
store's default `idPattern` (`/^[A-Za-z0-9_-]{1,128}$/`), so no custom pattern is needed.

### Versioning decisions (deliberate)
- **Type-level storage `schemaVersion: 1`** stamped on `data/media-collections/index.json`
  (this is the new collectionStore layout version — distinct from the wire version).
- **Do NOT bump the wire `mediaCollections: 1`** in `server/lib/schemaVersions.js`. The
  wire payload shape (`{ collections: [...] }` snapshot; per-record push of the same
  record shape) is **unchanged** by an on-disk split. Bumping it would needlessly gate
  sync between an upgraded peer and a not-yet-upgraded one. Storage-layout change ≠
  wire-contract change.
- **No record-level `schemaVersion`** field on collections — there is no field-shape
  migration here, only a storage-layout move. `sanitizeCollection` already tolerates the
  existing record shape.

## Step 1 — Rewrite `server/services/mediaCollections.js` persistence layer

Keep `sanitizeItem` / `sanitizeCollection` / all validation / all exported function
signatures **exactly as-is**. Replace only the persistence plumbing.

**Remove:** `statePath`, `DEFAULT_STATE`, the `serializeFileWrite = createFileWriteQueue()`
tail, and `writeAll` (lines ~33, 46, 160-168). Drop the `createFileWriteQueue`,
`readJSONFile`, `atomicWrite` imports that become unused.

**Add** a lazy store getter mirroring `universeBuilder.js:76-98`:
```js
import { createCollectionStore } from '../lib/collectionStore.js';
const TYPE_SCHEMA_VERSION = 1;
let _store = null;
const store = () => {
  const dir = join(PATHS.data, 'media-collections');
  if (_store && _store.dir === dir) return _store;
  _store = createCollectionStore({
    dir, type: 'mediaCollections', schemaVersion: TYPE_SCHEMA_VERSION,
    sanitizeRecord: sanitizeCollection,
  });
  return _store;
};
export const mediaCollectionStore = () => store();
```
(Lazy capture of `PATHS.data` is required — tests swap it via Proxy mock.)

**Rewrite each function to delegate to the store:**

| Function | New implementation |
|---|---|
| `listCollections({includeDeleted})` | `await store().loadAll()` → existing dedupe-by-id + `deleted` filter loop. (`loadAll` already runs `sanitizeRecord`; tombstones come back with `deleted:true`.) |
| `getCollection(id, {includeDeleted})` | `store().loadOne(id)`; throw `NOT_FOUND` if null or (`deleted && !includeDeleted`) — direct per-record load, no full scan |
| `findCollectionByUniverseId` / `findCollectionBySeriesId` | `store().loadOne(linkedCollectionId({...}))` — deterministic id means a direct load replaces the full-list scan |
| `addItem`, `removeItem`, `bulkUpdateCollectionItems`, `updateCollection`, `deleteCollection` (soft) | `store().queueRecordWrite(id, async () => { const cur = await store().loadOne(id); ...modify...; await store().saveOneNow(id, next); return result; })` — soft-delete is a `saveOneNow` of the tombstoned record (`deleted:true`, cleared items), NOT `deleteOne` |
| `createCollection`, `findOrCreate*` | compute id, then `queueRecordWrite(id, …)` → `saveOneNow`. The find-by-name adoption scan uses `loadAll()` first. |
| `renameCollectionForUniverse/Series`, `unlinkCollectionsForUniverse/Series` | `loadAll()` to find matching records, then `queueRecordWrite(id, …)` per matched id |
| `pruneTombstonedCollections(olderThanMs)` (hard delete) | `loadAll({includeDeleted:true})`, for each tombstone older than cutoff `await store().deleteOne(id)`; return `{ pruned }` |
| `mergeMediaCollectionsFromSync(remote)` | for each remote collection, `queueRecordWrite(id, async () => { const local = await store().loadOne(id); ...union-merge items + LWW scalars (existing logic)...; if changed await saveOneNow })`. Preserve the `collectionsEqual` skip-if-unchanged guard per record. |

**Concurrency note (call out in the PR):** the global single-tail queue is replaced by
per-record queues. Same-target writes still serialize — the hot render-filing paths
(`coverUniverseFiler`, importer, Universe Builder hook) all use deterministic
`uc-`/`sc-` ids, so concurrent `addItem`s to the same collection share one queue.
Writes to *different* collections now run in parallel (the win). The only relaxation is
`createCollection` / `findOrCreateCollectionByName`'s check-then-create on a *random*
UUID, which is user-initiated (single human, single-user trust model) — acceptable per
CLAUDE.md's trust model.

**Barrel/README:** `mediaCollections.js` is a service, not in `server/lib`, so no barrel
row is needed. (Confirm it isn't re-exported anywhere that needs updating.)

## Step 2 — Migration `scripts/migrations/059-split-media-collections.js`

Next free number is **059** (highest applied is `058-claude-default-opus-4-8.js`). Mirror
`034-split-universe-builder-to-per-uuid.js` exactly, with the simpler shape (no
cross-record `runs[]` — collections have no type-level config, so `config: {}`):

- `export default { async up({ rootDir }) {...} }`
- **Gate 1:** if `data/media-collections/index.json` already at `schemaVersion >= 1` → no-op.
- **Gate 2:** no legacy `data/media-collections.json` and no `.bak-059` → fresh install;
  stamp `data/media-collections/index.json` `{ schemaVersion:1, type:'mediaCollections',
  updatedAt, config:{} }` and return.
- **Split:** read legacy `{ collections: [...] }`; for each record with a valid id, write
  `data/media-collections/<id>/index.json` (skip ids already split — partial-recovery
  scan like 034:131-146). Validate id against `/^[A-Za-z0-9_-]{1,128}$/`.
- **Stamp type index AFTER all records land** (so a mid-split crash leaves the index
  missing and the next boot re-runs the loop).
- **Back up** legacy file to `media-collections.json.bak-059` via `rename` (don't delete).
- Return `{ ok:true, reason:'split', written, skipped, invalid }`.

Add `scripts/migrations/059-split-media-collections.test.js` mirroring `034`'s test:
assert fresh-install stamp, full split, idempotent re-run, partial-recovery skip, and
backup creation.

## Step 3 — Boot-time schema verifier (`server/index.js`)

- Import `mediaCollectionStore` alongside the other store imports (near line 154).
- Add `mediaCollectionStore()` to the `verifyCollectionVersions([...])` array at
  `server/index.js:213`. Migrations already run (line ~207) before this check.

## Step 4 — dataSync watch invalidation (`server/services/dataSync.js`)

- Line 45: rename `MEDIA_COLLECTIONS_FILE = join(PATHS.data, 'media-collections.json')`
  → `MEDIA_COLLECTIONS_DIR = join(PATHS.data, 'media-collections')`.
- Line 707: update the `mediaCollections:` watch-path array to reference the dir. The
  fingerprint walker already "descends into the dir so per-record edits invalidate"
  (comment at dataSync.js:43-44), so a directory path is the correct shape and makes
  per-record writes invalidate the snapshot checksum cache.

## Step 5 — Seed + test fixtures

- **`data.reference/`:** if a seed `data.reference/media-collections.json` exists, replace
  it with `data.reference/media-collections/index.json` (`{ schemaVersion:1, type:
  'mediaCollections', config:{} }`) plus any seed record dirs. `scripts/setup-data.js`
  copies missing files recursively, so the new dir layout seeds correctly on fresh
  installs. (Verify whether a seed file currently exists; if none, nothing to do.)
- **Tests that pre-seed the monolithic file:** grep for any test writing
  `media-collections.json` directly and switch it to seed via the service or the
  per-record layout. `mediaCollections.test.js`, `peerSync.test.js`,
  `sharing/integration.test.js`, and `routes/mediaCollections.test.js` should otherwise
  pass unchanged because the public API is preserved.

## Out of scope (leave as separate PLAN items)

- `[conflict-journal-media-collections]` (line 119) — scalar-overwrite journaling stays
  deferred; this PR only changes storage.
- `[data-versioning-typeindex-config-convention]` (line 104) — collections use `config:{}`
  for now; no shared config slot needed.

## Verification

1. **Unit/integration tests** — `cd server && npm test`. Targeted runs:
   `npx vitest run services/mediaCollections.test.js routes/mediaCollections.test.js
   services/sharing/peerSync.test.js services/sharing/integration.test.js
   ../scripts/migrations/059-split-media-collections.test.js`. All must pass — the merge,
   union-by-`kind:ref`, LWW-scalar, tombstone, and per-record-subscription assertions
   are the regression net for the sync rewrite.
2. **Migration on real data** — with a populated `data/media-collections.json`, boot the
   server (or run the migration runner). Confirm: `data/media-collections/<id>/index.json`
   files exist, `data/media-collections/index.json` has `schemaVersion:1`,
   `media-collections.json.bak-059` exists, and `migrations.applied.json` lists `059`.
   Re-run → no-op (Gate 1).
3. **Boot log** — `verifyCollectionVersions` prints a green/OK line for `mediaCollections`.
4. **App smoke** (`npm run dev`) — Collections page lists, create/rename/delete a
   collection, add/remove items, pin a cover. Run the pipeline cover-filer / Universe
   Builder path that auto-files renders and confirm items land in the right `uc-`/`sc-`
   collection.
5. **Federation smoke** (covered by integration.test.js, optionally manual) — two
   instances still converge: item union across peers, deleted-collection GC, bundled
   `linkedCollection` on universe/series push.
6. Run `/simplify` on the diff, then commit + open a PR.
