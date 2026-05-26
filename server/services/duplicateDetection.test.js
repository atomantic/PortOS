import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mockNoPeerSync, mockNoPeers, makePathsProxy } from '../lib/mockPathsDataRoot.js';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'dup-detect-test-'));

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: TEST_DATA_ROOT }));
vi.mock('./instances.js', () => mockNoPeers());
vi.mock('./sharing/peerSync.js', () => mockNoPeerSync());

let uuidCounter = 0;
vi.mock('crypto', async () => {
  const actual = await vi.importActual('crypto');
  return { ...actual, randomUUID: () => `uuid-${String(++uuidCounter).padStart(8, '0')}` };
});

const universeSvc = await import('./universeBuilder.js');
const seriesSvc = await import('./pipeline/series.js');
const dup = await import('./duplicateDetection.js');

afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

describe('duplicateDetection', () => {
  beforeEach(() => {
    rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
    mkdirSync(TEST_DATA_ROOT, { recursive: true });
    uuidCounter = 0;
  });

  describe('findDuplicateUniverseGroups', () => {
    it('groups universes by normalized (case/whitespace-insensitive) name', async () => {
      await universeSvc.createUniverse({ name: 'Clandestiny' });
      await universeSvc.createUniverse({ name: '  clandestiny ' });
      await universeSvc.createUniverse({ name: 'Echoes of the Choir' });

      const groups = await dup.findDuplicateUniverseGroups();
      expect(groups).toHaveLength(1);
      expect(groups[0].normalizedName).toBe('clandestiny');
      expect(groups[0].records).toHaveLength(2);
      // Each record carries counts for the survivor-suggestion UI.
      expect(groups[0].records[0].counts).toHaveProperty('characters');
    });

    it('excludes deleted and ephemeral universes', async () => {
      const a = await universeSvc.createUniverse({ name: 'Dup' });
      await universeSvc.createUniverse({ name: 'Dup' });
      const eph = await universeSvc.createUniverse({ name: 'Dup', ephemeral: true });
      // Three "Dup" exist, but deleting one and ephemeral-marking another leaves
      // only a single live non-ephemeral → no duplicate group.
      await universeSvc.deleteUniverse(a.id);
      expect(eph.ephemeral).toBe(true);
      const groups = await dup.findDuplicateUniverseGroups();
      expect(groups).toEqual([]);
    });

    it('reports linkedSeriesCount per universe', async () => {
      const u1 = await universeSvc.createUniverse({ name: 'WithSeries' });
      await universeSvc.createUniverse({ name: 'WithSeries' });
      await seriesSvc.createSeries({ name: 'A', universeId: u1.id });
      await seriesSvc.createSeries({ name: 'B', universeId: u1.id });
      const groups = await dup.findDuplicateUniverseGroups();
      const rec = groups[0].records.find((r) => r.id === u1.id);
      expect(rec.linkedSeriesCount).toBe(2);
    });
  });

  describe('findDuplicateSeriesGroups', () => {
    it('groups same-name series WITHIN a universe, not across universes', async () => {
      const u1 = await universeSvc.createUniverse({ name: 'U1' });
      const u2 = await universeSvc.createUniverse({ name: 'U2' });
      await seriesSvc.createSeries({ name: 'Salt Run', universeId: u1.id });
      await seriesSvc.createSeries({ name: 'Salt Run', universeId: u1.id }); // dup within u1
      await seriesSvc.createSeries({ name: 'Salt Run', universeId: u2.id }); // NOT a dup (diff universe)

      const { series } = await dup.findDuplicateSeriesGroups();
      expect(series).toHaveLength(1);
      expect(series[0].universeId).toBe(u1.id);
      expect(series[0].records).toHaveLength(2);
    });

    it('surfaces orphan series in a separate marked bucket (never merged across null)', async () => {
      // Orphans can only be created via the service (route forbids it).
      await seriesSvc.createSeries({ name: 'Lonely', universeId: null });
      await seriesSvc.createSeries({ name: 'Lonely', universeId: null });
      const { series, orphans, orphanCount } = await dup.findDuplicateSeriesGroups();
      expect(series).toEqual([]);
      expect(orphanCount).toBe(2);
      expect(orphans).toHaveLength(1);
      expect(orphans[0].normalizedName).toBe('lonely');
    });
  });

  describe('same-name create warning helpers', () => {
    it('findSameNameUniverses excludes the record itself', async () => {
      const a = await universeSvc.createUniverse({ name: 'Solo' });
      expect(await dup.findSameNameUniverses('Solo', { excludeId: a.id })).toEqual([]);
      await universeSvc.createUniverse({ name: 'Solo' });
      const hits = await dup.findSameNameUniverses('Solo', { excludeId: a.id });
      expect(hits).toHaveLength(1);
    });

    it('findSameNameSeries scopes within a universe and ignores orphans', async () => {
      const u1 = await universeSvc.createUniverse({ name: 'U' });
      const s1 = await seriesSvc.createSeries({ name: 'Twin', universeId: u1.id });
      await seriesSvc.createSeries({ name: 'Twin', universeId: u1.id });
      const hits = await dup.findSameNameSeries('Twin', u1.id, { excludeId: s1.id });
      expect(hits).toHaveLength(1);
      // No universe → never warns (orphans aren't duplicate-checked).
      expect(await dup.findSameNameSeries('Twin', null, {})).toEqual([]);
    });
  });
});
