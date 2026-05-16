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
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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
vi.mock('../instances.js', () => ({
  getInstanceId: () => Promise.resolve('test-instance-id'),
}));

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

    // Author a series + an issue locally.
    const s = await series.createSeries({
      name: 'Salt Run', logline: 'A foundry city goes silent.', premise: 'The only survivor is a child.',
      // Add an imageRef on a character so the exporter has an asset to copy.
      characters: [{ name: 'Vex', imageRefs: ['fakeasset.png'] }],
    });
    const iss = await issues.createIssue({ seriesId: s.id, title: 'Issue 1' });

    // Export.
    const exp = await exporter.exportSeries(s.id, bucket.id);
    expect(exp.manifestId).toBeTruthy();
    expect(exp.recordCount).toBe(2); // series + issue
    expect(exp.assetCount).toBeGreaterThanOrEqual(1);

    // Verify the bucket layout.
    expect(existsSync(join(tempBucket, 'manifests', exp.filename))).toBe(true);
    expect(existsSync(join(tempBucket, 'records', 'series', `${s.id}.json`))).toBe(true);
    expect(existsSync(join(tempBucket, 'records', 'issues', `${iss.id}.json`))).toBe(true);
    expect(existsSync(join(tempBucket, 'assets', 'images', 'fakeasset.png'))).toBe(true);

    // Process as inbox (the bucket mode is 'inbox'). The manifest should
    // queue, not auto-apply.
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
    const statePath = join(tempData, 'pipeline-series.json');
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    state.series[0].updatedAt = '2020-01-01T00:00:00.000Z';
    writeFileSync(statePath, JSON.stringify(state, null, 2));

    // Process the new manifest — should LWW-override.
    const r2 = await importer.processManifest(bucket.id, exp2.filename);
    expect(r2.outcome.mode).toBe('auto-merge');
    expect(r2.outcome.overridden).toHaveLength(1);
    expect(r2.outcome.overridden[0]).toMatchObject({ kind: 'series', id: s.id });

    const afterOverride = await series.getSeries(s.id);
    expect(afterOverride.name).toBe('Test Series (renamed)');
  });

  it('re-importing the same manifest is a no-op (cursor dedup)', async () => {
    const bucket = await buckets.createBucket({ name: 'D', path: tempBucket, mode: 'auto-merge' });
    const s = await series.createSeries({ name: 'X' });
    const exp = await exporter.exportSeries(s.id, bucket.id);
    await series.deleteSeries(s.id);

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
    expect(fs.existsSync(join(tempBucket, 'assets', 'images', 'second.png'))).toBe(true);

    // Drop the local collection + universe, then re-process: the importer
    // should recreate both, find-or-create the local collection by
    // universeId, and merge the items in.
    await mediaCollections.deleteCollection(collection.id);
    await universeBuilder.deleteUniverse(u.id);
    expect((await mediaCollections.listCollections()).find((c) => c.universeId === u.id)).toBeUndefined();

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

  it('universe export bundles a legacy convention-named collection with no universeId', async () => {
    const bucket = await buckets.createBucket({ name: 'LegacyBucket', path: tempBucket, mode: 'auto-merge' });
    const universeBuilder = await import('../universeBuilder.js');
    const mediaCollections = await import('../mediaCollections.js');
    const u = await universeBuilder.createUniverse({ name: 'Post-Epoc' });
    const fs = await import('fs');
    fs.writeFileSync(join(tempData, 'images', 'legacy.png'), 'PNG');

    const collection = await mediaCollections.createCollection({
      name: `Universe: ${u.name}`,
      description: 'Legacy unlinked collection',
    });
    await mediaCollections.addItem(collection.id, { kind: 'image', ref: 'legacy.png' });

    const exp = await exporter.exportUniverse(u.id, bucket.id);
    const manifest = JSON.parse(fs.readFileSync(join(tempBucket, 'manifests', exp.filename), 'utf-8'));
    expect(manifest.collection).toMatchObject({ name: 'Universe: Post-Epoc', universeId: u.id });
    expect(manifest.collection.items).toHaveLength(1);

    await mediaCollections.deleteCollection(collection.id);
    await universeBuilder.deleteUniverse(u.id);

    const r = await importer.processManifest(bucket.id, exp.filename);
    expect(r.processed).toBe(true);
    expect(r.outcome.collectionItemsAdded).toBe(1);

    const restored = (await mediaCollections.listCollections()).find((c) => c.name === 'Universe: Post-Epoc');
    expect(restored).toBeTruthy();
    expect(restored.universeId).toBe(u.id);
    expect(restored.items.map((i) => i.ref)).toEqual(['legacy.png']);
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
    fs.rmSync(join(tempBucket, 'assets', 'images', 'late.png'), { force: true });
    fs.rmSync(join(tempData, 'images', 'late.png'), { force: true });
    await mediaCollections.deleteCollection(collection.id);
    await universeBuilder.deleteUniverse(u.id);

    const first = await importer.processManifest(bucket.id, exp.filename);
    expect(first.pending).toBe(true);
    expect(first.outcome.pendingAssets).toEqual([{ kind: 'image', ref: 'late.png' }]);
    expect(first.outcome.collectionItemsAdded).toBe(1);
    expect(first.outcome.collectionItemsDeferred).toBe(1);

    let restoredCollection = (await mediaCollections.listCollections()).find((c) => c.universeId === u.id);
    expect(restoredCollection.items.map((i) => i.ref)).toEqual(['fakeasset.png']);
    let cursor = await readCursor(bucket.id);
    expect(hasBeenProcessed(cursor, exp.filename, exp.manifestId)).toBe(false);

    fs.writeFileSync(join(tempBucket, 'assets', 'images', 'late.png'), 'LATEPNG');
    const retry = await importer.processBacklog(bucket.id);
    expect(retry.processed).toBe(1);

    restoredCollection = (await mediaCollections.listCollections()).find((c) => c.universeId === u.id);
    expect(restoredCollection.items.map((i) => i.ref).sort()).toEqual(['fakeasset.png', 'late.png']);
    expect(fs.existsSync(join(tempData, 'images', 'late.png'))).toBe(true);
    cursor = await readCursor(bucket.id);
    expect(hasBeenProcessed(cursor, exp.filename, exp.manifestId)).toBe(true);
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
    const filename = subscriptionFilename(sub);
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
});
