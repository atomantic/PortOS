import { describe, it, expect } from 'vitest';
import { computeDataHarbor, DATA_HARBOR } from './cityDataHarbor';
import { PARCELS, isInWater, WORLD } from './cityPlan';

const table = (name, rowEstimate, totalBytes, hasEmbedding = false) =>
  ({ name, rowEstimate, totalBytes, hasEmbedding });
const domain = (name, bytes, files) => ({ name, bytes, files });

const happyIntrospection = () => ({
  ts: '2026-06-09T00:00:00.000Z',
  db: {
    sizeBytes: 5_000_000,
    tables: [
      table('memories', 1200, 900_000, true),
      table('catalog_scraps', 40, 50_000, true),
      table('schema_migrations', 12, 8_000),
    ],
    migrations: { applied: 12, lastApplied: '2026-06-01T00:00:00.000Z' },
  },
  fs: {
    domains: [domain('images', 3_100_000_000, 2400), domain('brain', 800_000, 60)],
    totalBytes: 3_100_800_000,
    totalFiles: 2460,
  },
});

describe('computeDataHarbor', () => {
  it('returns empty for a missing payload (nothing fetched yet)', () => {
    expect(computeDataHarbor(null)).toEqual({ empty: true });
    expect(computeDataHarbor(undefined)).toEqual({ empty: true });
  });

  it('flags dbDown when db is null without losing the filesystem racks', () => {
    const district = computeDataHarbor({ ...happyIntrospection(), db: null });
    expect(district.dbDown).toBe(true);
    expect(district.silos).toEqual([]);
    expect(district.obelisk).toBeNull();
    expect(district.racks).toHaveLength(2);
  });

  it('distinguishes a reachable-but-empty db from a down one', () => {
    const district = computeDataHarbor({
      ts: 'x',
      db: { sizeBytes: 1000, tables: [], migrations: null },
      fs: { domains: [], totalBytes: 0, totalFiles: 0 },
    });
    expect(district.dbDown).toBe(false);
    expect(district.silos).toEqual([]);
  });

  it('builds one silo per table with monotonic log scaling', () => {
    const district = computeDataHarbor(happyIntrospection());
    expect(district.silos).toHaveLength(3);
    const byName = Object.fromEntries(district.silos.map((s) => [s.name, s]));
    // More rows → at least as many disks; more bytes → at least as wide.
    expect(byName.memories.diskCount).toBeGreaterThanOrEqual(byName.catalog_scraps.diskCount);
    expect(byName.catalog_scraps.diskCount).toBeGreaterThanOrEqual(byName.schema_migrations.diskCount);
    expect(byName.memories.diskRadius).toBeGreaterThanOrEqual(byName.catalog_scraps.diskRadius);
    expect(byName.memories.diskCount).toBeLessThanOrEqual(DATA_HARBOR.maxDisks);
    // Embedding flag passes through.
    expect(byName.memories.hasEmbedding).toBe(true);
    expect(byName.schema_migrations.hasEmbedding).toBe(false);
    // Labels are render-ready.
    expect(byName.memories.label).toBe('MEMORIES');
    expect(byName.memories.sublabel).toBe('1.2K ROWS');
  });

  it('caps silos/racks at the visible max and reports the overflow', () => {
    const intro = happyIntrospection();
    intro.db.tables = Array.from({ length: 14 }, (_, i) => table(`t${i}`, i * 10, i * 1000));
    intro.fs.domains = Array.from({ length: 11 }, (_, i) => domain(`d${i}`, i * 1000, i));
    const district = computeDataHarbor(intro);
    expect(district.silos).toHaveLength(DATA_HARBOR.maxSilos);
    expect(district.racks).toHaveLength(DATA_HARBOR.maxRacks);
    expect(district.overflow).toEqual({ tables: 4, domains: 3 });
    // The visible set is the biggest-by-size, not the first-N.
    expect(district.silos.map((s) => s.name)).toContain('t13');
    expect(district.silos.map((s) => s.name)).not.toContain('t0');
  });

  it('keeps every structure inside the harbor parcel, over the water, on a deck', () => {
    const intro = happyIntrospection();
    intro.db.tables = Array.from({ length: 14 }, (_, i) => table(`t${i}`, i * 10, i * 1000));
    intro.fs.domains = Array.from({ length: 11 }, (_, i) => domain(`d${i}`, i * 1000, i));
    const district = computeDataHarbor(intro);
    const parcel = PARCELS.dataHarbor;
    const inParcel = (x, z, name) => {
      expect(Math.abs(x - parcel.anchor[0]), name).toBeLessThanOrEqual(parcel.w / 2);
      expect(Math.abs(z - parcel.anchor[2]), name).toBeLessThanOrEqual(parcel.d / 2);
    };
    for (const s of [...district.silos, ...district.racks]) {
      inParcel(s.x, s.z, s.name);
      expect(isInWater(s.x, s.z), s.name).toBe(true);
      // Every structure stands on one of the decks the helper emitted.
      const onDeck = district.decks.some((deck) =>
        Math.abs(s.x - deck.x) <= deck.w / 2 && Math.abs(s.z - deck.z) <= deck.d / 2);
      expect(onDeck, `${s.name} on a deck`).toBe(true);
    }
    inParcel(district.obelisk.x, district.obelisk.z, 'obelisk');
  });

  it('scales rack slats by log byte share with a lit floor for non-empty domains', () => {
    const district = computeDataHarbor(happyIntrospection());
    const images = district.racks.find((r) => r.name === 'images');
    const brain = district.racks.find((r) => r.name === 'brain');
    expect(images.litSlats).toBe(DATA_HARBOR.rackSlats); // the max domain is fully lit
    expect(brain.litSlats).toBeGreaterThanOrEqual(1); // non-empty never reads as unlit
    expect(brain.litSlats).toBeLessThan(images.litSlats);
    expect(images.sublabel).toBe('2.9 GB');
  });

  it('carries totals and the migration obelisk', () => {
    const district = computeDataHarbor(happyIntrospection());
    expect(district.obelisk).toMatchObject({ applied: 12, lastApplied: '2026-06-01T00:00:00.000Z' });
    expect(district.totals.tableCount).toBe(3);
    expect(district.totals.dbSizeLabel).toBe('4.8 MB');
    expect(district.totals.fsLabel).toBe('2.9 GB');
    expect(district.totals.domainCount).toBe(2);
  });

  it('is deterministic', () => {
    expect(computeDataHarbor(happyIntrospection())).toEqual(computeDataHarbor(happyIntrospection()));
  });
});

describe('harbor sits inside the world', () => {
  it('parcel is in the bay but inside the world bound', () => {
    const [x, , z] = DATA_HARBOR.base;
    expect(isInWater(x, z)).toBe(true);
    expect(Math.abs(z)).toBeLessThanOrEqual(WORLD.bound);
  });
});
