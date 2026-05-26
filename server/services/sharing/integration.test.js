/**
 * End-to-end sharing round-trip test.
 *
 * Exercises: register bucket → export series (records + assets + manifest) →
 * delete locally → processManifest (auto-merge) → verify the series reappears
 * with its original id, origin metadata, and asset blobs intact. Also verifies
 * the LWW re-merge path: re-export with newer updatedAt, re-process, confirm
 * local record updated and `overridden` populated.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { mockNoPeerSync, mockNoPeers } from '../../lib/mockPathsDataRoot.js';

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// Universe builder evaluates `join(PATHS.data, …)` at module-top, so PATHS
// must point at a real dir from the very first import. Allocate a single
// root up-front; per-test setup wipes + reseeds inside it.
const tempData = mkdtempSync(join(tmpdir(), 'portos-sharing-roundtrip-data-'));
let tempBucket;

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'PATHS') return {
        ...actual.PATHS,
        data: tempData,
        images: join(tempData, 'images'),
        videos: join(tempData, 'videos'),
      };
      return target[prop];
    },
  });
});

// Stub instances.getInstanceId so the exporter doesn't try to read the
// real identity.json. Returns a fixed id for assertions.
vi.mock('../instances.js', () => mockNoPeers({}, {
  getInstanceId: () => Promise.resolve('test-instance-id'),
  UNKNOWN_INSTANCE_ID: 'unknown',
}));
vi.mock('./peerSync.js', () => mockNoPeerSync());

// Stub mediaJobQueue.getJob — exporter uses it for full-fidelity gen
// metadata on each shared imageJobId. Returns null so the exporter falls
// through to direct asset copy via imageRefs.
vi.mock('../mediaJobQueue/index.js', () => ({
  getJob: () => null,
}));

const buckets = await import('./buckets.js');
const exporter = await import('./exporter.js');
const importer = await import('./importer.js');
const series = await import('../pipeline/series.js');
const issues = await import('../pipeline/issues.js');
const universeSvc = await import('../universeBuilder.js');

// Rewrite a manifest's senderInstanceId on disk so the importer sees it as
// coming from a remote peer. The mocked `getInstanceId` returns the same
// id for both producer and consumer in these tests, but in production
// instance A publishes and instance B imports — `processManifest` now
// short-circuits self-authored manifests, so the round-trip tests must
// flip the sender to simulate a peer.
function simulateRemoteSender(bucketPath, filename, peerId = 'remote-peer-id') {
  const p = join(bucketPath, 'manifests', filename);
  const m = JSON.parse(readFileSync(p, 'utf-8'));
  m.senderInstanceId = peerId;
  writeFileSync(p, JSON.stringify(m, null, 2));
}

describe('sharing round-trip', () => {
  beforeEach(() => {
    // Wipe and re-seed the temp data dir + a fake asset for each test.
    rmSync(tempData, { recursive: true, force: true });
    mkdirSync(tempData, { recursive: true });
    mkdirSync(join(tempData, 'images'), { recursive: true });
    mkdirSync(join(tempData, 'videos'), { recursive: true });
    writeFileSync(join(tempData, 'images', 'fakeasset.png'), 'PNGSTUB');
    tempBucket = mkdtempSync(join(tmpdir(), 'portos-sharing-roundtrip-bucket-'));
  });
  afterEach(() => {
    if (tempBucket) rmSync(tempBucket, { recursive: true, force: true });
  });

  it('exports a series, processes the manifest as inbox, then promotes — id + origin preserved', async () => {
    const bucket = await buckets.createBucket({ name: 'Test', path: tempBucket, mode: 'inbox' });

    // Author a series + an issue locally. Phase B.4: canon lives on the
    // linked universe — seed a universe with the character + imageRef so
    // the exporter (which walks linked-universe canon) finds the asset.
    const uni = await universeSvc.createUniverse({
      name: 'Salt Universe',
      characters: [{ name: 'Vex', imageRefs: ['fakeasset.png'] }],
    });
    const s = await series.createSeries({
      name: 'Salt Run', logline: 'A foundry city goes silent.', premise: 'The only survivor is a child.',
      universeId: uni.id,
    });
    const iss = await issues.createIssue({ seriesId: s.id, title: 'Issue 1' });

    // Export.
    const exp = await exporter.exportSeries(s.id, bucket.id);
    expect(exp.manifestId).toBeTruthy();
    expect(exp.recordCount).toBe(3); // series + issue + universe
    expect(exp.assetCount).toBeGreaterThanOrEqual(1);

    // Verify the bucket layout. v2 stores blobs content-addressed.
    expect(existsSync(join(tempBucket, 'manifests', exp.filename))).toBe(true);
    expect(existsSync(join(tempBucket, 'records', 'series', `${s.id}.json`))).toBe(true);
    expect(existsSync(join(tempBucket, 'records', 'issues', `${iss.id}.json`))).toBe(true);
    const fakeHash = sha256Hex('PNGSTUB');
    expect(existsSync(join(tempBucket, 'assets', 'blobs', fakeHash))).toBe(true);

    // Process as inbox (the bucket mode is 'inbox'). The manifest should
    // queue, not auto-apply.
    simulateRemoteSender(tempBucket, exp.filename);
    const result = await importer.processManifest(bucket.id, exp.filename);
    expect(result.processed).toBe(true);
    expect(result.outcome.mode).toBe('inbox');
    expect(result.outcome.queued).toBe(true);

    // Inbox should have one item.
    const inbox = await importer.listInbox(bucket.id);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].source).toBeTruthy();

    // Delete the local series + issue, then promote — the promote path runs
    // the auto-merge logic with insertWithId, so ids round-trip.
    await series.deleteSeries(s.id);
    await issues.deleteIssue(iss.id);
    await importer.promoteInboxItem(bucket.id, exp.manifestId);

    const restored = await series.getSeries(s.id);
    expect(restored.id).toBe(s.id);
    expect(restored.name).toBe('Salt Run');
    expect(restored.origin).toMatchObject({
      bucketId: bucket.id,
      manifestId: exp.manifestId,
    });
    expect(restored.origin.source).toBeTruthy();

    const restoredIssue = await issues.getIssue(iss.id);
    expect(restoredIssue.id).toBe(iss.id);
    expect(restoredIssue.seriesId).toBe(s.id);
    expect(restoredIssue.origin).toBeTruthy();

    // Asset blob should be back in data/images.
    expect(existsSync(join(tempData, 'images', 'fakeasset.png'))).toBe(true);

    // Inbox should be empty after promotion.
    expect(await importer.listInbox(bucket.id)).toEqual([]);
  });

  it('auto-merge mode applies records immediately and reports overridden on re-export', async () => {
    const bucket = await buckets.createBucket({ name: 'AutoBucket', path: tempBucket, mode: 'auto-merge' });

    const s = await series.createSeries({ name: 'Test Series', logline: 'A' });
    const exp = await exporter.exportSeries(s.id, bucket.id);

    // Drop the local series, then process — auto-merge inserts under preserved id.
    await series.deleteSeries(s.id);
    simulateRemoteSender(tempBucket, exp.filename);
    const r1 = await importer.processManifest(bucket.id, exp.filename);
    expect(r1.outcome.mode).toBe('auto-merge');
    expect(r1.outcome.applied).toBeGreaterThan(0);
    expect(r1.outcome.overridden).toEqual([]);
    const restored = await series.getSeries(s.id);
    expect(restored.id).toBe(s.id);

    // Modify the local series so the next export carries a NEWER updatedAt.
    await new Promise((r) => setTimeout(r, 5));
    await series.updateSeries(s.id, { name: 'Test Series (renamed)' });

    // Re-export — manifest carries the newer record.
    const exp2 = await exporter.exportSeries(s.id, bucket.id);

    // Roll the local copy backwards by a millisecond so the *remote* is newer.
    await new Promise((r) => setTimeout(r, 5));
    await series.updateSeries(s.id, { name: 'Test Series (renamed)' });
    // Force the local updatedAt to be older than the manifest so LWW triggers override.
    // (Easiest: mutate the on-disk JSON directly to set an old updatedAt.)
    const statePath = join(tempData, 'pipeline-series', s.id, 'index.json');
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    state.updatedAt = '2020-01-01T00:00:00.000Z';
    writeFileSync(statePath, JSON.stringify(state, null, 2));

    // Process the new manifest — should LWW-override.
    simulateRemoteSender(tempBucket, exp2.filename);
    const r2 = await importer.processManifest(bucket.id, exp2.filename);
    expect(r2.outcome.mode).toBe('auto-merge');
    expect(r2.outcome.overridden).toHaveLength(1);
    expect(r2.outcome.overridden[0]).toMatchObject({ kind: 'series', id: s.id });

    const afterOverride = await series.getSeries(s.id);
    expect(afterOverride.name).toBe('Test Series (renamed)');
  });

  it('a remote orphan series (universeId null) preserves the local universe link instead of aborting the import', async () => {
    const bucket = await buckets.createBucket({ name: 'OrphanLinkBucket', path: tempBucket, mode: 'auto-merge' });
    const u = await universeSvc.createUniverse({ name: 'Linked Universe' });
    const s = await series.createSeries({ name: 'Linked Series', universeId: u.id });
    const exp = await exporter.exportSeries(s.id, bucket.id);

    // Rewrite the exported series record to look like an ORPHAN (no universeId)
    // with a newer updatedAt — mimics an older/cleared peer. Before the fix this
    // tripped updateSeries's "cannot unlink" guard and threw, aborting the whole
    // manifest import; now the importer preserves the local link.
    const seriesRecPath = join(tempBucket, 'records', 'series', `${s.id}.json`);
    const rec = JSON.parse(readFileSync(seriesRecPath, 'utf-8'));
    rec.universeId = null;
    rec.updatedAt = '2999-01-01T00:00:00.000Z';
    writeFileSync(seriesRecPath, JSON.stringify(rec, null, 2));

    simulateRemoteSender(tempBucket, exp.filename);
    const r = await importer.processManifest(bucket.id, exp.filename);
    expect(r.processed).toBe(true);
    expect(r.outcome.recordImportFailures).toBeFalsy();

    // Link preserved (not unlinked), and the series survived the import.
    const after = await series.getSeries(s.id);
    expect(after.universeId).toBe(u.id);
  });

  it('seeds a conflict-journal base hash when a series is first imported (so its first divergence is journaled)', async () => {
    const bucket = await buckets.createBucket({ name: 'BaseSeedBucket', path: tempBucket, mode: 'auto-merge' });
    const u = await universeSvc.createUniverse({ name: 'Seed Universe' });
    const s = await series.createSeries({ name: 'Seed Series', universeId: u.id });
    const exp = await exporter.exportSeries(s.id, bucket.id);

    // Drop the local copy so the import is a fresh INSERT (the branch that
    // previously skipped base-hash seeding).
    await series.deleteSeries(s.id);
    simulateRemoteSender(tempBucket, exp.filename);
    await importer.processManifest(bucket.id, exp.filename);

    const baseHashPath = join(tempData, 'sharing', 'sync_base_hashes.json');
    const baseHashes = JSON.parse(readFileSync(baseHashPath, 'utf-8'));
    expect(baseHashes[`series:${s.id}`]).toBeTruthy();
  });

  it('re-importing the same manifest is a no-op (cursor dedup)', async () => {
    const bucket = await buckets.createBucket({ name: 'D', path: tempBucket, mode: 'auto-merge' });
    const s = await series.createSeries({ name: 'X' });
    const exp = await exporter.exportSeries(s.id, bucket.id);
    await series.deleteSeries(s.id);
    simulateRemoteSender(tempBucket, exp.filename);

    const r1 = await importer.processManifest(bucket.id, exp.filename);
    expect(r1.processed).toBe(true);

    const r2 = await importer.processManifest(bucket.id, exp.filename);
    expect(r2.skipped).toBe(true);
    expect(r2.reason).toBe('already-processed');
  });

  it('universe export bundles the linked collection — recipient gains the items', async () => {
    const bucket = await buckets.createBucket({ name: 'CollabBucket', path: tempBucket, mode: 'auto-merge' });
    const universeBuilder = await import('../universeBuilder.js');
    const mediaCollections = await import('../mediaCollections.js');
    const u = await universeBuilder.createUniverse({ name: 'Linked Universe' });

    // Pretend universe-builder rendered two images and filed them into a
    // collection. Each item.ref points at a real file in tempData/images
    // (we seeded 'fakeasset.png' in beforeEach, but for variety, add another).
    const fs = await import('fs');
    fs.writeFileSync(join(tempData, 'images', 'second.png'), 'PNG2');
    const collection = await mediaCollections.findOrCreateCollectionByName({
      name: `Universe: ${u.name}`, description: 'Linked', universeId: u.id,
    });
    await mediaCollections.addItem(collection.id, { kind: 'image', ref: 'fakeasset.png' });
    await mediaCollections.addItem(collection.id, { kind: 'image', ref: 'second.png' });

    // Export the universe — manifest should carry the collection payload
    // and assets should land in the bucket.
    const exp = await exporter.exportUniverse(u.id, bucket.id);
    expect(exp.assetCount).toBeGreaterThanOrEqual(2);
    const manifestFile = exp.filename;
    const manifest = JSON.parse(fs.readFileSync(join(tempBucket, 'manifests', manifestFile), 'utf-8'));
    expect(manifest.collection).toMatchObject({ universeId: u.id });
    expect(manifest.collection.items).toHaveLength(2);
    expect(fs.existsSync(join(tempBucket, 'assets', 'blobs', sha256Hex('PNG2')))).toBe(true);

    // Drop the local collection + universe, then re-process: the importer
    // should recreate both, find-or-create the local collection by
    // universeId, and merge the items in.
    await mediaCollections.deleteCollection(collection.id);
    await universeBuilder.deleteUniverse(u.id);
    expect((await mediaCollections.listCollections()).find((c) => c.universeId === u.id)).toBeUndefined();

    simulateRemoteSender(tempBucket, manifestFile);
    const r = await importer.processManifest(bucket.id, manifestFile);
    expect(r.processed).toBe(true);
    expect(r.outcome.collectionItemsAdded).toBe(2);

    const localCollections = await mediaCollections.listCollections();
    const restoredCollection = localCollections.find((c) => c.universeId === u.id);
    expect(restoredCollection).toBeTruthy();
    expect(restoredCollection.items.map((i) => i.ref).sort()).toEqual(['fakeasset.png', 'second.png']);
    // Asset blobs are back in the local data/images pool.
    expect(fs.existsSync(join(tempData, 'images', 'second.png'))).toBe(true);
  });

  it('series export bundles the per-series collection when the series has no universe', async () => {
    // A series without a universeId — covers auto-file into a per-series
    // "Series: <name>" collection (mediaCollections.seriesId stamp) and the
    // exporter must bundle that into manifest.collection so the recipient
    // sees the same covers alongside the series record.
    const bucket = await buckets.createBucket({ name: 'SeriesCollBucket', path: tempBucket, mode: 'auto-merge' });
    const mediaCollections = await import('../mediaCollections.js');
    const s = await series.createSeries({ name: 'Indie Saga', logline: 'L' });

    const fs = await import('fs');
    fs.writeFileSync(join(tempData, 'images', 'cover-a.png'), 'COVA');
    fs.writeFileSync(join(tempData, 'images', 'cover-b.png'), 'COVB');
    const collection = await mediaCollections.findOrCreateSeriesCollection({
      seriesId: s.id, seriesName: s.name,
    });
    await mediaCollections.addItem(collection.id, { kind: 'image', ref: 'cover-a.png' });
    await mediaCollections.addItem(collection.id, { kind: 'image', ref: 'cover-b.png' });

    // Export — manifest must carry the seriesId-keyed collection payload.
    const exp = await exporter.exportSeries(s.id, bucket.id);
    const manifest = JSON.parse(fs.readFileSync(join(tempBucket, 'manifests', exp.filename), 'utf-8'));
    expect(manifest.collection).toMatchObject({ seriesId: s.id });
    expect(manifest.collection.universeId).toBeUndefined();
    expect(manifest.collection.items.map((i) => i.ref).sort()).toEqual(['cover-a.png', 'cover-b.png']);
    expect(fs.existsSync(join(tempBucket, 'assets', 'blobs', sha256Hex('COVA')))).toBe(true);
    expect(fs.existsSync(join(tempBucket, 'assets', 'blobs', sha256Hex('COVB')))).toBe(true);

    // Drop the local collection + series, then re-process: importer
    // restores the series and find-or-creates the local per-series
    // collection by seriesId, unioning the items in.
    await mediaCollections.deleteCollection(collection.id);
    await series.deleteSeries(s.id);
    expect((await mediaCollections.listCollections()).find((c) => c.seriesId === s.id)).toBeUndefined();

    simulateRemoteSender(tempBucket, exp.filename);
    const r = await importer.processManifest(bucket.id, exp.filename);
    expect(r.processed).toBe(true);
    expect(r.outcome.collectionItemsAdded).toBe(2);

    const localCollections = await mediaCollections.listCollections();
    const restored = localCollections.find((c) => c.seriesId === s.id);
    expect(restored).toBeTruthy();
    expect(restored.name).toBe('Series: Indie Saga');
    expect(restored.items.map((i) => i.ref).sort()).toEqual(['cover-a.png', 'cover-b.png']);
    // Asset blobs are back in the local data/images pool.
    expect(fs.existsSync(join(tempData, 'images', 'cover-a.png'))).toBe(true);
    expect(fs.existsSync(join(tempData, 'images', 'cover-b.png'))).toBe(true);
  });

  it('series export prefers the universe-linked collection when both exist', async () => {
    // A series can in principle be linked to a universe (universe-owned
    // collection) AND have a stray per-series collection (e.g. from a
    // prior universeless phase). The exporter prefers the universe one
    // since it represents the canonical bucket for that universe.
    const bucket = await buckets.createBucket({ name: 'BothBucket', path: tempBucket, mode: 'auto-merge' });
    const universeBuilder = await import('../universeBuilder.js');
    const mediaCollections = await import('../mediaCollections.js');
    const u = await universeBuilder.createUniverse({ name: 'Linked' });
    const s = await series.createSeries({ name: 'Series', universeId: u.id });

    const fs = await import('fs');
    fs.writeFileSync(join(tempData, 'images', 'uni.png'), 'UNI');
    fs.writeFileSync(join(tempData, 'images', 'ser.png'), 'SER');

    const uniColl = await mediaCollections.findOrCreateUniverseCollection({
      universeId: u.id, universeName: u.name,
    });
    await mediaCollections.addItem(uniColl.id, { kind: 'image', ref: 'uni.png' });

    const serColl = await mediaCollections.findOrCreateSeriesCollection({
      seriesId: s.id, seriesName: s.name,
    });
    await mediaCollections.addItem(serColl.id, { kind: 'image', ref: 'ser.png' });

    const exp = await exporter.exportSeries(s.id, bucket.id);
    const manifest = JSON.parse(fs.readFileSync(join(tempBucket, 'manifests', exp.filename), 'utf-8'));
    expect(manifest.collection).toMatchObject({ universeId: u.id });
    expect(manifest.collection.items.map((i) => i.ref)).toEqual(['uni.png']);
  });

  it('linked series never falls through to a stray seriesId-stamped collection', async () => {
    // A series can be linked to a universe AND have a stray per-series
    // collection from a prior universeless phase (or an orphan after
    // `unlinkCollectionsForUniverse` recovery). When the universe-linked
    // collection happens to be absent at export time (mid-migration, or
    // a manual deletion), the exporter must NOT silently fall back to the
    // stale seriesId-stamped collection — linked series export under the
    // universe-collection contract or no collection payload at all.
    const bucket = await buckets.createBucket({ name: 'LinkedNoUniColl', path: tempBucket, mode: 'auto-merge' });
    const universeBuilder = await import('../universeBuilder.js');
    const mediaCollections = await import('../mediaCollections.js');
    const u = await universeBuilder.createUniverse({ name: 'CanonOnly' });
    const s = await series.createSeries({ name: 'Bound', universeId: u.id });

    const fs = await import('fs');
    fs.writeFileSync(join(tempData, 'images', 'stale.png'), 'STALE');
    // Stamp a seriesId collection directly (simulating a leftover from a
    // prior universeless phase). No universe collection exists.
    const serColl = await mediaCollections.findOrCreateSeriesCollection({
      seriesId: s.id, seriesName: s.name,
    });
    await mediaCollections.addItem(serColl.id, { kind: 'image', ref: 'stale.png' });
    expect(await mediaCollections.findCollectionByUniverseId(u.id)).toBeNull();

    const exp = await exporter.exportSeries(s.id, bucket.id);
    const manifest = JSON.parse(fs.readFileSync(join(tempBucket, 'manifests', exp.filename), 'utf-8'));
    // No collection payload — the stale seriesId bucket was correctly ignored.
    expect(manifest.collection).toBeNull();
  });

  it('series collection import re-routes to the universe collection when the local series is now universe-linked', async () => {
    // Peer's manifest was produced when the series was universeless (so it
    // carries `collection.seriesId`), but the local series has since been
    // linked to a universe. Importer must NOT mint a fresh seriesId-stamped
    // collection — that would leave a rename-locked stale per-series bucket
    // attached to a linked series, breaking the contract the exporter and
    // cover filer enforce. Re-route the payload into the universe collection.
    const bucket = await buckets.createBucket({ name: 'StaleSeriesPayload', path: tempBucket, mode: 'auto-merge' });
    const mediaCollections = await import('../mediaCollections.js');
    const universeBuilder = await import('../universeBuilder.js');
    const fs = await import('fs');

    // Sender side: universeless series + per-series collection with one cover.
    const s = await series.createSeries({ name: 'WillLink', logline: 'L' });
    fs.writeFileSync(join(tempData, 'images', 'stale-cover.png'), 'STALE');
    const senderColl = await mediaCollections.findOrCreateSeriesCollection({
      seriesId: s.id, seriesName: s.name,
    });
    await mediaCollections.addItem(senderColl.id, { kind: 'image', ref: 'stale-cover.png' });
    const exp = await exporter.exportSeries(s.id, bucket.id);

    // Now (still on the sender — same env, simpler test setup) link the
    // series to a universe and drop the per-series collection. The "local"
    // state from the importer's perspective is: linked series, no per-series
    // collection. Recipient re-applies the manifest.
    const u = await universeBuilder.createUniverse({ name: 'NewCanon' });
    await series.updateSeries(s.id, { universeId: u.id });
    await mediaCollections.deleteCollection(senderColl.id);

    simulateRemoteSender(tempBucket, exp.filename);
    const r = await importer.processManifest(bucket.id, exp.filename);
    expect(r.processed).toBe(true);
    expect(r.outcome.collectionItemsAdded).toBe(1);

    // The cover landed in the UNIVERSE collection, not a new seriesId bucket.
    const universeColl = await mediaCollections.findCollectionByUniverseId(u.id);
    expect(universeColl).toBeTruthy();
    expect(universeColl.items.map((i) => i.ref)).toEqual(['stale-cover.png']);
    // No seriesId-stamped collection exists for the now-linked series.
    expect(await mediaCollections.findCollectionBySeriesId(s.id)).toBeNull();
  });

  it('series collection import defers when the local series is missing', async () => {
    // Mirrors the universe-pending case: the manifest references a
    // seriesId we haven't imported locally. The cursor must stay
    // un-advanced so a later sync of the series unblocks the merge.
    const bucket = await buckets.createBucket({ name: 'DeferBucket', path: tempBucket, mode: 'auto-merge' });
    const mediaCollections = await import('../mediaCollections.js');
    const s = await series.createSeries({ name: 'Will Vanish' });
    const fs = await import('fs');
    fs.writeFileSync(join(tempData, 'images', 'late-cover.png'), 'LATE');
    const collection = await mediaCollections.findOrCreateSeriesCollection({
      seriesId: s.id, seriesName: s.name,
    });
    await mediaCollections.addItem(collection.id, { kind: 'image', ref: 'late-cover.png' });

    const exp = await exporter.exportSeries(s.id, bucket.id);
    // Delete the series locally so the importer sees an orphaned payload.
    await mediaCollections.deleteCollection(collection.id);
    await series.deleteSeries(s.id);
    // Also drop the series record from the bucket so insertSeriesWithId
    // doesn't restore it — this isolates the "collection waits on series"
    // case rather than "round-trip restores everything."
    fs.rmSync(join(tempBucket, 'records', 'series', `${s.id}.json`), { force: true });

    simulateRemoteSender(tempBucket, exp.filename);
    const r = await importer.processManifest(bucket.id, exp.filename);
    expect(r.pending).toBe(true);
    expect(r.outcome.pendingCollectionSeries).toBe(s.id);
  });

  it('universe export ignores a same-named unlinked collection (universeId-only routing)', async () => {
    // Round-9 review caught that the exporter's old "fall back to name
    // match" path could pick up a post-deleteUniverse orphan and ship it
    // out under a new same-named universe. The runtime fallback is gone;
    // the upgrade path for genuinely-legacy installs is migration 021
    // (which runs at boot, before any exporter call). This test pins the
    // new contract.
    const bucket = await buckets.createBucket({ name: 'LegacyBucket', path: tempBucket, mode: 'auto-merge' });
    const universeBuilder = await import('../universeBuilder.js');
    const mediaCollections = await import('../mediaCollections.js');
    const u = await universeBuilder.createUniverse({ name: 'Post-Epoc' });
    const fs = await import('fs');
    fs.writeFileSync(join(tempData, 'images', 'legacy.png'), 'PNG');

    // Unlinked collection with the conventional name — exporter must NOT
    // adopt this for the universe.
    const orphan = await mediaCollections.createCollection({
      name: `Universe: ${u.name}`,
      description: 'Legacy unlinked collection',
    });
    await mediaCollections.addItem(orphan.id, { kind: 'image', ref: 'legacy.png' });

    const exp = await exporter.exportUniverse(u.id, bucket.id);
    const manifest = JSON.parse(fs.readFileSync(join(tempBucket, 'manifests', exp.filename), 'utf-8'));
    // No collection payload in the manifest — the universe had no
    // universeId-linked collection.
    expect(manifest.collection).toBeFalsy();
  });

  it('keeps universe manifests retryable while Drive assets are still syncing', async () => {
    const bucket = await buckets.createBucket({ name: 'SlowDriveBucket', path: tempBucket, mode: 'auto-merge' });
    const universeBuilder = await import('../universeBuilder.js');
    const mediaCollections = await import('../mediaCollections.js');
    const { readCursor, hasBeenProcessed } = await import('./manifest.js');
    const u = await universeBuilder.createUniverse({ name: 'Slow Sync Universe' });
    const fs = await import('fs');
    fs.writeFileSync(join(tempData, 'images', 'late.png'), 'LATEPNG');

    const collection = await mediaCollections.findOrCreateCollectionByName({
      name: `Universe: ${u.name}`, description: 'Linked', universeId: u.id,
    });
    await mediaCollections.addItem(collection.id, { kind: 'image', ref: 'fakeasset.png' });
    await mediaCollections.addItem(collection.id, { kind: 'image', ref: 'late.png' });

    const exp = await exporter.exportUniverse(u.id, bucket.id);
    const lateHash = sha256Hex('LATEPNG');
    fs.rmSync(join(tempBucket, 'assets', 'blobs', lateHash), { force: true });
    fs.rmSync(join(tempData, 'images', 'late.png'), { force: true });
    await mediaCollections.deleteCollection(collection.id);
    await universeBuilder.deleteUniverse(u.id);

    simulateRemoteSender(tempBucket, exp.filename);
    const first = await importer.processManifest(bucket.id, exp.filename);
    expect(first.pending).toBe(true);
    expect(first.outcome.pendingAssets).toEqual([{ kind: 'image', ref: 'late.png' }]);
    expect(first.outcome.collectionItemsAdded).toBe(1);
    expect(first.outcome.collectionItemsDeferred).toBe(1);

    let restoredCollection = (await mediaCollections.listCollections()).find((c) => c.universeId === u.id);
    expect(restoredCollection.items.map((i) => i.ref)).toEqual(['fakeasset.png']);
    let cursor = await readCursor(bucket.id);
    expect(hasBeenProcessed(cursor, exp.filename, exp.manifestId)).toBe(false);

    fs.writeFileSync(join(tempBucket, 'assets', 'blobs', lateHash), 'LATEPNG');
    const retry = await importer.processBacklog(bucket.id);
    expect(retry.processed).toBe(1);

    restoredCollection = (await mediaCollections.listCollections()).find((c) => c.universeId === u.id);
    expect(restoredCollection.items.map((i) => i.ref).sort()).toEqual(['fakeasset.png', 'late.png']);
    expect(fs.existsSync(join(tempData, 'images', 'late.png'))).toBe(true);
    cursor = await readCursor(bucket.id);
    expect(hasBeenProcessed(cursor, exp.filename, exp.manifestId)).toBe(true);
  });

  it('keeps universe manifests retryable while the record JSON itself is still syncing', async () => {
    const bucket = await buckets.createBucket({ name: 'SlowRecordBucket', path: tempBucket, mode: 'auto-merge' });
    const universeBuilder = await import('../universeBuilder.js');
    const { readCursor, hasBeenProcessed } = await import('./manifest.js');
    const u = await universeBuilder.createUniverse({ name: 'Late Record Universe' });

    const exp = await exporter.exportUniverse(u.id, bucket.id);
    simulateRemoteSender(tempBucket, exp.filename);
    // Simulate Drive delivering the manifest before the record JSON syncs.
    const fs = await import('fs');
    const recordPath = join(tempBucket, 'records', 'universes', `${u.id}.json`);
    const recordSnapshot = fs.readFileSync(recordPath);
    fs.rmSync(recordPath, { force: true });
    await universeBuilder.deleteUniverse(u.id);

    const first = await importer.processManifest(bucket.id, exp.filename);
    expect(first.pending).toBe(true);
    expect(first.outcome.pendingRecords).toEqual([u.id]);
    let cursor = await readCursor(bucket.id);
    expect(hasBeenProcessed(cursor, exp.filename, exp.manifestId)).toBe(false);
    await expect(universeBuilder.getUniverse(u.id)).rejects.toThrow();

    // Record JSON finally syncs — retry should insert + mark processed.
    fs.writeFileSync(recordPath, recordSnapshot);
    const retry = await importer.processBacklog(bucket.id);
    expect(retry.processed).toBe(1);
    const restored = await universeBuilder.getUniverse(u.id);
    expect(restored.name).toBe('Late Record Universe');
    cursor = await readCursor(bucket.id);
    expect(hasBeenProcessed(cursor, exp.filename, exp.manifestId)).toBe(true);
  });

  it('keeps a manifest retryable (does not advance the cursor) when a record insert fails unexpectedly', async () => {
    // A non-duplicate insert failure (disk error, transient fs error) must NOT
    // advance the cursor — otherwise the manifest is marked processed and the
    // record is silently dropped. It must stay pending and retry.
    const bucket = await buckets.createBucket({ name: 'InsertFailBucket', path: tempBucket, mode: 'auto-merge' });
    const universeBuilder = await import('../universeBuilder.js');
    const { readCursor, hasBeenProcessed } = await import('./manifest.js');
    const u = await universeBuilder.createUniverse({ name: 'Fails To Insert Once' });

    const exp = await exporter.exportUniverse(u.id, bucket.id);
    simulateRemoteSender(tempBucket, exp.filename);
    await universeBuilder.deleteUniverse(u.id);

    // Force the first insert to throw a non-duplicate error (not a *_DUPLICATE).
    const spy = vi.spyOn(universeBuilder, 'insertUniverseWithId')
      .mockRejectedValueOnce(new Error('simulated transient disk failure'));

    const first = await importer.processManifest(bucket.id, exp.filename);
    expect(first.pending).toBe(true);
    expect(first.outcome.pendingRecordImportFailures).toEqual([`universe:${u.id}`]);
    let cursor = await readCursor(bucket.id);
    expect(hasBeenProcessed(cursor, exp.filename, exp.manifestId)).toBe(false);
    await expect(universeBuilder.getUniverse(u.id)).rejects.toThrow();

    // Insert succeeds on retry → manifest finally marked processed.
    spy.mockRestore();
    const retry = await importer.processBacklog(bucket.id);
    expect(retry.processed).toBe(1);
    const restored = await universeBuilder.getUniverse(u.id);
    expect(restored.name).toBe('Fails To Insert Once');
    cursor = await readCursor(bucket.id);
    expect(hasBeenProcessed(cursor, exp.filename, exp.manifestId)).toBe(true);
  });

  it('keeps series manifests retryable while issue record files are still syncing', async () => {
    const bucket = await buckets.createBucket({ name: 'SlowIssueSync', path: tempBucket, mode: 'auto-merge' });
    const { readCursor, hasBeenProcessed } = await import('./manifest.js');

    const s = await series.createSeries({ name: 'Drifts a Bit Late' });
    const issA = await issues.createIssue({ seriesId: s.id, title: 'Arrives on Time' });
    const issB = await issues.createIssue({ seriesId: s.id, title: 'Arrives Later' });

    const exp = await exporter.exportSeries(s.id, bucket.id);
    expect(exp.recordCount).toBe(3); // series + 2 issues

    // Simulate Drive having synced the manifest + series + issA but not yet issB.
    const fs = await import('fs');
    const issBPath = join(tempBucket, 'records', 'issues', `${issB.id}.json`);
    expect(fs.existsSync(issBPath)).toBe(true);
    fs.rmSync(issBPath, { force: true });

    // Drop local copies so the importer has to insert from the bucket.
    await issues.deleteIssue(issA.id);
    await issues.deleteIssue(issB.id);
    await series.deleteSeries(s.id);

    simulateRemoteSender(tempBucket, exp.filename);
    const first = await importer.processManifest(bucket.id, exp.filename);
    expect(first.pending).toBe(true);
    expect(first.outcome.pendingRecords).toEqual([issB.id]);
    expect(first.outcome.pendingAssets).toBeUndefined();

    // The records that DID arrive should be applied — the late one stays absent.
    const restoredA = await issues.getIssue(issA.id);
    expect(restoredA.title).toBe('Arrives on Time');
    await expect(issues.getIssue(issB.id)).rejects.toMatchObject({ code: 'PIPELINE_ISSUE_NOT_FOUND' });

    let cursor = await readCursor(bucket.id);
    expect(hasBeenProcessed(cursor, exp.filename, exp.manifestId)).toBe(false);

    // Late-arriving record file → backlog retry completes the import.
    fs.writeFileSync(issBPath, JSON.stringify({
      id: issB.id, seriesId: s.id, title: 'Arrives Later', number: 2,
      status: 'draft', stages: {},
      createdAt: issB.createdAt, updatedAt: issB.updatedAt,
    }));

    const retry = await importer.processBacklog(bucket.id);
    expect(retry.processed).toBe(1);

    const restoredB = await issues.getIssue(issB.id);
    expect(restoredB.title).toBe('Arrives Later');
    cursor = await readCursor(bucket.id);
    expect(hasBeenProcessed(cursor, exp.filename, exp.manifestId)).toBe(true);
  });

  it('createIssue emits recordUpdated so series subscriptions re-export', async () => {
    const { recordEvents } = await import('./recordEvents.js');
    const s = await series.createSeries({ name: 'Emits On Create' });
    const events = [];
    const onUpdated = (p) => events.push(p);
    recordEvents.on('updated', onUpdated);
    try {
      const iss = await issues.createIssue({ seriesId: s.id, title: 'First Issue' });
      expect(events).toContainEqual({ recordKind: 'series', recordId: s.id });
      expect(iss.seriesId).toBe(s.id);
    } finally {
      recordEvents.off('updated', onUpdated);
    }
  });

  it('subscription round-trip: subscribe → mutate → re-export onto same filename → unsubscribe → unshared event', async () => {
    const { subscribe, unsubscribe, subscriptionFilename, __resetForTests } = await import('./subscriptions.js');
    const { sharingEvents } = await import('./importer.js');
    __resetForTests();
    const bucket = await buckets.createBucket({ name: 'SubBucket', path: tempBucket, mode: 'auto-merge' });
    const universeBuilder = await import('../universeBuilder.js');
    const u = await universeBuilder.createUniverse({ name: 'Sub Universe' });

    // Subscribe — first export writes a deterministic-named file.
    const sub = await subscribe({ bucketId: bucket.id, recordKind: 'universe', recordId: u.id });
    const filename = subscriptionFilename({ ...sub, senderInstanceId: 'test-instance-id' });
    const filePath = join(tempBucket, 'manifests', filename);
    const fs = await import('fs');
    expect(fs.existsSync(filePath)).toBe(true);
    const first = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(first.subscription).toMatchObject({ recordKind: 'universe', recordId: u.id });
    const firstManifestId = first.id;

    // Mutate the universe — emit fires recordEvents which schedules a re-export.
    // For the test, bypass the 3s debounce by calling subscribe again (idempotent).
    await universeBuilder.updateUniverse(u.id, { starterPrompt: 'updated prompt' });
    await subscribe({ bucketId: bucket.id, recordKind: 'universe', recordId: u.id }); // forces immediate re-export
    const second = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(second.id).not.toBe(firstManifestId);
    // Importer's cursor logic dedups by manifest id, so a re-import of the
    // updated file is recognized as new content.
    const r1 = await importer.processManifest(bucket.id, filename);
    expect(r1.processed || r1.skipped).toBeTruthy();

    // Unsubscribe — deletes the file. Watcher's `unlink` calls handleUnshare
    // (here we invoke it directly since chokidar is not running in tests).
    const events = [];
    const onUnshared = (p) => events.push(p);
    sharingEvents.on('unshared', onUnshared);

    await unsubscribe(sub.id);
    expect(fs.existsSync(filePath)).toBe(false);

    await importer.handleUnshare(bucket.id, filename);
    sharingEvents.off('unshared', onUnshared);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ bucketId: bucket.id, manifestFilename: filename });

    // Local imported universe should NOT have been removed — unshare doesn't
    // reverse the import on the recipient. The universe still exists locally.
    const stillThere = await universeBuilder.getUniverse(u.id);
    expect(stillThere.id).toBe(u.id);
  });

  it('inbox dedup keeps newer per-sender row when older legacy file processes after it (upgrade scenario)', async () => {
    // During the v1→v2 upgrade a bucket may briefly hold both the new
    // `sub-<kind>-<id>-<sender>.json` and the legacy `sub-<kind>-<id>.json`
    // for the same sender. Lexicographic backlog order visits the new file
    // (with `-`) before the legacy file (with `.`), so without a freshness
    // gate the older legacy manifest would clobber the newer inbox row.
    const bucket = await buckets.createBucket({ name: 'UpgradeBucket', path: tempBucket, mode: 'inbox' });
    const universeBuilder = await import('../universeBuilder.js');
    const u = await universeBuilder.createUniverse({ name: 'U-upgrade' });

    const manifestsDir = join(tempBucket, 'manifests');
    mkdirSync(manifestsDir, { recursive: true });

    // Hand-craft both manifests for the same (universe, sender) pair. The
    // legacy file is OLDER (5 minutes earlier) and uses the pre-v2 name.
    // The per-sender file is NEWER and uses the v2 name.
    const olderTs = '2026-01-01T00:00:00.000Z';
    const newerTs = '2026-01-01T00:05:00.000Z';
    const baseManifest = {
      schemaVersion: 1,
      sharingSchemaVersion: 1,
      producedByVersion: '1.0.0',
      kind: 'universe',
      subscription: { recordKind: 'universe', recordId: u.id },
      senderInstanceId: 'remote-peer-id',
      source: 'remote peer',
      sourceBio: null,
      bucketId: bucket.id,
      bucketName: bucket.name,
      recordIds: [u.id],
      assetRefs: [],
      collection: null,
      note: null,
    };
    const legacyName = `sub-universe-${u.id}.json`;
    const perSenderName = `sub-universe-${u.id}-remote-peer-id.json`;
    writeFileSync(join(manifestsDir, legacyName), JSON.stringify({
      ...baseManifest, id: 'mfst-legacy-old', createdAt: olderTs,
    }));
    writeFileSync(join(manifestsDir, perSenderName), JSON.stringify({
      ...baseManifest, id: 'mfst-per-sender-new', createdAt: newerTs,
    }));

    // Sanity: lex-sort puts the per-sender file first, legacy after — this is
    // the order the importer's backlog scan walks the directory in.
    expect([legacyName, perSenderName].sort()).toEqual([perSenderName, legacyName]);

    // Mirror records/ so processManifest can locate the universe payload.
    mkdirSync(join(tempBucket, 'records', 'universes'), { recursive: true });
    writeFileSync(
      join(tempBucket, 'records', 'universes', `${u.id}.json`),
      JSON.stringify({ ...u, updatedAt: newerTs }),
    );

    const r1 = await importer.processManifest(bucket.id, perSenderName);
    expect(r1.processed).toBe(true);
    const r2 = await importer.processManifest(bucket.id, legacyName);
    // The older legacy manifest should NOT replace the newer inbox row.
    expect(r2.outcome?.queued).toBe(false);
    expect(r2.outcome?.reason).toBe('inbox-has-newer');

    const finalInbox = await importer.listInbox(bucket.id);
    expect(finalInbox).toHaveLength(1);
    expect(finalInbox[0].manifestId).toBe('mfst-per-sender-new');
    expect(finalInbox[0].createdAt).toBe(newerTs);
  });

  it('adopts an imported universe subscription so the source bucket is selected for sharing', async () => {
    const { listSubscriptions, subscriptionFilename, __resetForTests } = await import('./subscriptions.js');
    __resetForTests();
    const bucket = await buckets.createBucket({ name: 'CollabBucket', path: tempBucket, mode: 'auto-merge' });
    const universeBuilder = await import('../universeBuilder.js');
    const u = await universeBuilder.createUniverse({ name: 'Shared Universe' });

    const exp = await exporter.exportUniverse(u.id, bucket.id, {
      subscription: { recordKind: 'universe', recordId: u.id },
    });
    expect(exp.filename).toBe(subscriptionFilename({
      recordKind: 'universe', recordId: u.id, senderInstanceId: 'test-instance-id',
    }));

    await universeBuilder.deleteUniverse(u.id);
    expect(await listSubscriptions({ recordKind: 'universe', recordId: u.id })).toEqual([]);

    simulateRemoteSender(tempBucket, exp.filename);
    const result = await importer.processManifest(bucket.id, exp.filename);
    expect(result.processed).toBe(true);
    expect(result.outcome.adoptedSubscription).toMatchObject({
      bucketId: bucket.id,
      recordKind: 'universe',
      recordId: u.id,
    });

    const restored = await universeBuilder.getUniverse(u.id);
    expect(restored.id).toBe(u.id);
    const subs = await listSubscriptions({ recordKind: 'universe', recordId: u.id });
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      bucketId: bucket.id,
      recordKind: 'universe',
      recordId: u.id,
      adoptedFromImport: true,
      lastManifestId: exp.manifestId,
    });
    expect(subs[0].lastExportedAt).toBe(null);
  });

  it('skips self-authored manifests on import and prunes pre-existing self-authored inbox items', async () => {
    const { sharingEvents } = await import('./importer.js');
    const bucket = await buckets.createBucket({ name: 'SelfBucket', path: tempBucket, mode: 'inbox' });

    // Author + export a series locally — the manifest is dropped into our own bucket.
    const s = await series.createSeries({ name: 'Mine', logline: 'Local-only' });
    const exp = await exporter.exportSeries(s.id, bucket.id);
    expect(exp.manifestId).toBeTruthy();

    // The watcher would now pick the manifest up. Process it manually and
    // verify it never enters the inbox — `senderInstanceId === localInstanceId`.
    const res = await importer.processManifest(bucket.id, exp.filename);
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe('self-authored');
    expect(await importer.listInbox(bucket.id)).toEqual([]);

    // Second pass is the cursor's already-processed branch.
    const replay = await importer.processManifest(bucket.id, exp.filename);
    expect(replay.skipped).toBe(true);
    expect(replay.reason).toBe('already-processed');

    // Pre-fix bug: simulate a stale inbox entry from before the filter existed
    // (no senderInstanceId field). processBacklog should backfill from the
    // manifest file on disk and prune it.
    const fs = await import('fs');
    const inboxFile = join(tempData, 'sharing', 'inbox', `${bucket.id}.json`);
    mkdirSync(join(tempData, 'sharing', 'inbox'), { recursive: true });
    fs.writeFileSync(inboxFile, JSON.stringify({ items: [{
      manifestId: exp.manifestId,
      manifestFilename: exp.filename,
      kind: 'series',
      subscription: null,
      source: 'antic',
      sourceBio: null,
      createdAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      recordIds: [s.id],
      assetCount: 0,
    }] }));

    const updates = [];
    const onUpdate = (p) => updates.push(p);
    sharingEvents.on('inbox-updated', onUpdate);
    await importer.processBacklog(bucket.id);
    sharingEvents.off('inbox-updated', onUpdate);

    expect(await importer.listInbox(bucket.id)).toEqual([]);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ bucketId: bucket.id });
  });

  it('processBacklog prunes orphaned inbox items whose manifest file is no longer in the bucket', async () => {
    const { sharingEvents } = await import('./importer.js');
    const bucket = await buckets.createBucket({ name: 'OrphanBucket', path: tempBucket, mode: 'inbox' });

    const fs = await import('fs');
    const inboxFile = join(tempData, 'sharing', 'inbox', `${bucket.id}.json`);
    mkdirSync(join(tempData, 'sharing', 'inbox'), { recursive: true });
    fs.writeFileSync(inboxFile, JSON.stringify({ items: [{
      manifestId: 'orphan-mid',
      manifestFilename: 'this-file-was-deleted-from-the-bucket.json',
      kind: 'universe',
      subscription: null,
      source: 'remote-peer',
      sourceBio: null,
      senderInstanceId: 'some-other-peer',
      createdAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      recordIds: ['u-orphan'],
      assetCount: 0,
    }] }));

    const updates = [];
    const onUpdate = (p) => updates.push(p);
    sharingEvents.on('inbox-updated', onUpdate);
    await importer.processBacklog(bucket.id);
    sharingEvents.off('inbox-updated', onUpdate);

    expect(await importer.listInbox(bucket.id)).toEqual([]);
    expect(updates).toHaveLength(1);
  });

  // Rotation-orphan cull — peer reincarnates with a new senderInstanceId
  // (factory reset, new device), and the old identity's inbox row would
  // otherwise persist forever. Cull when same source + same record, but
  // different senderInstanceId, AND the existing row is older than 30 days.
  it('culls a rotation-orphan inbox row when the same source re-shares from a new senderInstanceId after 30+ days', async () => {
    const bucket = await buckets.createBucket({ name: 'RotateBucket', path: tempBucket, mode: 'inbox' });
    const universeBuilder = await import('../universeBuilder.js');
    const u = await universeBuilder.createUniverse({ name: 'Shared Universe' });

    // Pre-seed the inbox with a stale row from peer "Adam's old laptop"
    // (senderInstanceId inst-OLD) — same source as the incoming manifest,
    // same record, 60 days old.
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const fs = await import('fs');
    const inboxFile = join(tempData, 'sharing', 'inbox', `${bucket.id}.json`);
    mkdirSync(join(tempData, 'sharing', 'inbox'), { recursive: true });
    fs.writeFileSync(inboxFile, JSON.stringify({ items: [{
      manifestId: 'stale-mfst',
      manifestFilename: `sub-universe-${u.id}-inst-OLD.json`,
      kind: 'universe',
      subscription: { recordKind: 'universe', recordId: u.id },
      source: 'remote-peer',
      sourceBio: null,
      senderInstanceId: 'inst-OLD',
      createdAt: sixtyDaysAgo,
      receivedAt: sixtyDaysAgo,
      recordIds: [u.id],
      assetCount: 0,
    }] }));

    // Now export from the SAME source name but a fresh senderInstanceId.
    const exp = await exporter.exportUniverse(u.id, bucket.id, {
      subscription: { recordKind: 'universe', recordId: u.id },
    });
    simulateRemoteSender(tempBucket, exp.filename, 'inst-NEW');
    // The exporter stamps `source` from the bucket's display name resolver;
    // override on disk to match the pre-seeded row's source so the cull fires.
    const manifestPath = join(tempBucket, 'manifests', exp.filename);
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    m.source = 'remote-peer';
    fs.writeFileSync(manifestPath, JSON.stringify(m));

    await importer.processManifest(bucket.id, exp.filename);

    const after = await importer.listInbox(bucket.id);
    expect(after).toHaveLength(1);
    expect(after[0].senderInstanceId).toBe('inst-NEW');
    expect(after[0].manifestId).not.toBe('stale-mfst');
  });

  it('preserves a same-source-different-sender row that is younger than the rotation cull window', async () => {
    const bucket = await buckets.createBucket({ name: 'FreshSourceBucket', path: tempBucket, mode: 'inbox' });
    const universeBuilder = await import('../universeBuilder.js');
    const u = await universeBuilder.createUniverse({ name: 'Co-shared Universe' });

    // Same source name, different senderInstanceId, only 2 days old —
    // could plausibly be a second device of the same user (both named
    // "MacBook") rather than a rotation orphan. Preserve it.
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const fs = await import('fs');
    const inboxFile = join(tempData, 'sharing', 'inbox', `${bucket.id}.json`);
    mkdirSync(join(tempData, 'sharing', 'inbox'), { recursive: true });
    fs.writeFileSync(inboxFile, JSON.stringify({ items: [{
      manifestId: 'fresh-other',
      manifestFilename: `sub-universe-${u.id}-inst-OTHER.json`,
      kind: 'universe',
      subscription: { recordKind: 'universe', recordId: u.id },
      source: 'shared-name',
      sourceBio: null,
      senderInstanceId: 'inst-OTHER',
      createdAt: twoDaysAgo,
      receivedAt: twoDaysAgo,
      recordIds: [u.id],
      assetCount: 0,
    }] }));

    const exp = await exporter.exportUniverse(u.id, bucket.id, {
      subscription: { recordKind: 'universe', recordId: u.id },
    });
    simulateRemoteSender(tempBucket, exp.filename, 'inst-ME');
    const manifestPath = join(tempBucket, 'manifests', exp.filename);
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    m.source = 'shared-name';
    fs.writeFileSync(manifestPath, JSON.stringify(m));

    await importer.processManifest(bucket.id, exp.filename);

    const after = await importer.listInbox(bucket.id);
    // Both rows should remain — fresh peer + new arrival.
    expect(after).toHaveLength(2);
    const senders = after.map((r) => r.senderInstanceId).sort();
    expect(senders).toEqual(['inst-ME', 'inst-OTHER']);
  });

  it('persists a rotation-orphan cull even when the freshness gate forces an early inbox-has-newer return', async () => {
    // Regression: the cull mutates inbox.items before the freshness gate
    // runs. If an older manifest from the same sender arrives after the
    // newer one is already in the inbox, the freshness gate short-circuits
    // with `inbox-has-newer` — the cull removals on the OTHER (rotated)
    // sender's row must still be persisted, otherwise the orphan survives
    // until the next non-stale arrival.
    const bucket = await buckets.createBucket({ name: 'RotateAndStaleBucket', path: tempBucket, mode: 'inbox' });
    const universeBuilder = await import('../universeBuilder.js');
    const u = await universeBuilder.createUniverse({ name: 'Multi-state Universe' });

    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const fs = await import('fs');
    const inboxFile = join(tempData, 'sharing', 'inbox', `${bucket.id}.json`);
    mkdirSync(join(tempData, 'sharing', 'inbox'), { recursive: true });
    fs.writeFileSync(inboxFile, JSON.stringify({ items: [
      // Rotation orphan — different sender, same source, 60 days old.
      // Must be culled by the incoming manifest.
      {
        manifestId: 'rotation-orphan',
        manifestFilename: `sub-universe-${u.id}-inst-OLD.json`,
        kind: 'universe',
        subscription: { recordKind: 'universe', recordId: u.id },
        source: 'remote-peer',
        sourceBio: null,
        senderInstanceId: 'inst-OLD',
        createdAt: sixtyDaysAgo,
        receivedAt: sixtyDaysAgo,
        recordIds: [u.id],
        assetCount: 0,
      },
      // Same-sender row newer than the incoming manifest below — triggers
      // the freshness gate's `inbox-has-newer` early return.
      {
        manifestId: 'fresh-newer',
        manifestFilename: `sub-universe-${u.id}-inst-NEW.json`,
        kind: 'universe',
        subscription: { recordKind: 'universe', recordId: u.id },
        source: 'remote-peer',
        sourceBio: null,
        senderInstanceId: 'inst-NEW',
        createdAt: yesterday,
        receivedAt: yesterday,
        recordIds: [u.id],
        assetCount: 0,
      },
    ] }));

    // Synthesize an OLDER manifest from the same fresh sender so the
    // freshness gate fires (existing.createdAt > manifest.createdAt).
    const exp = await exporter.exportUniverse(u.id, bucket.id, {
      subscription: { recordKind: 'universe', recordId: u.id },
    });
    simulateRemoteSender(tempBucket, exp.filename, 'inst-NEW');
    const manifestPath = join(tempBucket, 'manifests', exp.filename);
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    m.source = 'remote-peer';
    // Older than the pre-seeded `fresh-newer` row.
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    m.createdAt = twoDaysAgo;
    fs.writeFileSync(manifestPath, JSON.stringify(m));

    const outcome = await importer.processManifest(bucket.id, exp.filename);
    expect(outcome.outcome?.queued).toBe(false);
    expect(outcome.outcome?.reason).toBe('inbox-has-newer');

    // Despite the early return, the cull must have persisted: only the
    // newer same-sender row remains.
    const after = await importer.listInbox(bucket.id);
    expect(after).toHaveLength(1);
    expect(after[0].manifestId).toBe('fresh-newer');
    expect(after[0].senderInstanceId).toBe('inst-NEW');
  });

  it('preserves a different-source row even when older than the rotation cull window', async () => {
    const bucket = await buckets.createBucket({ name: 'OtherSourceBucket', path: tempBucket, mode: 'inbox' });
    const universeBuilder = await import('../universeBuilder.js');
    const u = await universeBuilder.createUniverse({ name: 'Public Universe' });

    // Different source name, different senderInstanceId — definitely a
    // different peer, regardless of age. Preserve.
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const fs = await import('fs');
    const inboxFile = join(tempData, 'sharing', 'inbox', `${bucket.id}.json`);
    mkdirSync(join(tempData, 'sharing', 'inbox'), { recursive: true });
    fs.writeFileSync(inboxFile, JSON.stringify({ items: [{
      manifestId: 'different-peer',
      manifestFilename: `sub-universe-${u.id}-inst-PEER-B.json`,
      kind: 'universe',
      subscription: { recordKind: 'universe', recordId: u.id },
      source: 'peer-bob',
      sourceBio: null,
      senderInstanceId: 'inst-PEER-B',
      createdAt: sixtyDaysAgo,
      receivedAt: sixtyDaysAgo,
      recordIds: [u.id],
      assetCount: 0,
    }] }));

    const exp = await exporter.exportUniverse(u.id, bucket.id, {
      subscription: { recordKind: 'universe', recordId: u.id },
    });
    simulateRemoteSender(tempBucket, exp.filename, 'inst-PEER-A');
    const manifestPath = join(tempBucket, 'manifests', exp.filename);
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    m.source = 'peer-alice';
    fs.writeFileSync(manifestPath, JSON.stringify(m));

    await importer.processManifest(bucket.id, exp.filename);

    const after = await importer.listInbox(bucket.id);
    expect(after).toHaveLength(2);
    const sources = after.map((r) => r.source).sort();
    expect(sources).toEqual(['peer-alice', 'peer-bob']);
  });

  it('content-addressed blob is shared when two manifests reference identical bytes under different filenames', async () => {
    const bucket = await buckets.createBucket({ name: 'DedupBucket', path: tempBucket, mode: 'auto-merge' });
    const fs = await import('fs');
    const universeBuilder = await import('../universeBuilder.js');
    const mediaCollections = await import('../mediaCollections.js');

    // Two distinct filenames, identical bytes.
    const sharedBytes = 'SHARED-PNG-PAYLOAD';
    fs.writeFileSync(join(tempData, 'images', 'alpha.png'), sharedBytes);
    fs.writeFileSync(join(tempData, 'images', 'beta.png'), sharedBytes);
    const hash = sha256Hex(sharedBytes);

    // Universe A references alpha.png.
    const uniA = await universeBuilder.createUniverse({ name: 'UA' });
    const collA = await mediaCollections.findOrCreateCollectionByName({
      name: `Universe: ${uniA.name}`, description: '', universeId: uniA.id,
    });
    await mediaCollections.addItem(collA.id, { kind: 'image', ref: 'alpha.png' });
    const expA = await exporter.exportUniverse(uniA.id, bucket.id);

    // Universe B references beta.png — same bytes, different filename.
    const uniB = await universeBuilder.createUniverse({ name: 'UB' });
    const collB = await mediaCollections.findOrCreateCollectionByName({
      name: `Universe: ${uniB.name}`, description: '', universeId: uniB.id,
    });
    await mediaCollections.addItem(collB.id, { kind: 'image', ref: 'beta.png' });
    const expB = await exporter.exportUniverse(uniB.id, bucket.id);

    // Both manifests point at the same blob path; only one on-disk blob file exists
    // (the dotfile `.index.json` is the per-bucket source→hash cache, not a blob).
    expect(fs.existsSync(join(tempBucket, 'assets', 'blobs', hash))).toBe(true);
    // Filter out: dotfiles (.index.json source-hash cache) AND .metadata.json
    // sidecars (which mirror the source-side sidecars created by the new
    // cross-transport SHA-256 cache in lib/assetHash.js). The point of the
    // assertion is "only ONE actual blob exists for two manifests that share
    // bytes" — the sidecar is provenance metadata, not a duplicate blob.
    const blobs = fs.readdirSync(join(tempBucket, 'assets', 'blobs'))
      .filter((f) => !f.startsWith('.') && !f.endsWith('.metadata.json'));
    expect(blobs).toEqual([hash]);

    // Each manifest's assetRef carries the hash + its own original filename.
    const mA = JSON.parse(fs.readFileSync(join(tempBucket, 'manifests', expA.filename), 'utf-8'));
    const mB = JSON.parse(fs.readFileSync(join(tempBucket, 'manifests', expB.filename), 'utf-8'));
    expect(mA.assetRefs).toContainEqual({ kind: 'image', ref: 'alpha.png', hash });
    expect(mB.assetRefs).toContainEqual({ kind: 'image', ref: 'beta.png', hash });

    // Import path: each manifest restores its filename in the local data dir.
    fs.rmSync(join(tempData, 'images', 'alpha.png'), { force: true });
    fs.rmSync(join(tempData, 'images', 'beta.png'), { force: true });
    await mediaCollections.deleteCollection(collA.id);
    await mediaCollections.deleteCollection(collB.id);
    await universeBuilder.deleteUniverse(uniA.id);
    await universeBuilder.deleteUniverse(uniB.id);

    simulateRemoteSender(tempBucket, expA.filename);
    simulateRemoteSender(tempBucket, expB.filename);
    await importer.processManifest(bucket.id, expA.filename);
    await importer.processManifest(bucket.id, expB.filename);

    expect(fs.existsSync(join(tempData, 'images', 'alpha.png'))).toBe(true);
    expect(fs.existsSync(join(tempData, 'images', 'beta.png'))).toBe(true);
    expect(fs.readFileSync(join(tempData, 'images', 'alpha.png'), 'utf-8')).toBe(sharedBytes);
    expect(fs.readFileSync(join(tempData, 'images', 'beta.png'), 'utf-8')).toBe(sharedBytes);
  });

  it('importer rejects manifest asset refs whose hash is not a 64-char hex string (path-traversal guard)', async () => {
    const bucket = await buckets.createBucket({ name: 'HostileBucket', path: tempBucket, mode: 'auto-merge' });
    const fs = await import('fs');
    const { SHARING_SCHEMA_VERSION } = await import('./version.js');

    // Plant a file outside the blob dir that a path-traversal attempt would target.
    const secretsDir = mkdtempSync(join(tmpdir(), 'portos-sharing-hostile-secret-'));
    const secretPath = join(secretsDir, 'secret.txt');
    fs.writeFileSync(secretPath, 'SECRET-CONTENT-DO-NOT-LEAK');

    // Compute the traversal that would escape <bucket>/assets/blobs/ and
    // land on the planted secret. Use forward slashes — path.join normalizes.
    const rel = ['..', '..', '..', '..', '..', '..', '..', '..', '..'].join('/')
      + secretPath.replace(/\\/g, '/');

    const universeBuilder = await import('../universeBuilder.js');
    const u = await universeBuilder.createUniverse({ name: 'Hostile Universe' });
    fs.mkdirSync(join(tempBucket, 'records', 'universes'), { recursive: true });
    fs.writeFileSync(join(tempBucket, 'records', 'universes', `${u.id}.json`), JSON.stringify({
      ...u,
      origin: {
        bucketId: bucket.id, bucketName: bucket.name,
        source: 'hostile-peer', sourceBio: null,
        manifestId: 'mfst-hostile', importedAt: new Date().toISOString(),
      },
    }));
    await universeBuilder.deleteUniverse(u.id);

    // Hostile manifest: hash is a relative path traversing out of the blob dir.
    const hostileManifest = {
      id: 'mfst-hostile',
      schemaVersion: SHARING_SCHEMA_VERSION,
      sharingSchemaVersion: SHARING_SCHEMA_VERSION,
      producedByVersion: '9.9.9',
      createdAt: new Date().toISOString(),
      kind: 'universe',
      senderInstanceId: 'hostile-peer',
      source: 'Hostile Peer',
      sourceBio: null,
      bucketId: bucket.id,
      bucketName: bucket.name,
      recordIds: [u.id],
      assetRefs: [{ kind: 'image', ref: 'pwned.png', hash: rel }],
      note: null,
    };
    const filename = `2099-01-01T00-00-00-000Z-hostile-peer-${hostileManifest.id}.json`;
    fs.mkdirSync(join(tempBucket, 'manifests'), { recursive: true });
    fs.writeFileSync(join(tempBucket, 'manifests', filename), JSON.stringify(hostileManifest));

    const result = await importer.processManifest(bucket.id, filename);
    // The universe record imports fine; the asset ref is dropped at the
    // manifest-parse boundary so no file copy is attempted.
    expect(result.processed).toBe(true);
    // The hostile file MUST NOT have been copied into the local data dirs.
    expect(fs.existsSync(join(tempData, 'images', 'pwned.png'))).toBe(false);
    expect(fs.existsSync(join(tempData, 'images', 'secret.txt'))).toBe(false);

    // The secret on disk should be untouched.
    expect(fs.readFileSync(secretPath, 'utf-8')).toBe('SECRET-CONTENT-DO-NOT-LEAK');

    rmSync(secretsDir, { recursive: true, force: true });
  });

  it('bucketBlobPath / bucketBlobSidecarPath throw on malformed hash (defense-in-depth)', async () => {
    const bogus = [
      '../../../../etc/hosts',
      'ABCDEF', // uppercase — must be lowercase
      'g'.repeat(64), // not hex
      '0'.repeat(63), // wrong length
      '0'.repeat(65),
      '',
      null,
      undefined,
      42,
    ];
    for (const h of bogus) {
      expect(() => buckets.bucketBlobPath(tempBucket, h)).toThrow();
      expect(() => buckets.bucketBlobSidecarPath(tempBucket, h)).toThrow();
    }
    // Valid hash passes.
    const ok = sha256Hex('whatever');
    expect(buckets.bucketBlobPath(tempBucket, ok)).toBe(join(tempBucket, 'assets', 'blobs', ok));
    expect(buckets.bucketBlobSidecarPath(tempBucket, ok)).toBe(join(tempBucket, 'assets', 'blobs', `${ok}.metadata.json`));
  });

  it('importer falls back to legacy assets/<kind>/<filename> when manifest asset ref omits hash (v1 compat)', async () => {
    const bucket = await buckets.createBucket({ name: 'LegacyImportBucket', path: tempBucket, mode: 'auto-merge' });
    const fs = await import('fs');
    const { SHARING_SCHEMA_VERSION } = await import('./version.js');

    // Hand-craft a v1-style bucket: blob lives at assets/images/<filename>,
    // manifest's assetRefs has no `hash` field, schemaVersion: 1.
    fs.mkdirSync(join(tempBucket, 'assets', 'images'), { recursive: true });
    fs.writeFileSync(join(tempBucket, 'assets', 'images', 'legacy-v1.png'), 'V1BYTES');

    const universeBuilder = await import('../universeBuilder.js');
    const u = await universeBuilder.createUniverse({ name: 'Legacy v1 Universe' });
    fs.writeFileSync(join(tempBucket, 'records', 'universes', `${u.id}.json`), JSON.stringify({
      ...u,
      origin: {
        bucketId: bucket.id, bucketName: bucket.name,
        source: 'old-peer', sourceBio: null,
        manifestId: 'mfst-v1', importedAt: new Date().toISOString(),
      },
    }));
    await universeBuilder.deleteUniverse(u.id);

    const v1Manifest = {
      id: 'mfst-v1',
      schemaVersion: 1,
      sharingSchemaVersion: 1,
      producedByVersion: '1.0.0',
      createdAt: new Date().toISOString(),
      kind: 'universe',
      senderInstanceId: 'old-peer',
      source: 'Old Peer',
      sourceBio: null,
      bucketId: bucket.id,
      bucketName: bucket.name,
      recordIds: [u.id],
      assetRefs: [{ kind: 'image', ref: 'legacy-v1.png' }],   // no hash
      note: null,
    };
    const filename = `2000-01-01T00-00-00-000Z-old-peer-${v1Manifest.id}.json`;
    fs.writeFileSync(join(tempBucket, 'manifests', filename), JSON.stringify(v1Manifest));
    expect(SHARING_SCHEMA_VERSION).toBeGreaterThanOrEqual(2); // sanity

    const result = await importer.processManifest(bucket.id, filename);
    expect(result.processed).toBe(true);
    expect(result.pending).toBeFalsy();

    // Asset blob made it to the local data dir via the legacy path.
    expect(fs.existsSync(join(tempData, 'images', 'legacy-v1.png'))).toBe(true);
    expect(fs.readFileSync(join(tempData, 'images', 'legacy-v1.png'), 'utf-8')).toBe('V1BYTES');
  });

  it('migrates legacy series canon arrays into the linked universe on import (pre-B.4 peer)', async () => {
    const bucket = await buckets.createBucket({ name: 'LegacyCanonBucket', path: tempBucket, mode: 'auto-merge' });
    const fs = await import('fs');

    // Local target universe — the migration writes incoming canon here.
    const uni = await universeSvc.createUniverse({ name: 'Pre-B.4 Universe' });
    expect((uni.characters || []).length).toBe(0);
    expect((uni.places || []).length).toBe(0);
    expect((uni.objects || []).length).toBe(0);

    // Hand-write a pre-B.4 series record carrying the legacy canon arrays.
    // `sanitizeSeries` would normally strip these on insert; the importer's
    // pre-pass must fold them into the universe first.
    const seriesId = 'ser-pre-b4-test';
    const legacySeries = {
      id: seriesId,
      name: 'Pre-B.4 Series',
      logline: 'Test',
      premise: 'Test premise',
      universeId: uni.id,
      characters: [{ name: 'Echo', physicalDescription: 'tall' }],
      // Pre-022 wire name — the helper coalesces this onto `places`.
      settings: [{ name: 'The Foundry', slugline: 'INT. FOUNDRY - NIGHT' }],
      objects: [{ name: 'Brass Key', description: 'opens the gate' }],
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
    };
    mkdirSync(join(tempBucket, 'records', 'series'), { recursive: true });
    writeFileSync(
      join(tempBucket, 'records', 'series', `${seriesId}.json`),
      JSON.stringify(legacySeries),
    );

    const manifest = {
      id: 'mfst-pre-b4',
      schemaVersion: 1,
      sharingSchemaVersion: 1,
      producedByVersion: '1.0.0',
      createdAt: new Date().toISOString(),
      kind: 'series',
      senderInstanceId: 'pre-b4-peer',
      source: 'Pre B.4 Peer',
      sourceBio: null,
      bucketId: bucket.id,
      bucketName: bucket.name,
      recordIds: [seriesId],
      assetRefs: [],
      note: null,
    };
    const filename = `2026-05-01T00-00-00-000Z-pre-b4-peer-${manifest.id}.json`;
    writeFileSync(join(tempBucket, 'manifests', filename), JSON.stringify(manifest));

    const result = await importer.processManifest(bucket.id, filename);
    expect(result.processed).toBe(true);
    expect(result.outcome.applied).toBeGreaterThan(0);

    // Series imported under the preserved id, with legacy canon stripped.
    const restored = await series.getSeries(seriesId);
    expect(restored.id).toBe(seriesId);
    expect(restored.universeId).toBe(uni.id);
    expect(restored.characters).toBeUndefined();
    expect(restored.settings).toBeUndefined();
    expect(restored.places).toBeUndefined();
    expect(restored.objects).toBeUndefined();

    // Universe gained the canon entries with SERIES_EXTRACT provenance.
    const merged = await universeSvc.getUniverse(uni.id);
    expect(merged.characters.map((c) => c.name)).toContain('Echo');
    expect(merged.places.map((p) => p.name)).toContain('The Foundry');
    expect(merged.objects.map((o) => o.name)).toContain('Brass Key');
    // Provenance: live extract path tags series-driven canon as locked + sourceSeriesId.
    const echo = merged.characters.find((c) => c.name === 'Echo');
    expect(echo.locked).toBe(true);
    expect(echo.sourceSeriesId).toBe(seriesId);
    expect(echo.source).toBe('series-extract');
  });

  it('creates an orphan universe and links the series when a pre-B.4 record has no universeId', async () => {
    const bucket = await buckets.createBucket({ name: 'OrphanCanonBucket', path: tempBucket, mode: 'auto-merge' });

    const seriesId = 'ser-orphan-test';
    const legacySeries = {
      id: seriesId,
      name: 'Orphan Series',
      logline: 'unlinked',
      premise: 'unlinked premise',
      // No universeId — pre-B universes-don't-exist era.
      characters: [{ name: 'Solo', physicalDescription: 'lone' }],
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
    };
    mkdirSync(join(tempBucket, 'records', 'series'), { recursive: true });
    writeFileSync(
      join(tempBucket, 'records', 'series', `${seriesId}.json`),
      JSON.stringify(legacySeries),
    );
    const manifest = {
      id: 'mfst-orphan',
      schemaVersion: 1,
      sharingSchemaVersion: 1,
      producedByVersion: '1.0.0',
      createdAt: new Date().toISOString(),
      kind: 'series',
      senderInstanceId: 'orphan-peer',
      source: 'Orphan Peer',
      sourceBio: null,
      bucketId: bucket.id,
      bucketName: bucket.name,
      recordIds: [seriesId],
      assetRefs: [],
      note: null,
    };
    const filename = `2026-05-01T00-00-00-000Z-orphan-peer-${manifest.id}.json`;
    writeFileSync(join(tempBucket, 'manifests', filename), JSON.stringify(manifest));

    const result = await importer.processManifest(bucket.id, filename);
    expect(result.processed).toBe(true);

    const restored = await series.getSeries(seriesId);
    expect(restored.universeId).toBeTruthy(); // freshly minted
    const orphanUni = await universeSvc.getUniverse(restored.universeId);
    expect(orphanUni.name).toMatch(/Orphan Series/);
    expect(orphanUni.characters.map((c) => c.name)).toContain('Solo');
  });

  it('reuses an existing local series.universeId on retry — no duplicate auto-migrated universes', async () => {
    // When the same orphan-series manifest is processed twice (e.g. an
    // unrelated pending condition held the cursor back the first time),
    // the legacy-canon helper must reuse the persisted local universeId
    // instead of minting a fresh "<name> (auto-migrated)" universe each pass.
    const bucket = await buckets.createBucket({ name: 'OrphanIdempBucket', path: tempBucket, mode: 'auto-merge' });

    const seriesId = 'ser-orphan-idemp';
    const legacySeries = {
      id: seriesId,
      name: 'Orphan Idemp Series',
      logline: 'will be reimported',
      premise: 'idempotency test',
      characters: [{ name: 'Echo', physicalDescription: 'on retry' }],
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
    };
    mkdirSync(join(tempBucket, 'records', 'series'), { recursive: true });
    writeFileSync(
      join(tempBucket, 'records', 'series', `${seriesId}.json`),
      JSON.stringify(legacySeries),
    );
    const manifest = {
      id: 'mfst-orphan-idemp',
      schemaVersion: 1,
      sharingSchemaVersion: 1,
      producedByVersion: '1.0.0',
      createdAt: new Date().toISOString(),
      kind: 'series',
      senderInstanceId: 'orphan-idemp-peer',
      source: 'Orphan Idemp Peer',
      sourceBio: null,
      bucketId: bucket.id,
      bucketName: bucket.name,
      recordIds: [seriesId],
      assetRefs: [],
      note: null,
    };
    const filename = `2026-05-01T00-00-00-000Z-orphan-idemp-peer-${manifest.id}.json`;
    writeFileSync(join(tempBucket, 'manifests', filename), JSON.stringify(manifest));

    // First pass — creates the orphan universe + inserts the series.
    await importer.processManifest(bucket.id, filename);
    const restoredFirst = await series.getSeries(seriesId);
    const firstUniverseId = restoredFirst.universeId;
    expect(firstUniverseId).toBeTruthy();

    // Force a retry — simulate the cursor being un-advanced by forgetting the
    // manifest, then re-process. Without idempotency the helper would mint a
    // SECOND auto-migrated universe and `mergeOne` would no-op the series.
    const { forgetProcessed } = await import('./manifest.js');
    await forgetProcessed(bucket.id, filename);
    await importer.processManifest(bucket.id, filename);

    const restoredAfter = await series.getSeries(seriesId);
    expect(restoredAfter.universeId).toBe(firstUniverseId);
    const allUnis = await universeSvc.listUniverses();
    const autoMigrated = allUnis.filter((u) => /Orphan Idemp Series/.test(u.name));
    expect(autoMigrated).toHaveLength(1);
  });

  it('promoteInboxItem keeps the inbox row when legacy canon needs a missing universe', async () => {
    // Without the gate in promoteInboxItem the user's "promote" click would
    // splice the inbox row even though the series merge skipped — same
    // silent-data-loss shape as the auto-merge path before this PR.
    const bucket = await buckets.createBucket({ name: 'InboxLegacyBucket', path: tempBucket, mode: 'inbox' });

    const missingUniverseId = 'uni-inbox-not-bundled';
    const seriesId = 'ser-inbox-legacy';
    const legacySeries = {
      id: seriesId,
      name: 'Inbox Legacy Series',
      logline: 'inbox-pending test',
      premise: 'links to a universe not in the bundle',
      universeId: missingUniverseId,
      characters: [{ name: 'Phantom', physicalDescription: 'inbox-pending' }],
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
    };
    mkdirSync(join(tempBucket, 'records', 'series'), { recursive: true });
    writeFileSync(
      join(tempBucket, 'records', 'series', `${seriesId}.json`),
      JSON.stringify(legacySeries),
    );
    const manifest = {
      id: 'mfst-inbox-legacy',
      schemaVersion: 1,
      sharingSchemaVersion: 1,
      producedByVersion: '1.0.0',
      createdAt: new Date().toISOString(),
      kind: 'series',
      senderInstanceId: 'inbox-legacy-peer',
      source: 'Inbox Legacy Peer',
      sourceBio: null,
      bucketId: bucket.id,
      bucketName: bucket.name,
      recordIds: [seriesId],
      assetRefs: [],
      note: null,
    };
    const filename = `2026-05-01T00-00-00-000Z-inbox-legacy-peer-${manifest.id}.json`;
    writeFileSync(join(tempBucket, 'manifests', filename), JSON.stringify(manifest));

    // First: queue as an inbox item (the bucket is inbox mode).
    const r1 = await importer.processManifest(bucket.id, filename);
    expect(r1.outcome.mode).toBe('inbox');
    expect((await importer.listInbox(bucket.id))).toHaveLength(1);

    // Promote — should throw because the linked universe is missing, AND the
    // inbox row must NOT be removed.
    let promoteErr = null;
    await importer.promoteInboxItem(bucket.id, manifest.id).catch((err) => { promoteErr = err; });
    expect(promoteErr).toBeTruthy();
    expect(promoteErr.code).toBe('SHARING_LEGACY_CANON_UNIVERSE_PENDING');
    expect(promoteErr.pendingLegacyCanonUniverses).toEqual([missingUniverseId]);
    expect((await importer.listInbox(bucket.id))).toHaveLength(1);
    const stillMissing = await series.getSeries(seriesId).catch(() => null);
    expect(stillMissing).toBeNull();
  });

  it('leaves the manifest pending and retries when the missing universe later arrives', async () => {
    // Without this guard, the importer would fall through to insertSeriesWithId
    // and `sanitizeSeries` would silently drop the legacy canon arrays — the
    // exact bug this PR fixes. The bucket record stays untouched and the
    // cursor stays un-advanced so the watcher retries when the missing
    // universe later shows up.
    const { hasBeenProcessed, readCursor } = await import('./manifest.js');
    const bucket = await buckets.createBucket({ name: 'MissingUniBucket', path: tempBucket, mode: 'auto-merge' });

    const missingUniverseId = 'uni-not-yet-bundled-123';
    const seriesId = 'ser-missing-uni';
    const legacySeries = {
      id: seriesId,
      name: 'Missing-Uni Series',
      logline: 'orphaned link',
      premise: 'links to a universe not in the bundle',
      universeId: missingUniverseId,
      characters: [{ name: 'Ghost', physicalDescription: 'unseen' }],
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
    };
    mkdirSync(join(tempBucket, 'records', 'series'), { recursive: true });
    writeFileSync(
      join(tempBucket, 'records', 'series', `${seriesId}.json`),
      JSON.stringify(legacySeries),
    );
    const manifest = {
      id: 'mfst-missing-uni',
      schemaVersion: 1,
      sharingSchemaVersion: 1,
      producedByVersion: '1.0.0',
      createdAt: new Date().toISOString(),
      kind: 'series',
      senderInstanceId: 'missing-uni-peer',
      source: 'Missing Uni Peer',
      sourceBio: null,
      bucketId: bucket.id,
      bucketName: bucket.name,
      recordIds: [seriesId],
      assetRefs: [],
      note: null,
    };
    const filename = `2026-05-01T00-00-00-000Z-missing-uni-peer-${manifest.id}.json`;
    writeFileSync(join(tempBucket, 'manifests', filename), JSON.stringify(manifest));

    // First pass: universe is missing → manifest must stay pending, cursor not advanced, series not written.
    const first = await importer.processManifest(bucket.id, filename);
    expect(first.processed).toBe(true);
    expect(first.pending).toBe(true);
    expect(first.outcome.pendingLegacyCanonUniverses).toEqual([missingUniverseId]);
    let cursor = await readCursor(bucket.id);
    expect(hasBeenProcessed(cursor, filename, manifest.id)).toBe(false);
    const stillMissing = await series.getSeries(seriesId).catch(() => null);
    expect(stillMissing).toBeNull();

    // Local universe lands (peer re-shares it via a different channel, or
    // the user creates one with the matching id).
    await universeSvc.insertUniverseWithId({
      id: missingUniverseId,
      name: 'Late-Arriving Universe',
      starterPrompt: '',
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
    });

    // Retry: now the migration lands canon on the universe, the series imports.
    const second = await importer.processManifest(bucket.id, filename);
    expect(second.processed).toBe(true);
    expect(second.pending).toBeFalsy();
    cursor = await readCursor(bucket.id);
    expect(hasBeenProcessed(cursor, filename, manifest.id)).toBe(true);
    const restored = await series.getSeries(seriesId);
    expect(restored.id).toBe(seriesId);
    expect(restored.universeId).toBe(missingUniverseId);
    const restoredUni = await universeSvc.getUniverse(missingUniverseId);
    expect(restoredUni.characters.map((c) => c.name)).toContain('Ghost');
  });

  it('tombstoned collection universe: manifest advances cursor with collectionTombstonedUniverse (not pending forever)', async () => {
    // Regression: before the fix, getUniverse(id) on a tombstoned record threw
    // ERR_NOT_FOUND (same as absent), which resolved to null via .catch(()=>null),
    // returning { missingUniverse: true }. The manifest stayed pending indefinitely
    // because the universe IS on disk — just soft-deleted. The fix uses
    // includeDeleted:true to distinguish tombstoned from truly absent, and
    // advances the cursor immediately with a clear collectionTombstonedUniverse signal.
    const { hasBeenProcessed, readCursor } = await import('./manifest.js');
    const bucket = await buckets.createBucket({ name: 'TombstonedUniBucket', path: tempBucket, mode: 'auto-merge' });

    // Create a universe, then delete it — leaves a tombstone on disk.
    const uni = await universeSvc.createUniverse({ name: 'Deleted Universe' });
    await universeSvc.deleteUniverse(uni.id);
    // Confirm it's tombstoned (not truly absent).
    const tombstoned = await universeSvc.getUniverse(uni.id, { includeDeleted: true });
    expect(tombstoned.deleted).toBe(true);

    // Hand-write a collection-only manifest that references the tombstoned universe.
    mkdirSync(join(tempBucket, 'manifests'), { recursive: true });
    const collectionManifest = {
      id: 'mfst-tombstoned-uni-collection',
      schemaVersion: 1,
      sharingSchemaVersion: 1,
      producedByVersion: '1.0.0',
      createdAt: new Date().toISOString(),
      kind: 'universe',
      senderInstanceId: 'tombstone-peer',
      source: 'Tombstone Peer',
      sourceBio: null,
      bucketId: bucket.id,
      bucketName: bucket.name,
      recordIds: [],
      assetRefs: [],
      collection: {
        universeId: uni.id,
        name: `Universe: Deleted Universe`,
        description: '',
        items: [
          { kind: 'image', ref: 'fakeasset.png' },
          { kind: 'image', ref: 'other.png' },
        ],
      },
      note: null,
    };
    const filename = `2026-05-01T00-00-00-000Z-tombstone-peer-${collectionManifest.id}.json`;
    writeFileSync(join(tempBucket, 'manifests', filename), JSON.stringify(collectionManifest));

    const result = await importer.processManifest(bucket.id, filename);

    // Must be processed (cursor advanced), NOT stuck pending.
    expect(result.processed).toBe(true);
    expect(result.pending).toBeFalsy();
    // Outcome carries the distinct tombstoned sentinel, not missingUniverse.
    expect(result.outcome.collectionTombstonedUniverse).toBe(uni.id);
    // Cursor was advanced — a replay is a no-op (not re-attempted endlessly).
    const cursor = await readCursor(bucket.id);
    expect(hasBeenProcessed(cursor, filename, collectionManifest.id)).toBe(true);
  });

  it('tombstoned collection universe via series link: manifest advances cursor (not pending)', async () => {
    // Same fix applied to the series→universe re-route path: when a local series
    // links to a tombstoned universe, the importer must NOT return missingSeries
    // (which would loop pending forever). It returns tombstonedUniverse and the
    // manifest cursor advances.
    const { hasBeenProcessed, readCursor } = await import('./manifest.js');
    const bucket = await buckets.createBucket({ name: 'TombstonedUniViaSeriesBucket', path: tempBucket, mode: 'auto-merge' });

    // Create universe + linked series, then tombstone the universe. Local
    // deleteUniverse is blocked while a live series references it (the
    // hierarchy invariant), but this orphan-link-to-tombstone state still
    // arises in production: a PEER deletes the universe (it had no series
    // there) and the delete-tombstone arrives via sync while we hold an
    // independently-created linked series. Reproduce that via the merge path.
    const uni = await universeSvc.createUniverse({ name: 'Gone Universe' });
    const s = await series.createSeries({ name: 'Linked Series', logline: 'x', universeId: uni.id });
    await universeSvc.mergeUniversesFromSync([
      { ...uni, deleted: true, deletedAt: new Date().toISOString(), updatedAt: new Date(Date.now() + 60_000).toISOString() },
    ]);

    // Hand-write a collection manifest referencing the series id (the exporter
    // normally resolves series→universe, but a legacy peer may emit seriesId).
    mkdirSync(join(tempBucket, 'manifests'), { recursive: true });
    const collectionManifest = {
      id: 'mfst-tombstoned-uni-via-series',
      schemaVersion: 1,
      sharingSchemaVersion: 1,
      producedByVersion: '1.0.0',
      createdAt: new Date().toISOString(),
      kind: 'series',
      senderInstanceId: 'tombstone-via-series-peer',
      source: 'Tombstone Via Series Peer',
      sourceBio: null,
      bucketId: bucket.id,
      bucketName: bucket.name,
      recordIds: [],
      assetRefs: [],
      collection: {
        seriesId: s.id,
        name: `Series: Linked Series`,
        description: '',
        items: [{ kind: 'image', ref: 'fakeasset.png' }],
      },
      note: null,
    };
    const filename = `2026-05-01T00-00-00-000Z-tombstone-via-series-peer-${collectionManifest.id}.json`;
    writeFileSync(join(tempBucket, 'manifests', filename), JSON.stringify(collectionManifest));

    const result = await importer.processManifest(bucket.id, filename);

    // Cursor must advance — no infinite pending loop.
    expect(result.processed).toBe(true);
    expect(result.pending).toBeFalsy();
    expect(result.outcome.collectionTombstonedUniverse).toBe(uni.id);
    const cursor = await readCursor(bucket.id);
    expect(hasBeenProcessed(cursor, filename, collectionManifest.id)).toBe(true);
  });

  it('promoteInboxItem throws SHARING_UNIVERSE_TOMBSTONED when collection universe is deleted locally', async () => {
    const bucket = await buckets.createBucket({ name: 'TombstonedUniInboxBucket', path: tempBucket, mode: 'inbox' });

    // Create universe, export a collection manifest, then delete the universe.
    const uni = await universeSvc.createUniverse({ name: 'Soon Deleted Universe' });
    mkdirSync(join(tempBucket, 'manifests'), { recursive: true });
    mkdirSync(join(tempBucket, 'records'), { recursive: true });
    const collectionManifest = {
      id: 'mfst-tombstone-promote',
      schemaVersion: 1,
      sharingSchemaVersion: 1,
      producedByVersion: '1.0.0',
      createdAt: new Date().toISOString(),
      kind: 'universe',
      senderInstanceId: 'tombstone-inbox-peer',
      source: 'Tombstone Inbox Peer',
      sourceBio: null,
      bucketId: bucket.id,
      bucketName: bucket.name,
      recordIds: [],
      assetRefs: [],
      collection: {
        universeId: uni.id,
        name: `Universe: Soon Deleted Universe`,
        description: '',
        items: [],
      },
      note: null,
    };
    const filename = `2026-05-01T00-00-00-000Z-tombstone-inbox-peer-${collectionManifest.id}.json`;
    writeFileSync(join(tempBucket, 'manifests', filename), JSON.stringify(collectionManifest));

    // First import into inbox while universe is live.
    const result = await importer.processManifest(bucket.id, filename);
    expect(result.processed).toBe(true);
    expect(result.outcome.queued).toBe(true);

    // Now delete the universe locally (soft-delete / tombstone).
    await universeSvc.deleteUniverse(uni.id);

    // Attempt to promote — must throw with the distinct tombstoned code.
    const promoteErr = await importer.promoteInboxItem(bucket.id, collectionManifest.id).catch((e) => e);
    expect(promoteErr).toBeInstanceOf(Error);
    expect(promoteErr.code).toBe('SHARING_UNIVERSE_TOMBSTONED');
    expect(promoteErr.collectionTombstonedUniverse).toBe(uni.id);
    // Inbox item must NOT be consumed — user can retry after restoring the universe.
    const inbox = await importer.listInbox(bucket.id);
    expect(inbox.some((it) => it.manifestId === collectionManifest.id)).toBe(true);
  });

  it('refuses a manifest with a sharingSchemaVersion newer than local + emits incompatible event', async () => {
    const { SHARING_SCHEMA_VERSION } = await import('./version.js');
    const { sharingEvents } = await import('./importer.js');
    const bucket = await buckets.createBucket({ name: 'Compat', path: tempBucket, mode: 'auto-merge' });

    // Hand-craft a future-version manifest directly into the bucket.
    const manifestsDir = join(tempBucket, 'manifests');
    const futureManifest = {
      id: 'mfst-future',
      schemaVersion: SHARING_SCHEMA_VERSION + 1,
      sharingSchemaVersion: SHARING_SCHEMA_VERSION + 1,
      producedByVersion: '9.99.0',
      createdAt: new Date().toISOString(),
      kind: 'series',
      senderInstanceId: 'peer-on-newer',
      source: 'Future Peer',
      sourceBio: null,
      bucketId: bucket.id,
      bucketName: bucket.name,
      recordIds: [],
      assetRefs: [],
      note: null,
    };
    const filename = `2099-01-01T00-00-00-000Z-future-peer-${futureManifest.id}.json`;
    writeFileSync(join(manifestsDir, filename), JSON.stringify(futureManifest));

    const events = [];
    const onIncompat = (p) => events.push(p);
    sharingEvents.on('incompatible-manifest', onIncompat);

    const result = await importer.processManifest(bucket.id, filename);
    sharingEvents.off('incompatible-manifest', onIncompat);

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('incompatible-version');
    expect(result.remoteVersion).toBe(SHARING_SCHEMA_VERSION + 1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      bucketId: bucket.id,
      remoteVersion: SHARING_SCHEMA_VERSION + 1,
      localVersion: SHARING_SCHEMA_VERSION,
      source: 'Future Peer',
      producedByVersion: '9.99.0',
    });

    // A second process is dedup'd via the cursor (we marked it processed to
    // prevent the watcher replay loop).
    const replay = await importer.processManifest(bucket.id, filename);
    expect(replay.skipped).toBe(true);
    expect(replay.reason).toBe('already-processed');
  });

  it('annotation manifest round-trip: peer record merges into local annotations without touching pipeline records', async () => {
    const { sharingEvents } = await import('./importer.js');
    const { SHARING_SCHEMA_VERSION } = await import('./version.js');
    const mediaAnnotations = await import('../mediaAnnotations.js');
    const bucket = await buckets.createBucket({ name: 'AnnotationsBucket', path: tempBucket, mode: 'auto-merge' });

    // Stage a bucket asset so peer annotations have a corresponding key.
    mkdirSync(join(tempBucket, 'assets', 'images'), { recursive: true });
    writeFileSync(join(tempBucket, 'assets', 'images', 'fakeasset.png'), 'PNGSTUB');

    // Hand-write a peer's annotation record + manifest. Bypasses the exporter
    // (which would stamp the LOCAL instance id and short-circuit as
    // self-authored on import). simulateRemoteSender is conceptually the same
    // trick the other tests use.
    const recordDir = join(tempBucket, 'records', 'media-annotations');
    mkdirSync(recordDir, { recursive: true });
    const peerRecord = {
      id: 'peer-on-other-machine',
      instanceId: 'peer-on-other-machine',
      authorName: 'Sam',
      updatedAt: '2099-01-01T00:00:00.000Z',
      annotations: {
        'image:fakeasset.png': { starred: true, note: 'great shot', updatedAt: '2099-01-01T00:00:00.000Z' },
      },
    };
    writeFileSync(join(recordDir, 'peer-on-other-machine.json'), JSON.stringify(peerRecord));

    const peerManifest = {
      id: 'mfst-annotations-peer',
      schemaVersion: SHARING_SCHEMA_VERSION,
      sharingSchemaVersion: SHARING_SCHEMA_VERSION,
      producedByVersion: '1.0.0',
      createdAt: '2099-01-01T00:00:00.000Z',
      kind: 'media-annotations',
      senderInstanceId: 'peer-on-other-machine',
      source: 'Sam',
      sourceBio: null,
      bucketId: bucket.id,
      bucketName: bucket.name,
      recordIds: ['peer-on-other-machine'],
      assetRefs: [],
      note: null,
    };
    const filename = `annotations-peer-on-other-machine.json`;
    mkdirSync(join(tempBucket, 'manifests'), { recursive: true });
    writeFileSync(join(tempBucket, 'manifests', filename), JSON.stringify(peerManifest));

    const events = [];
    const onUpdate = (p) => events.push(p);
    sharingEvents.on('annotation-updated', onUpdate);

    const result = await importer.processManifest(bucket.id, filename);
    sharingEvents.off('annotation-updated', onUpdate);

    expect(result.processed).toBe(true);
    expect(result.outcome.applied).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0].key).toBe('image:fakeasset.png');
    expect(events[0].entry.others[0]).toMatchObject({ authorName: 'Sam', starred: true, note: 'great shot' });

    // The peer record lives under their instanceId in local annotations; our
    // own author entry (would-be empty in a fresh fixture) is untouched.
    const local = await mediaAnnotations.listAnnotations();
    expect(local['image:fakeasset.png'].own).toBeNull();
    expect(local['image:fakeasset.png'].others[0]).toMatchObject({ authorName: 'Sam', starred: true, note: 'great shot' });

    // Cursor was advanced — replay is a no-op.
    const replay = await importer.processManifest(bucket.id, filename);
    expect(replay.skipped).toBe(true);
    expect(replay.reason).toBe('already-processed');
  });

  it('writes <bucket>/assets/blobs/.index.json mapping sourcePath:mtime:size → hash and invalidates on mtime change', async () => {
    const bucket = await buckets.createBucket({ name: 'CacheBucket', path: tempBucket, mode: 'auto-merge' });
    const sourcePath = join(tempData, 'images', 'fakeasset.png'); // seeded as 'PNGSTUB' in beforeEach

    // Single-asset export — exportMedia falls through to copyAssetIfPresent (getJob is mocked → null).
    await exporter.exportMedia([{ kind: 'image', ref: 'fakeasset.png' }], bucket.id);

    const indexPath = join(tempBucket, 'assets', 'blobs', '.index.json');
    expect(existsSync(indexPath)).toBe(true);

    const initialStat = statSync(sourcePath);
    const initialKey = `${sourcePath}:${initialStat.mtimeMs}:${initialStat.size}`;
    const initialHash = sha256Hex('PNGSTUB');
    const idx1 = JSON.parse(readFileSync(indexPath, 'utf-8'));
    expect(idx1[initialKey]).toBe(initialHash);

    // Re-export unchanged file → cache hit → no new keys → index file not rewritten.
    // Assert the index file's mtime is unchanged (dirty-flag short-circuits the write).
    const indexMtimeBefore = statSync(indexPath).mtimeMs;
    await new Promise((r) => setTimeout(r, 5));
    await exporter.exportMedia([{ kind: 'image', ref: 'fakeasset.png' }], bucket.id);
    expect(statSync(indexPath).mtimeMs).toBe(indexMtimeBefore);

    // Bumping mtime alone (same bytes, same size) creates a new cache key — old entry stays,
    // new entry covers the post-touch stat. The hash is unchanged because the bytes are the same.
    const future = new Date(initialStat.mtimeMs + 60_000);
    utimesSync(sourcePath, future, future);
    await exporter.exportMedia([{ kind: 'image', ref: 'fakeasset.png' }], bucket.id);
    const touchedStat = statSync(sourcePath);
    const touchedKey = `${sourcePath}:${touchedStat.mtimeMs}:${touchedStat.size}`;
    expect(touchedKey).not.toBe(initialKey);
    const idx2 = JSON.parse(readFileSync(indexPath, 'utf-8'));
    expect(idx2[touchedKey]).toBe(initialHash);

    // Mutating content invalidates and records a fresh hash.
    writeFileSync(sourcePath, 'PNGSTUB-v2');
    await exporter.exportMedia([{ kind: 'image', ref: 'fakeasset.png' }], bucket.id);
    const mutatedStat = statSync(sourcePath);
    const mutatedKey = `${sourcePath}:${mutatedStat.mtimeMs}:${mutatedStat.size}`;
    const idx3 = JSON.parse(readFileSync(indexPath, 'utf-8'));
    expect(idx3[mutatedKey]).toBe(sha256Hex('PNGSTUB-v2'));
    // Mutated bytes also land in the bucket under the new hash (content-addressed).
    expect(existsSync(join(tempBucket, 'assets', 'blobs', sha256Hex('PNGSTUB-v2')))).toBe(true);
  });

  it('parallel exports against the same bucket merge cache entries instead of clobbering (exportByKind fanout)', async () => {
    const bucket = await buckets.createBucket({ name: 'MergeBucket', path: tempBucket, mode: 'auto-merge' });
    // Two distinct assets, both seeded with distinct bytes so they hash differently.
    writeFileSync(join(tempData, 'images', 'parallelA.png'), 'PARALLEL_A');
    writeFileSync(join(tempData, 'images', 'parallelB.png'), 'PARALLEL_B');
    // Two singleton media exports run in parallel — each loads its own cache view,
    // each saves with merge-on-save. Both new keys must survive in the persisted index.
    await Promise.all([
      exporter.exportMedia([{ kind: 'image', ref: 'parallelA.png' }], bucket.id),
      exporter.exportMedia([{ kind: 'image', ref: 'parallelB.png' }], bucket.id),
    ]);
    const indexPath = join(tempBucket, 'assets', 'blobs', '.index.json');
    const idx = JSON.parse(readFileSync(indexPath, 'utf-8'));
    const statA = statSync(join(tempData, 'images', 'parallelA.png'));
    const statB = statSync(join(tempData, 'images', 'parallelB.png'));
    const keyA = `${join(tempData, 'images', 'parallelA.png')}:${statA.mtimeMs}:${statA.size}`;
    const keyB = `${join(tempData, 'images', 'parallelB.png')}:${statB.mtimeMs}:${statB.size}`;
    expect(idx[keyA]).toBe(sha256Hex('PARALLEL_A'));
    expect(idx[keyB]).toBe(sha256Hex('PARALLEL_B'));
  });

  // ---------------------------------------------------------------------------
  // SCHEMA-VERSION GATING — share-bucket transport
  // ---------------------------------------------------------------------------
  describe('portos-schema-ahead manifest gate', () => {
    it('manifest is stamped with the sender\'s PORTOS_SCHEMA_VERSIONS', async () => {
      const bucket = await buckets.createBucket({ name: 'GateBucket', path: tempBucket, mode: 'inbox' });
      const s = await series.createSeries({ name: 'Stamp Test', logline: 'x' });
      const exp = await exporter.exportSeries(s.id, bucket.id);
      const manifest = JSON.parse(readFileSync(join(tempBucket, 'manifests', exp.filename), 'utf-8'));
      expect(manifest.portosSchemaVersions).toBeDefined();
      expect(manifest.portosSchemaVersions.universes).toBe(5);
    });

    it('importer rejects a manifest whose portosSchemaVersions.universes is AHEAD of local', async () => {
      const bucket = await buckets.createBucket({ name: 'AheadBucket', path: tempBucket, mode: 'auto-merge' });
      const s = await series.createSeries({ name: 'Future', logline: 'x' });
      const exp = await exporter.exportSeries(s.id, bucket.id);
      // Mutate the written manifest to stamp a future portos schema. This
      // simulates a manifest exported by a NEWER PortOS instance landing in
      // an OLDER instance's bucket.
      const manifestPath = join(tempBucket, 'manifests', exp.filename);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      manifest.portosSchemaVersions = { universes: 99 };
      manifest.producedByVersion = '99.0.0';
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      // Delete the local series so the auto-merge would normally re-create it.
      await series.deleteSeries(s.id);
      simulateRemoteSender(tempBucket, exp.filename);
      const result = await importer.processManifest(bucket.id, exp.filename);
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('portos-schema-ahead');
      expect(result.ahead).toEqual([{ category: 'universes', senderV: 99, receiverV: 5 }]);
      expect(result.producedByVersion).toBe('99.0.0');
      // Series stayed tombstoned (or absent) — apply was refused.
      await expect(series.getSeries(s.id)).rejects.toThrow();
    });

    it('importer falls through for manifests with no portosSchemaVersions (legacy peer)', async () => {
      // A manifest produced by a pre-this-PR PortOS won't have the field;
      // the comparator treats it as no-contract, so the merge proceeds.
      const bucket = await buckets.createBucket({ name: 'LegacyBucket', path: tempBucket, mode: 'auto-merge' });
      const s = await series.createSeries({ name: 'Legacy Test', logline: 'x' });
      const exp = await exporter.exportSeries(s.id, bucket.id);
      const manifestPath = join(tempBucket, 'manifests', exp.filename);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      delete manifest.portosSchemaVersions;
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      await series.deleteSeries(s.id);
      simulateRemoteSender(tempBucket, exp.filename);
      const result = await importer.processManifest(bucket.id, exp.filename);
      expect(result.processed).toBe(true);
      expect(result.outcome.mode).toBe('auto-merge');
      const restored = await series.getSeries(s.id);
      expect(restored.id).toBe(s.id);
    });
  });
});
