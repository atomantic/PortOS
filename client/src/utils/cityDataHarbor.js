// Pure, deterministic helpers for CyberCity's Data Harbor: a pier district over the bay
// (master-plan parcel `dataHarbor`, north shore) that makes the install's storage legible
// at a glance. The PostgreSQL datastore becomes the **database quay** — one disk-stack silo
// per table, stack height log-scaled by row count, disk radius log-scaled by relation size,
// an orbiting ring marking pgvector (embedding) tables, and a migration obelisk at the pier
// head. The `data/` filesystem becomes the **archive racks** — one shipping-container rack
// per domain directory, lit slats log-scaled by disk usage. Data arrives from
// GET /api/city/introspection; `db: null` (unreachable) renders as a dimmed offline quay,
// distinct from a reachable-but-empty database. Structure colors are resolved by the
// component from the live theme palette (deterministic per name via getAccentColor). No
// three.js / React imports so the topology is unit-testable (mirrors cityMemoryDistrict.js).

import { formatBytes, formatCompactCount } from './formatters';
import { scaleMetricToHeight } from './cityDistrictLayout';
import { PARCELS } from './cityPlan';

export const DATA_HARBOR = {
  base: PARCELS.dataHarbor.anchor, // pier district over the bay (see cityPlan.js)
  deckY: 0.55, // pier deck height above the water
  quayOffsetX: 11, // west quay (silos) / east yard (racks) x-distance from the pier axis
  maxSilos: 10, // visible table-silo cap; the rest fold into the overflow count
  maxRacks: 8, // visible domain-rack cap
  siloSpacing: 3.6, // x-distance between adjacent silos
  rowGap: 4.4, // z-distance between the two rows of a quay/yard
  rowFrontZ: 1.5, // front (bay-side) row's z offset from the district base
  diskHeight: 0.42, // one disk in a silo stack
  diskGap: 0.14, // vertical gap between disks
  minDisks: 1,
  maxDisks: 7, // a packed table stays a legible stack, not a tower
  minDiskRadius: 0.65,
  maxDiskRadius: 1.35,
  rackSpacing: 3.1, // x-distance between adjacent racks
  rackWidth: 2.3,
  rackDepth: 1.6,
  rackHeight: 3.2,
  rackSlats: 8, // emissive slat rows per rack; lit count tracks the fill ratio
};

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// log2-scale `value` into [0, 1] against `max`. Delegates the curve to the shared
// scaleMetricToHeight so every district's log scaling stays one implementation.
const logRatio = (value, max) => {
  const scaledMax = scaleMetricToHeight(max, { k: 1 });
  if (scaledMax <= 0) return 0;
  return clamp(scaleMetricToHeight(value, { k: 1 }) / scaledMax, 0, 1);
};

// Two-row layout shared by the silo quay and the rack yard: items split into a front
// (bay-side) row and a back row, each row x-centered; `stagger` shifts the back row by a
// half-step (the silo quay uses it so stacks read brick-laid rather than gridded).
const twoRowOffset = (index, total, spacing, stagger = 0) => {
  const perRow = Math.ceil(total / 2);
  const row = index < perRow ? 0 : 1;
  const col = row === 0 ? index : index - perRow;
  const rowCount = row === 0 ? perRow : total - perRow;
  return {
    dx: col * spacing - ((rowCount - 1) * spacing) / 2 + row * stagger,
    dz: DATA_HARBOR.rowFrontZ - row * DATA_HARBOR.rowGap,
  };
};

// Silo geometry for the visible top-N tables (already size-sorted by the server; re-sorted
// here defensively).
function computeSilos(tables) {
  const sorted = [...tables].sort((a, b) => (b.totalBytes ?? 0) - (a.totalBytes ?? 0));
  const visible = sorted.slice(0, DATA_HARBOR.maxSilos);
  const maxRows = Math.max(...visible.map((t) => t.rowEstimate ?? 0), 0);
  const maxBytes = Math.max(...visible.map((t) => t.totalBytes ?? 0), 0);
  const [bx, , bz] = DATA_HARBOR.base;

  return visible.map((table, i) => {
    const { dx, dz } = twoRowOffset(i, visible.length, DATA_HARBOR.siloSpacing, DATA_HARBOR.siloSpacing / 2);
    const diskCount = clamp(
      Math.round(1 + logRatio(table.rowEstimate, maxRows) * (DATA_HARBOR.maxDisks - 1)),
      DATA_HARBOR.minDisks,
      DATA_HARBOR.maxDisks,
    );
    const diskRadius = DATA_HARBOR.minDiskRadius
      + logRatio(table.totalBytes, maxBytes) * (DATA_HARBOR.maxDiskRadius - DATA_HARBOR.minDiskRadius);
    return {
      name: table.name,
      x: bx - DATA_HARBOR.quayOffsetX + dx,
      z: bz + dz,
      diskCount,
      diskRadius,
      height: diskCount * (DATA_HARBOR.diskHeight + DATA_HARBOR.diskGap),
      hasEmbedding: Boolean(table.hasEmbedding),
      rowEstimate: table.rowEstimate ?? 0,
      totalBytes: table.totalBytes ?? 0,
      label: String(table.name || '').toUpperCase(),
      sublabel: `${formatCompactCount(table.rowEstimate ?? 0)} ROWS`,
      bytesLabel: formatBytes(table.totalBytes ?? 0),
    };
  });
}

// Rack geometry for the visible top-N data/ domains (server sorts by size; defensively
// re-sorted). Same two-row layout — a tight container yard.
function computeRacks(domains) {
  const sorted = [...domains].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
  const visible = sorted.slice(0, DATA_HARBOR.maxRacks);
  const maxBytes = Math.max(...visible.map((d) => d.bytes ?? 0), 0);
  const [bx, , bz] = DATA_HARBOR.base;

  return visible.map((domain, i) => {
    const { dx, dz } = twoRowOffset(i, visible.length, DATA_HARBOR.rackSpacing);
    const fillRatio = logRatio(domain.bytes, maxBytes);
    return {
      name: domain.name,
      x: bx + DATA_HARBOR.quayOffsetX + dx,
      z: bz + dz,
      width: DATA_HARBOR.rackWidth,
      depth: DATA_HARBOR.rackDepth,
      height: DATA_HARBOR.rackHeight,
      fillRatio,
      litSlats: clamp(Math.round(fillRatio * DATA_HARBOR.rackSlats), domain.bytes > 0 ? 1 : 0, DATA_HARBOR.rackSlats),
      bytes: domain.bytes ?? 0,
      files: domain.files ?? 0,
      label: String(domain.name || '').toUpperCase(),
      sublabel: formatBytes(domain.bytes ?? 0),
    };
  });
}

// A deck sized to contain a set of structures (plus a margin) — so a spacing or cap
// retune can never strand a silo off the pier. Falls back to a minimum platform so an
// empty quay still reads as a deck, not open water.
function deckFor(structures, centerX, centerZ, margin = 2.2) {
  let maxHalfW = 5;
  let maxHalfD = 4;
  for (const s of structures) {
    const r = s.diskRadius ?? Math.max(s.width ?? 0, s.depth ?? 0) / 2;
    maxHalfW = Math.max(maxHalfW, Math.abs(s.x - centerX) + r);
    maxHalfD = Math.max(maxHalfD, Math.abs(s.z - centerZ) + r);
  }
  return { x: centerX, z: centerZ, w: (maxHalfW + margin) * 2, d: (maxHalfD + margin) * 2 };
}

// The whole district model from one introspection payload.
//   - introspection missing entirely → { empty: true } (nothing renders — first load)
//   - db: null → dbDown: true (quay renders dimmed + "DB OFFLINE")
//   - fs: null → racks: [] (rack pier renders empty deck)
export function computeDataHarbor(introspection) {
  if (!introspection || typeof introspection !== 'object') return { empty: true };

  const db = introspection.db && Array.isArray(introspection.db.tables) ? introspection.db : null;
  const fsSection = introspection.fs && Array.isArray(introspection.fs.domains) ? introspection.fs : null;
  const tables = db?.tables ?? [];
  const domains = fsSection?.domains ?? [];

  const [bx, , bz] = DATA_HARBOR.base;
  const silos = computeSilos(tables);
  const racks = computeRacks(domains);
  const rowCenterZ = bz + DATA_HARBOR.rowFrontZ - DATA_HARBOR.rowGap / 2;

  return {
    empty: false,
    dbDown: !db,
    base: DATA_HARBOR.base,
    silos,
    racks,
    decks: [
      deckFor(silos, bx - DATA_HARBOR.quayOffsetX, rowCenterZ),
      deckFor(racks, bx + DATA_HARBOR.quayOffsetX, rowCenterZ),
    ],
    obelisk: db?.migrations
      ? { applied: db.migrations.applied ?? 0, lastApplied: db.migrations.lastApplied ?? null, x: bx, z: bz - 7 }
      : null,
    totals: {
      tableCount: tables.length,
      dbSizeBytes: db?.sizeBytes ?? null,
      dbSizeLabel: db?.sizeBytes != null ? formatBytes(db.sizeBytes) : null,
      fsBytes: fsSection?.totalBytes ?? null,
      fsLabel: fsSection?.totalBytes != null ? formatBytes(fsSection.totalBytes) : null,
      fsFiles: fsSection?.totalFiles ?? null,
      domainCount: domains.length,
    },
    overflow: {
      tables: Math.max(0, tables.length - DATA_HARBOR.maxSilos),
      domains: Math.max(0, domains.length - DATA_HARBOR.maxRacks),
    },
  };
}
