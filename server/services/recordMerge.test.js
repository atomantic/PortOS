import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mockNoPeerSync, mockNoPeers, makePathsProxy } from '../lib/mockPathsDataRoot.js';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'record-merge-test-'));

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: TEST_DATA_ROOT }));
vi.mock('./instances.js', () => mockNoPeers());
vi.mock('./sharing/peerSync.js', () => mockNoPeerSync());

let uuidCounter = 0;
vi.mock('crypto', async () => {
  const actual = await vi.importActual('crypto');
  return { ...actual, randomUUID: () => `uuid-${String(++uuidCounter).padStart(8, '0')}` };
});

const merge = await import('./recordMerge.js');
const universeSvc = await import('./universeBuilder.js');
const seriesSvc = await import('./pipeline/series.js');
const issuesSvc = await import('./pipeline/issues.js');
const collectionsSvc = await import('./mediaCollections.js');

afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

describe('recordMerge — pure union helpers', () => {
  it('unionEntryList dedupes by id, unions imageRefs on match, appends uniques', () => {
    const out = merge.unionEntryList(
      [{ id: 'v1', label: 'A', imageRefs: ['a.png'] }],
      [
        { id: 'v1', label: 'A', imageRefs: ['b.png'] }, // matches v1 → union refs
        { id: 'v2', label: 'B', imageRefs: ['c.png'] }, // unique → appended
      ],
    );
    expect(out).toHaveLength(2);
    expect(out[0].imageRefs).toEqual(['a.png', 'b.png']);
    expect(out[1].id).toBe('v2');
  });

  it('unionEntryList matches by normalized label when id is absent', () => {
    const out = merge.unionEntryList(
      [{ label: 'Crystal Canyon', prompt: 'x' }],
      [{ label: ' crystal canyon ', prompt: 'y' }],
    );
    expect(out).toHaveLength(1); // same label-key → not duplicated
  });

  it('unionEntryList folds same-label entries even when ids differ (cross-install dupes)', () => {
    const out = merge.unionEntryList(
      [{ id: 'local-1', label: 'Crystal Canyon', imageRefs: ['a.png'] }],
      [{ id: 'remote-9', label: ' crystal canyon ', imageRefs: ['b.png'] }],
    );
    expect(out).toHaveLength(1); // different ids, same label → one entry
    expect(out[0].id).toBe('local-1'); // survivor entry kept
    expect(out[0].imageRefs).toEqual(['a.png', 'b.png']); // refs unioned
  });

  it('unionCategories merges keyed map, unioning shared keys and adding loser-only keys', () => {
    const out = merge.unionCategories(
      { landscapes: { kind: 'places', variations: [{ id: 'a', label: 'A' }] } },
      {
        landscapes: { kind: 'places', variations: [{ id: 'b', label: 'B' }] },
        outfits: { kind: 'objects', variations: [{ id: 'c', label: 'C' }] },
      },
    );
    expect(Object.keys(out).sort()).toEqual(['landscapes', 'outfits']);
    expect(out.landscapes.variations).toHaveLength(2);
  });

  it('unionInfluences case-insensitively dedupes embrace/avoid', () => {
    const out = merge.unionInfluences(
      { embrace: ['Moebius'], avoid: ['blurry'] },
      { embrace: ['moebius', 'noir'], avoid: ['lowres'] },
    );
    expect(out.embrace).toEqual(['Moebius', 'noir']);
    expect(out.avoid).toEqual(['blurry', 'lowres']);
  });

  it('buildUniverseUnion reports a scalar conflict when both sides differ', () => {
    const { conflicts, autoResolved, record } = merge.buildUniverseUnion(
      { name: 'Dup', starterPrompt: 'A', logline: '', categories: {}, influences: {}, characters: [], places: [], objects: [] },
      { name: 'Dup', starterPrompt: 'B', logline: 'only-loser', categories: {}, influences: {}, characters: [], places: [], objects: [] },
    );
    expect(conflicts).toEqual([{ field: 'starterPrompt', survivorValue: 'A', loserValue: 'B' }]);
    // logline present only on loser → auto-resolved to loser's value.
    expect(record.logline).toBe('only-loser');
    expect(autoResolved).toContainEqual({ field: 'logline', from: 'loser' });
  });

  it('buildSeriesUnion gap-fills a number-colliding loser season instead of dropping it', () => {
    const { record } = merge.buildSeriesUnion(
      { name: 'S', seasons: [{ number: 1, title: 'S1', summary: '' }] },
      { name: 'S', seasons: [{ number: 1, title: 'loser-title', summary: 'loser summary', episodes: ['e1'] }] },
    );
    // Survivor's season 1 kept (one entry, no duplicate number) but its empty
    // fields are filled from the loser — no silent data loss.
    expect(record.seasons).toHaveLength(1);
    expect(record.seasons[0].title).toBe('S1');            // survivor wins non-empty
    expect(record.seasons[0].summary).toBe('loser summary'); // gap-filled
    expect(record.seasons[0].episodes).toEqual(['e1']);      // gap-filled
  });

  it('buildSeriesUnion preserves a loser-only Writers Room link', () => {
    const { record, autoResolved } = merge.buildSeriesUnion(
      { name: 'S', seasons: [], writersRoomWorkId: '' },
      { name: 'S', seasons: [], writersRoomWorkId: 'wr-123' },
    );
    expect(record.writersRoomWorkId).toBe('wr-123');
    expect(autoResolved).toContainEqual({ field: 'writersRoomWorkId', from: 'loser' });
  });

  it('buildUniverseUnion applies fieldChoices to resolve conflicts', () => {
    const { conflicts, record } = merge.buildUniverseUnion(
      { name: 'Dup', starterPrompt: 'A', categories: {}, influences: {}, characters: [], places: [], objects: [] },
      { name: 'Dup', starterPrompt: 'B', categories: {}, influences: {}, characters: [], places: [], objects: [] },
      { starterPrompt: 'loser' },
    );
    expect(conflicts).toEqual([]);
    expect(record.starterPrompt).toBe('B');
  });

  it('buildUniverseUnion fieldOverrides beat survivor/loser binary even when both differ', () => {
    const { conflicts, record } = merge.buildUniverseUnion(
      { name: 'Dup', starterPrompt: 'A', categories: {}, influences: {}, characters: [], places: [], objects: [] },
      { name: 'Dup', starterPrompt: 'B', categories: {}, influences: {}, characters: [], places: [], objects: [] },
      { starterPrompt: 'survivor' }, // ignored — override wins
      { starterPrompt: 'A + B unified' },
    );
    expect(conflicts).toEqual([]);
    expect(record.starterPrompt).toBe('A + B unified');
  });

  it('buildUniverseUnion fieldOverrides honor empty-string clears', () => {
    const { conflicts, record } = merge.buildUniverseUnion(
      { name: 'Dup', starterPrompt: 'A', categories: {}, influences: {}, characters: [], places: [], objects: [] },
      { name: 'Dup', starterPrompt: 'B', categories: {}, influences: {}, characters: [], places: [], objects: [] },
      {},
      { starterPrompt: '' }, // explicit clear via override
    );
    expect(conflicts).toEqual([]);
    expect(record.starterPrompt).toBe('');
  });
});

describe('recordMerge — mergeUniverses (integration)', () => {
  beforeEach(() => {
    rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
    mkdirSync(TEST_DATA_ROOT, { recursive: true });
    uuidCounter = 0;
  });

  const seed = async () => {
    const survivor = await universeSvc.createUniverse({
      name: 'Clandestiny', starterPrompt: 'A',
      influences: { embrace: ['moebius'], avoid: [] },
      categories: { landscapes: { variations: [{ label: 'Canyon', prompt: 'c' }] } },
    });
    const loser = await universeSvc.createUniverse({
      name: 'Clandestiny', starterPrompt: 'A',
      influences: { embrace: ['noir'], avoid: [] },
      categories: { outfits: { variations: [{ label: 'Cloak', prompt: 'k' }] } },
    });
    return { survivor, loser };
  };

  it('dryRun previews union + cascade without writing', async () => {
    const { survivor, loser } = await seed();
    await seriesSvc.createSeries({ name: 'Child', universeId: loser.id });

    const preview = await merge.mergeUniverses(survivor.id, loser.id, {}, { dryRun: true });
    expect(preview.cascade.seriesToRepoint).toHaveLength(1);
    // Union carries the survivor's landscapes + the loser's outfits (plus any
    // default buckets createUniverse seeds).
    expect(Object.keys(preview.preview.categories)).toEqual(expect.arrayContaining(['landscapes', 'outfits']));
    // Nothing was written: loser still live, child still under loser.
    expect((await universeSvc.getUniverse(loser.id)).deleted).toBeFalsy();
  });

  it('executes: unions canon, re-points child series + collection, tombstones loser', async () => {
    const { survivor, loser } = await seed();
    const child = await seriesSvc.createSeries({ name: 'Child', universeId: loser.id });

    // Loser owns a collection with an item; survivor's collection starts empty.
    const loserCol = await collectionsSvc.findOrCreateUniverseCollection({ universeId: loser.id, universeName: 'Clandestiny' });
    await collectionsSvc.bulkUpdateCollectionItems(loserCol.id, { add: [{ kind: 'image', ref: 'loser-pic.png' }] });

    const result = await merge.mergeUniverses(survivor.id, loser.id, {});
    expect(result.merged).toBe(true);

    // Survivor gained the loser's unique category + influence.
    const merged = await universeSvc.getUniverse(survivor.id);
    expect(Object.keys(merged.categories)).toEqual(expect.arrayContaining(['landscapes', 'outfits']));
    expect(merged.influences.embrace).toEqual(expect.arrayContaining(['moebius', 'noir']));

    // Child series re-pointed to survivor.
    expect((await seriesSvc.getSeries(child.id)).universeId).toBe(survivor.id);

    // Loser tombstoned.
    await expect(universeSvc.getUniverse(loser.id)).rejects.toMatchObject({ code: universeSvc.ERR_NOT_FOUND });

    // Loser's collection item folded into the survivor's collection.
    const survivorCol = await collectionsSvc.findCollectionByUniverseId(survivor.id);
    expect(survivorCol.items.map((i) => i.ref)).toContain('loser-pic.png');
  });

  it('refuses to execute with an unresolved scalar conflict', async () => {
    const survivor = await universeSvc.createUniverse({ name: 'X', starterPrompt: 'survivor-prompt' });
    const loser = await universeSvc.createUniverse({ name: 'X', starterPrompt: 'loser-prompt' });
    await expect(merge.mergeUniverses(survivor.id, loser.id, {})).rejects.toMatchObject({ code: 'MERGE_VALIDATION' });
    // With a choice it succeeds.
    const ok = await merge.mergeUniverses(survivor.id, loser.id, { starterPrompt: 'loser' });
    expect(ok.merged).toBe(true);
    expect((await universeSvc.getUniverse(survivor.id)).starterPrompt).toBe('loser-prompt');
  });
});

describe('recordMerge — mergeSeries (integration)', () => {
  beforeEach(() => {
    rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
    mkdirSync(TEST_DATA_ROOT, { recursive: true });
    uuidCounter = 0;
  });

  it('re-points the loser series issues to the survivor and tombstones the loser', async () => {
    const u = await universeSvc.createUniverse({ name: 'U' });
    const survivor = await seriesSvc.createSeries({ name: 'Twin', universeId: u.id });
    const loser = await seriesSvc.createSeries({ name: 'Twin', universeId: u.id });
    await issuesSvc.createIssue({ seriesId: loser.id, title: 'Loser Issue' });

    const result = await merge.mergeSeries(survivor.id, loser.id, {});
    expect(result.merged).toBe(true);
    expect(result.cascade.issuesToRepoint).toBe(1);

    // The issue now belongs to the survivor.
    const survivorIssues = await issuesSvc.listIssues({ seriesId: survivor.id });
    expect(survivorIssues).toHaveLength(1);
    expect(survivorIssues[0].title).toBe('Loser Issue');

    // Loser tombstoned.
    await expect(seriesSvc.getSeries(loser.id)).rejects.toMatchObject({ code: seriesSvc.ERR_NOT_FOUND });
  });

  it('rejects merging series from different universes', async () => {
    const u1 = await universeSvc.createUniverse({ name: 'U1' });
    const u2 = await universeSvc.createUniverse({ name: 'U2' });
    const a = await seriesSvc.createSeries({ name: 'S', universeId: u1.id });
    const b = await seriesSvc.createSeries({ name: 'S', universeId: u2.id });
    await expect(merge.mergeSeries(a.id, b.id, {})).rejects.toMatchObject({ code: 'MERGE_VALIDATION' });
  });

  it('rejects merging two orphan series (null === null is not a valid scope)', async () => {
    // Orphans are surfaced separately as "never merged"; merging two unrelated
    // orphans would fold issues/collections across unrelated works.
    const a = await seriesSvc.createSeries({ name: 'Orphan', universeId: null });
    const b = await seriesSvc.createSeries({ name: 'Orphan', universeId: null });
    await expect(merge.mergeSeries(a.id, b.id, {})).rejects.toMatchObject({ code: 'MERGE_VALIDATION' });
  });
});
