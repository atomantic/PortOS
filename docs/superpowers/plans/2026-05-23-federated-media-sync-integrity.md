# Federated Media Sync Parity + Per-Category Sync Integrity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make media collections federate as reliably as universes/series, ensure synced images carry their generation prompts, and surface per-category sync integrity (badge + detail drawer + manual sync) on existing pages.

**Architecture:** Promote media collections to a first-class peer-sync record kind (`mediaCollection`) reusing the existing subscribe/push/tombstone pipeline; extend the asset-pull worker to also pull the `.metadata.json` sidecar; add a Tailnet-only peer manifest endpoint + a pure local-vs-peer integrity diff; render the diff as per-record badges + a deep-linkable drawer with manual-sync actions.

**Tech Stack:** Node/Express, Zod validation, Vitest (server + client), React/Vite, Socket.IO. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-23-federated-media-sync-integrity-design.md`

**Conventions (read before starting):**
- No `try/catch` in request-lifecycle code (errors bubble to middleware); the `.catch(() => …)` pattern is used at fire-and-forget boundaries throughout `peerSync.js` — match it.
- Single-line emoji-prefixed logs.
- Every new `server/lib` / `client/src/lib` / hook / `apiX.js` file gets a barrel re-export + README row (enforced by `server/lib/index.test.js`).
- Record-creating Vitest suites mock `mockNoPeers()` AND `mockNoPeerSync()` from `server/lib/mockPathsDataRoot.js`.
- Tests live beside source as `<name>.test.js`. Run server tests with `cd server && npm test`, client with `cd client && npm test`.

**Pre-existing groundwork to reuse (do NOT re-create):**
- `peerSyncPushBase.linkedCollection` already in the push schema (`server/lib/validation.js:1310-1323`).
- `sanitizeRecordForWire` already has a `case 'mediaCollection'` (`server/lib/syncWire.js`) — extend it, don't add a duplicate.
- `mergeMediaCollectionsFromSync` (`server/services/mediaCollections.js:738`) is the receiver merge — reuse it.
- `KIND_TO_CATEGORY` (`peerSync.js:264`) maps kind→sync-category. `peerHasCategory` gates pushes on `syncCategories[cat]`.
- Universe/series create paths auto-subscribe via `import('./sharing/peerSync.js').then(({ autoSubscribeRecordToAllPeers }) => …)` (`universeBuilder.js:940`, `pipeline/series.js:213`) — mirror this fire-and-forget dynamic-import pattern.

---

## File Structure

**Group 1 — Collections as first-class sync records (server)**
- Modify: `server/services/mediaCollections.js` — soft-delete shape, `listCollections({includeDeleted})`, soft-delete `deleteCollection`, merge respects `deleted`, `createCollection` auto-subscribe + own-kind event, new `collectCollectionAssetReferences`.
- Modify: `server/lib/syncWire.js` — `mediaCollection` wire case applies soft-delete tail.
- Modify: `server/services/sharing/peerSync.js` — add `'mediaCollection'` to `PEER_SUBSCRIBABLE_KINDS`, `KIND_TO_CATEGORY`, `buildPushPayload` branch, `applyIncomingPush` branch.
- Modify: `server/lib/validation.js` — add `mediaCollectionPushSchema` to the discriminated union.
- Modify: `server/lib/schemaVersions.js` — `mediaCollections: 1`.
- Modify: `server/services/syncOrchestrator.js` — map `mediaCollection` sub → skip `mediaCollections` snapshot category.
- Modify: `server/services/sharing/tombstoneGc.js` — `mediaCollections` sweep.
- Modify: `server/services/mediaCollections.js` (`pruneTombstonedCollections` export).
- Tests: `mediaCollections.test.js`, `peerSync.test.js`, `syncWire.test.js`, `tombstoneGc.test.js`.

**Group 2 — Sidecar metadata sync (server)**
- Modify: `server/services/sharing/peerSync.js` — `buildAssetManifest` adds `sidecarSha256`; `diffAssetManifestAgainstLocal` re-pulls on sidecar mismatch; `doPullOneAsset` pulls the sidecar.
- Create: `server/services/sharing/sidecarSync.js` — `pullSidecarForImage(peer, base, filename)`, `backfillMissingSidecars(filenames)` (pure-ish helpers, file-IO).
- Modify: `server/services/sharing/index.js` barrel + README.
- Tests: `peerSync.test.js`, `sidecarSync.test.js`.

**Group 3 — Integrity API + peer manifest (server)**
- Create: `server/lib/syncIntegrity.js` — pure `computeRecordIntegrity(localList, remoteList, assetState)` + status constants.
- Create: `server/services/sharing/integrity.js` — orchestration: build local manifest, fetch peer manifest, run the pure diff.
- Modify: `server/routes/peerSync.js` — `GET /manifest`, `GET /integrity`.
- Modify: `server/lib/validation.js` — query schemas if needed.
- Modify: `server/lib/index.js` barrel + README.
- Tests: `syncIntegrity.test.js`, `peerSync.routes` (new `integrity` route test).

**Group 4 — Manual sync + client UI**
- Modify: `server/services/sharing/peerSync.js` — `forcePushRecord(peerId, recordKind, recordId)` (bypass unchanged-hash), `syncNowForPeer(peerId)`.
- Modify: `server/routes/peerSync.js` — `POST /sync-record`, `POST /sync-now`, `POST /pull-metadata`.
- Modify: `server/lib/validation.js` — schemas for the three POSTs.
- Create: `client/src/services/apiPeerSync.js` (or extend existing) — wrappers.
- Create: `client/src/components/sync/SyncBadge.jsx`, `client/src/components/sync/SyncDetailDrawer.jsx`.
- Create: `client/src/hooks/useSyncIntegrity.js`.
- Modify: `client/src/pages/MediaCollections.jsx`, `Universes`/`Pipeline` list pages, `App.jsx` routes for the `/.../:id/sync` drawer.
- Tests: client Vitest for `SyncBadge`, `useSyncIntegrity`, `computeRecordIntegrity` already covered server-side (mirror the pure fn if duplicated client-side).

---

# GROUP 1 — Collections as first-class sync records

### Task 1.1: Soft-delete fields on the collection shape

**Files:**
- Modify: `server/services/mediaCollections.js:86-128` (`sanitizeCollection`)
- Test: `server/services/mediaCollections.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
// sanitizeCollection is module-private; test via the public round-trip:
// createCollection → deleteCollection → listCollections({includeDeleted}).
// For the pure-shape assertion, export sanitizeCollection for tests OR assert
// through mergeMediaCollectionsFromSync (preferred — it calls sanitizeCollection).
import { mergeMediaCollectionsFromSync, listCollections } from './mediaCollections.js';
import { mockNoPeers } from '../lib/mockPathsDataRoot.js';

describe('collection soft-delete shape', () => {
  it('preserves deleted + deletedAt through sync merge', async () => {
    mockNoPeers();
    await mergeMediaCollectionsFromSync([{
      id: 'c1', name: 'C1', items: [],
      deleted: true, deletedAt: '2026-05-23T00:00:00.000Z',
      updatedAt: '2026-05-23T00:00:00.000Z',
    }]);
    const live = await listCollections();
    expect(live.find((c) => c.id === 'c1')).toBeUndefined();
    const all = await listCollections({ includeDeleted: true });
    const c = all.find((x) => x.id === 'c1');
    expect(c?.deleted).toBe(true);
    expect(c?.deletedAt).toBe('2026-05-23T00:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npm test -- mediaCollections.test.js -t "soft-delete shape"`
Expected: FAIL — `deleted` is stripped by `sanitizeCollection` and `listCollections` has no `includeDeleted`.

- [ ] **Step 3: Implement — preserve soft-delete in `sanitizeCollection`**

In `sanitizeCollection` (before the `return { … }` at line 128), compute:

```js
const deleted = raw.deleted === true;
const deletedAt = deleted && typeof raw.deletedAt === 'string' ? raw.deletedAt : (deleted ? createdAt : null);
```

and add `deleted, deletedAt` to the returned object (tail position, after `updatedAt`):

```js
return { id: raw.id, name, description, coverKey, universeId, seriesId, items, createdAt, updatedAt, deleted, deletedAt };
```

- [ ] **Step 4: (Task 1.2 makes this test pass — `includeDeleted` filter needed.) Run after 1.2.**

---

### Task 1.2: `listCollections({ includeDeleted })` filter

**Files:**
- Modify: `server/services/mediaCollections.js:131-144` (`listCollections`)

- [ ] **Step 1: Implement the filter**

```js
export async function listCollections({ includeDeleted = false } = {}) {
  await ensureDir(PATHS.data);
  const raw = await readJSONFile(statePath(), DEFAULT_STATE, { logError: false });
  if (!Array.isArray(raw.collections)) return [];
  const seen = new Set();
  const out = [];
  for (const c of raw.collections) {
    const s = sanitizeCollection(c);
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    if (!includeDeleted && s.deleted === true) continue;
    out.push(s);
  }
  return out;
}
```

**IMPORTANT:** `mergeMediaCollectionsFromSync` and `deleteCollection` internally call `listCollections()` to load *all* records for read-modify-write. Audit every internal caller (`grep -n "listCollections(" server/services/mediaCollections.js`) and pass `{ includeDeleted: true }` to the **mutation** read paths (merge, delete, addItem, updateCollection, bulkUpdate) so a tombstone isn't silently dropped from the rewrite (which would resurrect it). Read-only/display callers keep the default (live-only).

- [ ] **Step 2: Run the Task 1.1 test**

Run: `cd server && npm test -- mediaCollections.test.js -t "soft-delete shape"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add server/services/mediaCollections.js server/services/mediaCollections.test.js
git commit -m "feat(sync): soft-delete shape + includeDeleted on media collections"
```

---

### Task 1.3: `deleteCollection` soft-deletes + emits `mediaCollection` events

**Files:**
- Modify: `server/services/mediaCollections.js:534-550` (`deleteCollection`)
- Test: `server/services/mediaCollections.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { createCollection, deleteCollection, listCollections } from './mediaCollections.js';
import { recordEvents } from './sharing/recordEvents.js';

it('deleteCollection soft-deletes and emits mediaCollection deleted event', async () => {
  mockNoPeers();
  const c = await createCollection({ name: 'ToDelete' });
  const events = [];
  const handler = (e) => events.push(e);
  recordEvents.on('deleted', handler);
  await deleteCollection(c.id);
  recordEvents.off('deleted', handler);
  expect((await listCollections()).find((x) => x.id === c.id)).toBeUndefined();
  const all = await listCollections({ includeDeleted: true });
  expect(all.find((x) => x.id === c.id)?.deleted).toBe(true);
  expect(events).toContainEqual({ recordKind: 'mediaCollection', recordId: c.id });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npm test -- mediaCollections.test.js -t "soft-deletes and emits"`
Expected: FAIL — record is spliced out (hard delete), no `mediaCollection` event.

- [ ] **Step 3: Implement soft-delete**

Replace the body of `deleteCollection`:

```js
import { emitRecordUpdated, emitRecordDeleted } from './sharing/recordEvents.js'; // emitRecordDeleted is new to the import

export async function deleteCollection(id) {
  const { universeId: deletedUniverseId, seriesId: deletedSeriesId } = await serializeFileWrite(async () => {
    const all = await listCollections({ includeDeleted: true });
    const idx = all.findIndex((c) => c.id === id);
    if (idx < 0) throw makeErr(`Collection not found: ${id}`, ERR_NOT_FOUND);
    const target = all[idx];
    const now = new Date().toISOString();
    // Soft-delete: keep the row, drop its items + parent links so a tombstone
    // push ships no asset cargo and the bucket can't keep re-publishing.
    const next = [...all];
    next[idx] = { ...target, deleted: true, deletedAt: now, updatedAt: now, items: [], universeId: null, seriesId: null };
    await writeAll(next);
    return { universeId: target.universeId || null, seriesId: target.seriesId || null };
  });
  // Parent universe/series re-export (membership changed) + own-kind delete
  // so the peer-sync delete listener pushes the tombstone.
  if (deletedUniverseId) emitRecordUpdated('universe', deletedUniverseId);
  if (deletedSeriesId) emitRecordUpdated('series', deletedSeriesId);
  emitRecordDeleted('mediaCollection', id);
  return { id };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npm test -- mediaCollections.test.js -t "soft-deletes and emits"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/services/mediaCollections.js server/services/mediaCollections.test.js
git commit -m "feat(sync): media collection deleteCollection soft-deletes + emits tombstone event"
```

---

### Task 1.4: Merge respects `deleted` (LWW tombstone)

**Files:**
- Modify: `server/services/mediaCollections.js:738-792` (`mergeMediaCollectionsFromSync`) + `collectionsEqual`
- Test: `server/services/mediaCollections.test.js`

- [ ] **Step 1: Write the failing test**

```js
it('a newer remote tombstone deletes a local live collection', async () => {
  mockNoPeers();
  const c = await createCollection({ name: 'Live' }); // updatedAt = t0
  await new Promise((r) => setTimeout(r, 5));
  await mergeMediaCollectionsFromSync([{
    id: c.id, name: 'Live', items: [], deleted: true,
    deletedAt: '2999-01-01T00:00:00.000Z', updatedAt: '2999-01-01T00:00:00.000Z',
  }]);
  expect((await listCollections()).find((x) => x.id === c.id)).toBeUndefined();
  const all = await listCollections({ includeDeleted: true });
  expect(all.find((x) => x.id === c.id)?.deleted).toBe(true);
});

it('an older remote tombstone does NOT delete a newer local collection', async () => {
  mockNoPeers();
  const c = await createCollection({ name: 'Fresh' }); // updatedAt = now (newer)
  await mergeMediaCollectionsFromSync([{
    id: c.id, name: 'Fresh', items: [], deleted: true,
    deletedAt: '2000-01-01T00:00:00.000Z', updatedAt: '2000-01-01T00:00:00.000Z',
  }]);
  expect((await listCollections()).find((x) => x.id === c.id)).toBeDefined();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npm test -- mediaCollections.test.js -t "tombstone"`
Expected: FAIL — `next` object never carries `deleted`/`deletedAt`, so the tombstone is dropped.

- [ ] **Step 3: Implement — carry soft-delete through the scalar-LWW branch**

In `mergeMediaCollectionsFromSync`, the `next` object (line 774-783) takes scalars from `scalarSource` (the newer side). Add the soft-delete pair from the scalar source and, when the winning side is deleted, blank items:

```js
const scalarDeleted = scalarSource.deleted === true;
const next = {
  ...local,
  name: scalarSource.name,
  description: scalarSource.description,
  coverKey: scalarDeleted ? null : coverKey,
  universeId: scalarDeleted ? null : scalarSource.universeId,
  seriesId: scalarDeleted ? null : scalarSource.seriesId,
  items: scalarDeleted ? [] : mergedItems,
  updatedAt: remoteWins ? remoteTs : localTs,
  deleted: scalarDeleted,
  deletedAt: scalarDeleted ? (scalarSource.deletedAt || (remoteWins ? remoteTs : localTs)) : null,
};
```

Also handle the **local-missing** branch (line 748-751): a remote tombstone for a collection we've never seen must still be recorded (so it can't resurrect). `sanitizeCollection` already preserves `deleted`, so `localById.set(sanitized.id, sanitized)` is correct as-is — confirm the test for "remote tombstone, no local" passes (add one if missing).

`collectionsEqual` uses `JSON.stringify` — since both sides go through `sanitizeCollection` (canonical key order incl. the new tail fields), no change needed.

- [ ] **Step 4: Run to verify passes**

Run: `cd server && npm test -- mediaCollections.test.js -t "tombstone"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/services/mediaCollections.js server/services/mediaCollections.test.js
git commit -m "feat(sync): LWW merge honors media collection tombstones"
```

---

### Task 1.5: `createCollection` auto-subscribes + emits own-kind event

**Files:**
- Modify: `server/services/mediaCollections.js:163-189` (`createCollection`)
- Test: `server/services/mediaCollections.test.js`

- [ ] **Step 1: Write the failing test**

```js
it('createCollection emits a mediaCollection updated event', async () => {
  mockNoPeers();
  const events = [];
  const handler = (e) => events.push(e);
  recordEvents.on('updated', handler);
  const c = await createCollection({ name: 'New' });
  recordEvents.off('updated', handler);
  expect(events).toContainEqual({ recordKind: 'mediaCollection', recordId: c.id });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npm test -- mediaCollections.test.js -t "createCollection emits"`
Expected: FAIL — `createCollection` emits nothing today.

- [ ] **Step 3: Implement — emit + auto-subscribe (mirror universe/series)**

After the `serializeFileWrite` returns `next` in `createCollection`, before returning, add:

```js
  const created = await serializeFileWrite(async () => { /* …existing… */ });
  emitRecordUpdated('mediaCollection', created.id);
  // Auto-subscribe to peers with mediaCollections enabled. Dynamic import +
  // fire-and-forget mirrors universeBuilder.js:940 / pipeline/series.js:213
  // so the heavy peerSync graph stays off mediaCollections' module-load path.
  import('./sharing/peerSync.js')
    .then(({ autoSubscribeRecordToAllPeers }) => autoSubscribeRecordToAllPeers('mediaCollection', created.id))
    .catch(() => {});
  return created;
```

(Refactor the existing inline `return next` so the function returns `created` after the side effects.)

- [ ] **Step 4: Run to verify passes**

Run: `cd server && npm test -- mediaCollections.test.js -t "createCollection emits"`
Expected: PASS. Confirm the existing `mockNoPeers()` suites still pass (the mock stubs `autoSubscribeRecordToAllPeers`).

- [ ] **Step 5: Commit**

```bash
git add server/services/mediaCollections.js server/services/mediaCollections.test.js
git commit -m "feat(sync): createCollection emits mediaCollection event + auto-subscribes peers"
```

---

### Task 1.6: Register `mediaCollection` as a subscribable kind + category map

**Files:**
- Modify: `server/services/sharing/peerSync.js:73` (`PEER_SUBSCRIBABLE_KINDS`), `:264-267` (`KIND_TO_CATEGORY`)
- Modify: `server/lib/schemaVersions.js:38`
- Test: `server/services/sharing/peerSync.test.js`

- [ ] **Step 1: Edit constants**

```js
// peerSync.js:73
export const PEER_SUBSCRIBABLE_KINDS = Object.freeze(['universe', 'series', 'mediaCollection']);

// peerSync.js:264
const KIND_TO_CATEGORY = Object.freeze({
  universe: 'universe',
  series: 'pipeline',
  mediaCollection: 'mediaCollections',
});
```

```js
// schemaVersions.js — replace the "future:" comment line
  pipelineSeries: 1,
  mediaCollections: 1,
});
```

- [ ] **Step 2: Write/extend a guard test**

```js
it('mediaCollection is a subscribable kind mapped to the mediaCollections category', () => {
  expect(PEER_SUBSCRIBABLE_KINDS).toContain('mediaCollection');
});
```

Run: `cd server && npm test -- peerSync.test.js -t "subscribable kind"` → PASS.

- [ ] **Step 3: Commit**

```bash
git add server/services/sharing/peerSync.js server/lib/schemaVersions.js server/services/sharing/peerSync.test.js
git commit -m "feat(sync): register mediaCollection as a peer-subscribable kind (schemaVersion 1)"
```

---

### Task 1.7: Collection asset-reference collector + push payload branch

**Files:**
- Modify: `server/services/sharing/peerSync.js` — add `collectCollectionAssetReferences`, `buildCollectionAssetManifest`, and a `buildPushPayload` branch (`:850-941`)
- Test: `server/services/sharing/peerSync.test.js`

- [ ] **Step 1: Write the failing test (asset references)**

```js
it('collectCollectionAssetReferences maps items to image/video refs', () => {
  const refs = collectCollectionAssetReferences({
    items: [
      { kind: 'image', ref: 'a.png' },
      { kind: 'video', ref: 'vid123' },
      { kind: 'image', ref: 'b.png' },
    ],
  });
  expect(refs.directImageFilenames).toEqual(['a.png', 'b.png']);
  expect(refs.directVideoFilenames).toEqual(['vid123']);
});
```

- [ ] **Step 2: Run to verify fails**

Run: `cd server && npm test -- peerSync.test.js -t "collectCollectionAssetReferences"`
Expected: FAIL — function not exported.

- [ ] **Step 3: Implement**

```js
// Collections store items as { kind: 'image'|'video', ref, addedAt }. Map to
// the same shape buildAssetManifest's hashers consume. Videos in collections
// reference a job/file id (no image-ref kind in collections).
export function collectCollectionAssetReferences(collection) {
  const items = Array.isArray(collection?.items) ? collection.items : [];
  const directImageFilenames = [];
  const directVideoFilenames = [];
  for (const it of items) {
    if (it?.kind === 'image' && typeof it.ref === 'string') directImageFilenames.push(it.ref);
    else if (it?.kind === 'video' && typeof it.ref === 'string') directVideoFilenames.push(it.ref);
  }
  return { directImageFilenames, directImageRefFilenames: [], directVideoFilenames };
}

async function buildCollectionAssetManifest(collection) {
  const refs = collectCollectionAssetReferences(collection);
  const out = [];
  for (const filename of refs.directImageFilenames) {
    const entry = await hashImageForManifest(filename);
    if (entry) out.push(entry);
  }
  for (const filename of refs.directVideoFilenames) {
    const entry = await hashSimpleAsset(filename, 'video', PATHS.videos);
    if (entry) out.push(entry);
  }
  return out;
}
```

Add the `buildPushPayload` branch (after the `series` branch, before `return null`):

```js
  if (sub.recordKind === 'mediaCollection') {
    const record = await getCollection(sub.recordId, { includeDeleted: true }).catch(() => null);
    if (!record) return null;
    const sanitized = sanitizeRecordForWire('mediaCollection', record);
    if (!sanitized) return null;
    const assetManifest = record.deleted === true ? [] : await buildCollectionAssetManifest(record);
    return { kind: 'mediaCollection', record: sanitized, assetManifest, sourceInstanceId, portosMeta };
  }
```

**Note:** `getCollection` (`mediaCollections.js:146`) currently throws on not-found and has no `includeDeleted`. Add an `{ includeDeleted }` option that reads `listCollections({ includeDeleted })` and returns `null`-friendly via the caller's `.catch`. Import `getCollection` into `peerSync.js`.

- [ ] **Step 4: Run to verify passes**

Run: `cd server && npm test -- peerSync.test.js -t "collectCollectionAssetReferences"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/services/sharing/peerSync.js server/services/mediaCollections.js server/services/sharing/peerSync.test.js
git commit -m "feat(sync): build push payload + asset manifest for mediaCollection records"
```

---

### Task 1.8: Receiver applies `mediaCollection` pushes

**Files:**
- Modify: `server/services/sharing/peerSync.js:1126-1159` (`applyIncomingPush`)
- Modify: `server/lib/syncWire.js` (`mediaCollection` case → soft-delete tail)
- Modify: `server/lib/validation.js:1324-1336` (push schema union)
- Test: `server/services/sharing/peerSync.test.js`

- [ ] **Step 1: Write the failing test**

```js
it('applies an incoming mediaCollection push into local collections', async () => {
  mockNoPeers();
  await applyIncomingPush({
    kind: 'mediaCollection',
    record: { id: 'col-x', name: 'Synced', items: [], updatedAt: '2026-05-23T00:00:00.000Z' },
    assetManifest: [],
    sourceInstanceId: 'peer-abc',
  });
  const all = await listCollections();
  expect(all.find((c) => c.id === 'col-x')?.name).toBe('Synced');
});
```

- [ ] **Step 2: Run to verify fails**

Run: `cd server && npm test -- peerSync.test.js -t "incoming mediaCollection"`
Expected: FAIL — push schema rejects `kind: 'mediaCollection'` (not in the union) and `applyIncomingPush` has no branch.

- [ ] **Step 3a: Add the push schema variant** (`validation.js`, after `seriesPushSchema`):

```js
const mediaCollectionPushSchema = z.object({
  kind: z.literal('mediaCollection'),
  ...peerSyncPushBase,
}).strict();
export const peerSyncPushSchema = z.discriminatedUnion('kind', [
  universePushSchema,
  seriesPushSchema,
  mediaCollectionPushSchema,
]);
```

- [ ] **Step 3b: Add the apply branch** in `applyIncomingPush`, after the `series` block (~line 1159):

```js
  } else if (kind === 'mediaCollection') {
    await mergeMediaCollectionsFromSync([record]);
  }
```

`mergeMediaCollectionsFromSync` is already imported. The existing asset-diff/pull tail (`diffAssetManifestAgainstLocal` + `pullMissingAssetsFromPeer`) and `maybeCreateReverseSubscription` run unchanged for the new kind. The `localEphemeral` block (universe/series only) leaves `localEphemeral=false` for collections — correct, collections have no ephemeral flag.

- [ ] **Step 3c: Tail the soft-delete in the wire sanitizer** (`syncWire.js`, the `case 'mediaCollection'`):

```js
    case 'mediaCollection': {
      // Strip + re-add soft-delete at tail for byte-stable checksums, mirroring
      // the universe/series case. Collections have no `ephemeral` flag.
      const { deleted: _d, deletedAt: _da, ...rest } = record;
      return { ...rest, ...sanitizeSoftDeleteFields(record) };
    }
```

- [ ] **Step 4: Run to verify passes**

Run: `cd server && npm test -- peerSync.test.js -t "incoming mediaCollection"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/services/sharing/peerSync.js server/lib/syncWire.js server/lib/validation.js server/services/sharing/peerSync.test.js
git commit -m "feat(sync): receiver applies mediaCollection pushes + push schema variant"
```

---

### Task 1.9: Orchestrator skips snapshot for peer-subbed collections

**Files:**
- Modify: `server/services/syncOrchestrator.js:356-372` (`categoriesCoveredByPeerSync`)
- Test: `server/services/syncOrchestrator.test.js`

- [ ] **Step 1: Implement the mapping**

In `categoriesCoveredByPeerSync`, add to the loop:

```js
    if (sub.recordKind === 'mediaCollection') skip.add('mediaCollections');
```

- [ ] **Step 2: Test**

```js
it('a mediaCollection subscription skips the mediaCollections snapshot category', async () => {
  // mock listPeerSubscriptions to return one mediaCollection sub for the peer
  // (follow the existing mocking pattern in this suite), then assert the
  // returned skip set contains 'mediaCollections'.
});
```

Run: `cd server && npm test -- syncOrchestrator.test.js -t "mediaCollection subscription skips"`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add server/services/syncOrchestrator.js server/services/syncOrchestrator.test.js
git commit -m "feat(sync): orchestrator skips snapshot for peer-subbed collections"
```

---

### Task 1.10: Tombstone GC for collections

**Files:**
- Modify: `server/services/mediaCollections.js` — add `pruneTombstonedCollections({ olderThanMs })`
- Modify: `server/services/sharing/tombstoneGc.js` — sweep collections
- Test: `server/services/mediaCollections.test.js`, `server/services/sharing/tombstoneGc.test.js`

- [ ] **Step 1: Write the failing test for the prune helper**

```js
it('pruneTombstonedCollections removes tombstones older than the cutoff', async () => {
  mockNoPeers();
  await mergeMediaCollectionsFromSync([{
    id: 'old', name: 'Old', items: [], deleted: true,
    deletedAt: '2000-01-01T00:00:00.000Z', updatedAt: '2000-01-01T00:00:00.000Z',
  }]);
  const pruned = await pruneTombstonedCollections({ olderThanMs: Date.now() });
  expect(pruned).toBe(1);
  expect((await listCollections({ includeDeleted: true })).find((c) => c.id === 'old')).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify fails**

Run: `cd server && npm test -- mediaCollections.test.js -t "pruneTombstonedCollections"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement the prune helper** (`mediaCollections.js`):

```js
// Hard-remove tombstoned collections whose deletedAt is older than the cutoff.
// Called by tombstoneGc once every subscribed peer has acked the deletion.
export async function pruneTombstonedCollections({ olderThanMs = 0 } = {}) {
  return serializeFileWrite(async () => {
    const all = await listCollections({ includeDeleted: true });
    const keep = all.filter((c) => {
      if (c.deleted !== true) return true;
      const ms = Date.parse(c.deletedAt || '');
      return !(Number.isFinite(ms) && ms <= olderThanMs);
    });
    if (keep.length === all.length) return 0;
    await writeAll(keep);
    return all.length - keep.length;
  });
}
```

- [ ] **Step 4: Wire into `tombstoneGc.js`** — mirror the universe/series sweep. Add `import { pruneTombstonedCollections } from '../mediaCollections.js';`, add `mediaCollection` to `snapshotCategoryForKind` (returns `'mediaCollections'`), and add a sweep call alongside the others, gated by the same `getMinAckAcrossPeers` + grace logic. Return a `collections` count in the sweep result; surface it in the `syncOrchestrator.runTombstoneSweep` log line.

- [ ] **Step 5: Run both test files**

Run: `cd server && npm test -- mediaCollections.test.js tombstoneGc.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/services/mediaCollections.js server/services/sharing/tombstoneGc.js server/services/syncOrchestrator.js server/services/sharing/*.test.js server/services/mediaCollections.test.js
git commit -m "feat(sync): tombstone GC prunes acked media collection deletions"
```

---

### Task 1.11: Full Group-1 regression

- [ ] Run: `cd server && npm test -- mediaCollections peerSync syncOrchestrator tombstoneGc syncWire`
- [ ] Run the barrel/README guard: `cd server && npm test -- index.test.js` (no new public lib files in Group 1, but `getCollection` signature changed — confirm no other caller breaks: `grep -rn "getCollection(" server/ | grep -v node_modules`).
- [ ] Expected: all PASS.

---

# GROUP 2 — Sidecar metadata sync

### Task 2.1: Manifest carries `sidecarSha256` for images

**Files:**
- Modify: `server/services/sharing/peerSync.js:481-493` (`hashImageForManifest`)
- Modify: `server/lib/validation.js` (`peerAssetManifestEntrySchema` — allow optional `sidecarSha256`)
- Test: `server/services/sharing/peerSync.test.js`

- [ ] **Step 1: Write the failing test**

```js
it('image manifest entry includes sidecarSha256 when a sidecar exists', async () => {
  // Arrange: write a fake image + its .metadata.json sidecar under PATHS.images
  // (use the test data-root from mockPathsDataRoot). Then:
  const entry = await hashImageForManifest('test.png');
  expect(entry.sidecarSha256).toBeTypeOf('string');
});
```

- [ ] **Step 2: Run to verify fails** → FAIL (`sidecarSha256` undefined).

- [ ] **Step 3: Implement** — in `hashImageForManifest`, after computing the image hash:

```js
import { imageSidecarName } from './buckets.js'; // add to imports
// …inside hashImageForManifest, before return:
const sidecarPath = join(PATHS.images, imageSidecarName(safeName));
const sidecarSha256 = existsSync(sidecarPath) ? await sha256File(sidecarPath).catch(() => null) : null;
return { filename: safeName, kind: 'image', sha256: result.hash, ...(sidecarSha256 ? { sidecarSha256 } : {}) };
```

Add `sidecarSha256: z.string().min(1).max(128).optional()` to `peerAssetManifestEntrySchema` in `validation.js`.

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(sync): image manifest carries sidecar hash`

---

### Task 2.2: Pull the sidecar when pulling an image

**Files:**
- Create: `server/services/sharing/sidecarSync.js`
- Modify: `server/services/sharing/peerSync.js:1427-1495` (`doPullOneAsset`) — call the sidecar pull after a successful image write
- Modify: `server/services/sharing/index.js` barrel + `README.md`
- Test: `server/services/sharing/sidecarSync.test.js`

- [ ] **Step 1: Write the failing test** for `pullSidecarForImage` — mock `peerFetch` to return a JSON body, assert the file lands at `PATHS.images/<basename>.metadata.json`, and that a 404 is swallowed (no throw, no file).

- [ ] **Step 2: Run** → FAIL (module missing).

- [ ] **Step 3: Implement `sidecarSync.js`**

```js
import { join } from 'path';
import { atomicWrite, ensureDir, PATHS } from '../../lib/fileUtils.js';
import { imageSidecarName } from './buckets.js';
import { peerFetch } from '../../lib/httpClient.js'; // match doPullOneAsset's import
import { peerBaseUrl } from '../../lib/peerUrl.js';

const SIDECAR_MAX_BYTES = 256 * 1024; // gen-params JSON is tiny; cap defensively

// Pull `<image-basename>.metadata.json` from a peer's /data/images mount and
// write it alongside the image. Best-effort: a 404 (no sidecar on the sender)
// is normal and silently ignored. Filename is sanitized by the caller.
export async function pullSidecarForImage(peer, base, imageFilename) {
  const sidecarName = imageSidecarName(imageFilename);
  const url = `${base}/data/images/${encodeURIComponent(sidecarName)}`;
  const res = await peerFetch(url, { maxBytes: SIDECAR_MAX_BYTES }).catch(() => null);
  if (!res || !res.ok) return false;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0 || buf.length > SIDECAR_MAX_BYTES) return false;
  await ensureDir(PATHS.images);
  await atomicWrite(join(PATHS.images, sidecarName), buf);
  console.log(`📥 peerSync: pulled sidecar ${sidecarName} from ${peer.name || peer.instanceId}`);
  return true;
}
```

In `doPullOneAsset`, after the successful image `atomicWrite` + `asset-arrived` emit, for `entry.kind === 'image'`:

```js
  if (entry.kind === 'image') {
    await pullSidecarForImage(peer, base, safeName).catch(() => {});
  }
```

Add `pullSidecarForImage` (and Task 2.3's `backfillMissingSidecars`) to `server/services/sharing/index.js` barrel + a README row.

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(sync): pull image sidecar metadata alongside image bytes`

---

### Task 2.3: Manual backfill for bare Unsorted images

**Files:**
- Modify: `server/services/sharing/sidecarSync.js` — `backfillMissingSidecars({ filenames })`
- Test: `server/services/sharing/sidecarSync.test.js`

- [ ] **Step 1: Write the failing test** — given two local images (one with a sidecar, one without), `backfillMissingSidecars` only attempts the bare one against online peers (mock `getPeers` to return one online peer + mock `peerFetch`).

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

```js
import { existsSync } from 'fs';
import { getPeers } from '../instances.js';
import { peerBaseUrl } from '../../lib/peerUrl.js';

// For each local image filename lacking a sidecar, try each online peer until
// one yields the sidecar. Returns { attempted, recovered }.
export async function backfillMissingSidecars({ filenames }) {
  const peers = (await getPeers().catch(() => [])).filter((p) => p?.status === 'online' && p.instanceId);
  let attempted = 0, recovered = 0;
  for (const filename of Array.isArray(filenames) ? filenames : []) {
    const sidecarPath = join(PATHS.images, imageSidecarName(filename));
    if (existsSync(sidecarPath)) continue;
    attempted++;
    for (const peer of peers) {
      const ok = await pullSidecarForImage(peer, peerBaseUrl(peer), filename).catch(() => false);
      if (ok) { recovered++; break; }
    }
  }
  console.log(`🔄 sidecar backfill: ${recovered}/${attempted} recovered from ${peers.length} peer(s)`);
  return { attempted, recovered };
}
```

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(sync): backfill missing image sidecars from online peers`

---

# GROUP 3 — Integrity API + peer manifest

### Task 3.1: Pure integrity diff

**Files:**
- Create: `server/lib/syncIntegrity.js`
- Modify: `server/lib/index.js` barrel + `README.md`
- Test: `server/lib/syncIntegrity.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import { computeRecordIntegrity, INTEGRITY_STATUS } from './syncIntegrity.js';

describe('computeRecordIntegrity', () => {
  const local = [{ id: 'a', updatedAt: '2026-01-02', assetHashes: ['h1'] }];
  it('flags peer-only records', () => {
    const r = computeRecordIntegrity([], [{ id: 'a', updatedAt: '2026-01-02', assetHashes: ['h1'] }]);
    expect(r.find((x) => x.id === 'a').status).toBe(INTEGRITY_STATUS.PEER_ONLY);
  });
  it('flags local-only records (peer has no row, not a tombstone)', () => {
    const r = computeRecordIntegrity(local, []);
    expect(r.find((x) => x.id === 'a').status).toBe(INTEGRITY_STATUS.LOCAL_ONLY);
  });
  it('flags diverged on updatedAt mismatch', () => {
    const r = computeRecordIntegrity(local, [{ id: 'a', updatedAt: '2026-01-09', assetHashes: ['h1'] }]);
    expect(r.find((x) => x.id === 'a').status).toBe(INTEGRITY_STATUS.DIVERGED);
  });
  it('flags assets-missing when hashes differ but record matches', () => {
    const r = computeRecordIntegrity(local, [{ id: 'a', updatedAt: '2026-01-02', assetHashes: ['h1', 'h2'] }]);
    expect(r.find((x) => x.id === 'a').status).toBe(INTEGRITY_STATUS.ASSETS_MISSING);
  });
  it('flags in-parity on full match', () => {
    const r = computeRecordIntegrity(local, [{ id: 'a', updatedAt: '2026-01-02', assetHashes: ['h1'] }]);
    expect(r.find((x) => x.id === 'a').status).toBe(INTEGRITY_STATUS.IN_PARITY);
  });
});
```

- [ ] **Step 2: Run** → FAIL (module missing).

- [ ] **Step 3: Implement `syncIntegrity.js`**

```js
export const INTEGRITY_STATUS = Object.freeze({
  IN_PARITY: 'in-parity',
  LOCAL_ONLY: 'local-only',
  PEER_ONLY: 'peer-only',
  DIVERGED: 'diverged',
  ASSETS_MISSING: 'assets-missing',
});

const sortedHashes = (a) => [...(Array.isArray(a) ? a : [])].sort();
const hashesEqual = (a, b) => {
  const sa = sortedHashes(a), sb = sortedHashes(b);
  return sa.length === sb.length && sa.every((h, i) => h === sb[i]);
};

// Pure diff of two manifest lists. Each entry: { id, name?, updatedAt, deleted?, assetHashes }.
// Tombstones (deleted) are excluded from "missing on the other side" so a deleted
// record doesn't read as local-only/peer-only.
export function computeRecordIntegrity(localList, remoteList) {
  const byId = new Map();
  for (const l of localList || []) byId.set(l.id, { id: l.id, name: l.name, local: l, remote: null });
  for (const r of remoteList || []) {
    const cur = byId.get(r.id) || { id: r.id, name: r.name, local: null, remote: null };
    cur.remote = r;
    if (!cur.name) cur.name = r.name;
    byId.set(r.id, cur);
  }
  const out = [];
  for (const { id, name, local, remote } of byId.values()) {
    const localLive = local && local.deleted !== true;
    const remoteLive = remote && remote.deleted !== true;
    let status;
    if (localLive && !remoteLive) status = INTEGRITY_STATUS.LOCAL_ONLY;
    else if (!localLive && remoteLive) status = INTEGRITY_STATUS.PEER_ONLY;
    else if (!localLive && !remoteLive) continue; // both tombstoned/absent → nothing to show
    else if (local.updatedAt !== remote.updatedAt) status = INTEGRITY_STATUS.DIVERGED;
    else if (!hashesEqual(local.assetHashes, remote.assetHashes)) status = INTEGRITY_STATUS.ASSETS_MISSING;
    else status = INTEGRITY_STATUS.IN_PARITY;
    out.push({ id, name: name || id, status });
  }
  return out;
}
```

Add `export * from './syncIntegrity.js';` (or named) to `server/lib/index.js` + a README row.

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(sync): pure record-integrity diff`

---

### Task 3.2: Local manifest builder + peer manifest fetch (orchestration)

**Files:**
- Create: `server/services/sharing/integrity.js`
- Test: `server/services/sharing/integrity.test.js`

- [ ] **Step 1: Write the failing test** — `buildLocalManifest('mediaCollection')` returns `[{ id, name, updatedAt, deleted, assetHashes }]` for local collections (seed two via `createCollection` + `addItem`, mock peers). Assert shape + that `assetHashes` reflects item refs.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement `integrity.js`**

```js
import { computeRecordIntegrity } from '../../lib/syncIntegrity.js';
import { listCollections } from '../mediaCollections.js';
import { listUniverses } from '../universeBuilder.js';
import { listSeries } from '../pipeline/series.js';
import { findPeerById } from './peerSync.js'; // or instances.js — use the existing helper
import { peerBaseUrl } from '../../lib/peerUrl.js';
import { peerFetch } from '../../lib/httpClient.js';

// One row per record: id, display name, updatedAt, deleted, and the set of
// asset hashes the record references (so the diff can detect byte divergence
// without shipping bytes). Asset hashes reuse buildAssetManifest's sha256s.
export async function buildLocalManifest(kind) {
  if (kind === 'mediaCollection') {
    const cols = await listCollections({ includeDeleted: true });
    return Promise.all(cols.map(async (c) => ({
      id: c.id, name: c.name, updatedAt: c.updatedAt, deleted: c.deleted === true,
      assetHashes: await collectionAssetHashes(c),
    })));
  }
  // universe / series: reuse listUniverses/listSeries + buildAssetManifest hashes.
  // (Implement parallel branches; for the first cut, mediaCollection is the priority.)
}

export async function getPeerIntegrity({ peerId, kind }) {
  const peer = await findPeerById(peerId);
  if (!peer) return { available: false, reason: 'peer-not-found', records: [] };
  const res = await peerFetch(`${peerBaseUrl(peer)}/api/peer-sync/manifest?kind=${encodeURIComponent(kind)}`).catch(() => null);
  if (!res || res.status === 404) return { available: false, reason: 'peer-too-old', records: [] };
  if (!res.ok) return { available: false, reason: 'fetch-failed', records: [] };
  const body = await res.json().catch(() => null);
  const remote = Array.isArray(body?.records) ? body.records : [];
  const local = await buildLocalManifest(kind);
  return { available: true, records: computeRecordIntegrity(local, remote) };
}
```

`collectionAssetHashes(c)` reuses the Group-2 manifest hashers (export a small helper from peerSync or compute via `buildCollectionAssetManifest(c).then(m => m.map(e => e.sha256))`).

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(sync): local manifest builder + peer integrity fetch`

---

### Task 3.3: HTTP routes — `GET /manifest`, `GET /integrity`

**Files:**
- Modify: `server/routes/peerSync.js`
- Test: `server/routes/peerSync.test.js` (create if absent — follow `palette.test.js` route-test style)

- [ ] **Step 1: Write the failing test** — `GET /api/peer-sync/manifest?kind=mediaCollection` returns `{ records: [...] }`; `GET /api/peer-sync/integrity?peerId=…&kind=…` returns `{ available, records }`. Invalid `kind` → 400.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** in `routes/peerSync.js`:

```js
import { buildLocalManifest, getPeerIntegrity } from '../services/sharing/integrity.js';
import { PEER_SUBSCRIBABLE_KINDS } from '../services/sharing/peerSync.js';

const validKind = (k) => typeof k === 'string' && PEER_SUBSCRIBABLE_KINDS.includes(k);

router.get('/manifest', asyncHandler(async (req, res) => {
  if (!validKind(req.query.kind)) throw new ServerError('invalid kind', { status: 400, code: 'VALIDATION_ERROR' });
  res.json({ records: await buildLocalManifest(req.query.kind) });
}));

router.get('/integrity', asyncHandler(async (req, res) => {
  if (typeof req.query.peerId !== 'string') throw new ServerError('peerId required', { status: 400, code: 'VALIDATION_ERROR' });
  if (!validKind(req.query.kind)) throw new ServerError('invalid kind', { status: 400, code: 'VALIDATION_ERROR' });
  res.json(await getPeerIntegrity({ peerId: req.query.peerId, kind: req.query.kind }));
}));
```

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(sync): peer manifest + integrity HTTP routes`

---

# GROUP 4 — Manual sync + client UI

### Task 4.1: Force-push + sync-now service functions

**Files:**
- Modify: `server/services/sharing/peerSync.js` — `forcePushRecord`, `syncNowForPeer`
- Test: `server/services/sharing/peerSync.test.js`

- [ ] **Step 1: Write the failing test** — `forcePushRecord` pushes even when `lastPushedHash` matches (mock `peerFetch`, assert a POST fired). `syncNowForPeer` subscribes-all + retries pending.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

```js
// Force a push regardless of the unchanged-hash short-circuit. Used by the
// manual "Sync to peers now" action. Resolves/creates the subscription first.
export async function forcePushRecord(peerId, recordKind, recordId) {
  const sub = (await findPeerSubscription(peerId, recordKind, recordId))
    || await subscribePeer({ peerId, recordKind, recordId });
  return pushRecordToPeer({ ...sub, lastPushedHash: null }, { bypassSchemaCooldown: true });
}

// Backfill-subscribe + retry every pending push for one peer's enabled kinds.
export async function syncNowForPeer(peerId) {
  const peer = await findPeerById(peerId);
  if (!peer?.instanceId) return { ok: false };
  for (const kind of PEER_SUBSCRIBABLE_KINDS) {
    if (peerHasCategory(peer, kind)) await autoSubscribePeerToAllRecords(peer.instanceId, kind).catch(() => {});
  }
  await retryPendingPushesForPeer(peer.instanceId).catch(() => {});
  return { ok: true };
}
```

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(sync): forcePushRecord + syncNowForPeer service fns`

---

### Task 4.2: Manual-sync HTTP routes

**Files:**
- Modify: `server/routes/peerSync.js`, `server/lib/validation.js`
- Test: `server/routes/peerSync.test.js`

- [ ] **Step 1: Write the failing test** — `POST /api/peer-sync/sync-record` with `{peerId, recordKind, recordId}` returns `{pushed}`; `POST /sync-now {peerId}` returns `{ok}`; `POST /pull-metadata {filenames}` returns `{attempted, recovered}`. Bad body → 400.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement schemas** (`validation.js`):

```js
export const peerSyncRecordSchema = z.object({
  peerId: z.string().trim().min(1).max(120),
  recordKind: z.enum(['universe', 'series', 'mediaCollection']),
  recordId: z.string().trim().min(1).max(200),
}).strict();
export const peerSyncNowSchema = z.object({ peerId: z.string().trim().min(1).max(120) }).strict();
export const peerPullMetadataSchema = z.object({
  peerId: z.string().trim().min(1).max(120).optional(),
  filenames: z.array(z.string().min(1).max(300)).max(5000),
}).strict();
```

**Routes** (`routes/peerSync.js`):

```js
router.post('/sync-record', asyncHandler(async (req, res) => {
  const { peerId, recordKind, recordId } = validateRequest(peerSyncRecordSchema, req.body || {});
  res.json(await forcePushRecord(peerId, recordKind, recordId).catch(mapAndRethrow));
}));
router.post('/sync-now', asyncHandler(async (req, res) => {
  const { peerId } = validateRequest(peerSyncNowSchema, req.body || {});
  res.json(await syncNowForPeer(peerId).catch(mapAndRethrow));
}));
router.post('/pull-metadata', asyncHandler(async (req, res) => {
  const { filenames } = validateRequest(peerPullMetadataSchema, req.body || {});
  const { backfillMissingSidecars } = await import('../services/sharing/sidecarSync.js');
  res.json(await backfillMissingSidecars({ filenames }));
}));
```

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(sync): manual sync + pull-metadata routes`

---

### Task 4.3: Client API wrappers

**Files:**
- Create: `client/src/services/apiPeerSync.js`
- Modify: `client/src/services/api.js` (re-export per the services barrel rule)
- Test: `client/src/services/apiPeerSync.test.js` (mock fetch)

- [ ] **Step 1: Write the failing test** — each wrapper calls the right path/method.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** using the existing `request()` helper from `apiCore.js` (pass `{ silent: true }` for calls whose callers own error UI):

```js
import { request } from './apiCore.js';
export const fetchSyncIntegrity = (peerId, kind, opts) =>
  request(`/api/peer-sync/integrity?peerId=${encodeURIComponent(peerId)}&kind=${encodeURIComponent(kind)}`, { ...opts });
export const syncRecordToPeer = (peerId, recordKind, recordId) =>
  request('/api/peer-sync/sync-record', { method: 'POST', body: { peerId, recordKind, recordId } });
export const syncNowForPeer = (peerId) =>
  request('/api/peer-sync/sync-now', { method: 'POST', body: { peerId } });
export const pullMissingMetadata = (filenames) =>
  request('/api/peer-sync/pull-metadata', { method: 'POST', body: { filenames } });
```

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(sync): client peer-sync API wrappers`

---

### Task 4.4: `useSyncIntegrity` hook

**Files:**
- Create: `client/src/hooks/useSyncIntegrity.js`
- Modify: `client/src/hooks/index.js` barrel + `README.md`
- Test: `client/src/hooks/useSyncIntegrity.test.js`

- [ ] **Step 1: Write the failing test** — hook fetches integrity for enabled online peers, returns a `Map<recordId, worstStatus>` + a `byPeer` breakdown. Mock the API wrapper.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** — fetch integrity per online peer (peers come from the existing instances/peers source), reduce to a worst-case status per record id (precedence: `peer-only`/`local-only`/`diverged`/`assets-missing` worse than `in-parity`). Expose `{ statusById, byPeer, loading, refresh }`. Reads from already-fetched peer state where possible (no duplicate peers fetch).

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(sync): useSyncIntegrity hook`

---

### Task 4.5: `SyncBadge` component

**Files:**
- Create: `client/src/components/sync/SyncBadge.jsx`
- Test: `client/src/components/sync/SyncBadge.test.jsx`

- [ ] **Step 1: Write the failing test** — renders the right label/color per status, including the distinct "not syncing — enable?" state when no peer has the category enabled. Uses the design tokens (`port-success`/`port-warning`/`port-error`). Clicking calls `onOpenDetail`.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** a small presentational component: prop `status` (one of `INTEGRITY_STATUS` + `'not-syncing'`), maps to `{ label, className }`, renders a button that calls `onOpenDetail`. No data fetching inside.

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(sync): SyncBadge component`

---

### Task 4.6: `SyncDetailDrawer` + deep-linkable routes

**Files:**
- Create: `client/src/components/sync/SyncDetailDrawer.jsx`
- Modify: `client/src/App.jsx` — routes `/universes/:id/sync`, `/pipeline/:id/sync`, `/media/collections/:id/sync`
- Modify: `client/src/pages/MediaCollections.jsx` (+ universe/series list pages) — render `<SyncBadge>` per row, wire navigation to the `/:id/sync` sub-route
- Test: `client/src/components/sync/SyncDetailDrawer.test.jsx`

- [ ] **Step 1: Write the failing test** — drawer shows per-peer breakdown, thumbnails for the record's items, the diff, and action buttons ("Sync to peers", "Pull metadata", "Re-pull from peer") wired to the API wrappers. Closing navigates back to the parent route.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** the drawer (reads `useSyncIntegrity` `byPeer` for the record id; reuses existing thumbnail components; buttons call `syncRecordToPeer` / `pullMissingMetadata` then `refresh()`). Add the three sub-routes in `App.jsx`. Render `<SyncBadge>` in each list page's rows using `statusById.get(record.id)`.

**No `NAV_COMMANDS` change** — these are sub-routes of already-registered pages (per the spec); confirm `server/lib/navManifest.test.js` still passes untouched.

- [ ] **Step 4: Run** → PASS. Run `cd client && npm test`.
- [ ] **Step 5: Commit** `feat(sync): SyncDetailDrawer + deep-linkable sync sub-routes + per-row badges`

---

### Task 4.7: "Pull missing prompts" on the Unsorted view

**Files:**
- Modify: the Unsorted collection view component (where `buildUnsortedCollection` is consumed)
- Test: client Vitest for the button → `pullMissingMetadata` call

- [ ] **Step 1: Write the failing test** — button collects the Unsorted image filenames and calls `pullMissingMetadata`, then refreshes the gallery.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — a "Pull missing prompts" button visible on the Unsorted view; on click, `pullMissingMetadata(unsortedImageFilenames)` then refetch images. Toast the `{recovered}/{attempted}` result.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(sync): manual Pull missing prompts action on Unsorted view`

---

# Final verification

- [ ] `cd server && npm test` (full server suite green, incl. `index.test.js` barrel guard, `navManifest.test.js`).
- [ ] `cd client && npm test` (full client suite green).
- [ ] `npm run build` (client builds clean).
- [ ] Run `/simplify` on the changed code before the PR (per CLAUDE.md).
- [ ] Manual federation smoke test: with two installs and `mediaCollections` toggled ON for the peer — create a collection on A, confirm it appears on B with items + prompts; delete on A, confirm tombstone removes it on B; check the SyncBadge reflects parity; run "Pull missing prompts" on B's Unsorted.
- [ ] Add a `.changelog/NEXT.md` entry.

# Self-review notes (addressed)

- **Spec coverage:** Piece 1 → Group 1; Piece 2 → Group 2; Piece 3 → Group 3 (Tasks 3.1-3.3); Piece 4 → Group 4. Opt-in default preserved (no change to `DEFAULT_SYNC_CATEGORIES.mediaCollections`). Auto+manual sidecar backfill → Tasks 2.2 (auto) + 2.3/4.7 (manual).
- **Type consistency:** `INTEGRITY_STATUS` constants used identically across syncIntegrity.js, the hook, and SyncBadge. `forcePushRecord(peerId, recordKind, recordId)` signature matches the route + client wrapper. `buildLocalManifest(kind)` / `getPeerIntegrity({peerId, kind})` consistent across integrity.js and routes.
- **Open verification during impl:** confirm `peerWireRecordSchema` accepts a sanitized collection (id + passthrough); confirm `getCollection` signature change has no un-migrated callers; confirm universe/series branches of `buildLocalManifest` before shipping their badges (mediaCollection is the priority kind).
