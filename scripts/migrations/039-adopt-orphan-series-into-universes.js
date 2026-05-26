/**
 * Adopt orphan series (a series with no `universeId`) into a synthesized
 * universe, enforcing the hierarchy invariant "a series lives in exactly one
 * universe; a universe has many series".
 *
 * Why:
 *   PortOS now requires every series to belong to a universe (the create route
 *   rejects a missing universeId, updateSeries rejects un-linking, and
 *   deleteUniverse blocks while live series reference it). Legacy installs — and
 *   peers that shipped orphan series via share-bucket import before the rule
 *   existed — can still have series with `universeId: null` on disk. This
 *   migration gives each a home so the new guards never trip on legacy data.
 *
 * What it does:
 *   For each non-deleted series with no universeId, derive a STABLE universe id
 *   `uni-from-series-<sha1(seriesId)>` (same scheme as the long-standing
 *   migrateSeriesCanon CLI, so the two converge on the same orphan universe
 *   instead of minting two), create that universe if absent, and stamp the
 *   series' `universeId`.
 *
 * Dependency-light (fs + path + crypto only), per the migration convention —
 * the deterministic-id helper and universe-id cap are inlined copies of
 * server/services/universeBuilder.js / migrateSeriesCanon.js. KEEP IN SYNC.
 *
 * No new data.reference/ seed: this only populates a field on existing records
 * and writes records into the already-shipped universes collection layout — it
 * introduces no new file type or storage-layout change.
 *
 * Idempotent: a second run finds no orphans (they're now linked) → no-op. A
 * retry after a partial run reuses the deterministic universe instead of
 * duplicating.
 */

import { readFile, writeFile, mkdir, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'node:crypto';

// Record-shape version stamped INSIDE each universe (CURRENT_SCHEMA_VERSION in
// universeBuilder.js). sanitizeTemplate backfills any missing fields on read,
// so a minimal record at this version round-trips cleanly.
const RECORD_SCHEMA_VERSION = 4;
// Storage-layout version on data/universes/index.json (TYPE_SCHEMA_VERSION).
const TYPE_SCHEMA_VERSION = 5;
const SERIES_DIR = 'pipeline-series';
const UNIVERSES_DIR = 'universes';

// Mirror migrateSeriesCanon.deriveOrphanUniverseId — sha1 of the series id,
// truncated to 32 hex chars. `uni-from-series-` (16) + 32 = 48 chars, within
// UNIVERSE_ID_RE `[A-Za-z0-9-]{8,80}`.
const deriveOrphanUniverseId = (seriesId) =>
  `uni-from-series-${createHash('sha1').update(String(seriesId)).digest('hex').slice(0, 32)}`;

const fileExists = (p) => stat(p).then(() => true, (e) => {
  if (e.code === 'ENOENT') return false;
  throw e;
});
const readJson = async (p) => {
  const raw = await readFile(p, 'utf-8').catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
};
const writeJson = (p, value) => writeFile(p, JSON.stringify(value, null, 2) + '\n');

// Minimal v4 universe record. sanitizeTemplate normalizes the rest on first
// read; the next universe-side write persists the full shape.
const makeUniverseRecord = (id, series, now) => ({
  id,
  name: `${series.name} (adopted)`.slice(0, 100),
  starterPrompt: (series.logline || (series.premise ? String(series.premise).slice(0, 500) : '') || ''),
  categories: {},
  compositeSheets: [],
  influences: { embrace: [], avoid: [] },
  characters: [],
  places: [],
  objects: [],
  locked: {},
  schemaVersion: RECORD_SCHEMA_VERSION,
  createdAt: now,
  updatedAt: now,
  deleted: false,
  deletedAt: null,
});

export default {
  async up({ rootDir }) {
    const dataDir = join(rootDir, 'data');
    const seriesDir = join(dataDir, SERIES_DIR);
    const universesDir = join(dataDir, UNIVERSES_DIR);

    if (!(await fileExists(seriesDir))) {
      console.log('🧬 migration 039: no pipeline-series dir — fresh install, no-op');
      return { ok: true, reason: 'no-series' };
    }

    const entries = await readdir(seriesDir, { withFileTypes: true }).catch(() => []);
    const orphans = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'index.json' || entry.name.startsWith('.')) continue;
      const rec = await readJson(join(seriesDir, entry.name, 'index.json'));
      if (!rec || typeof rec !== 'object' || typeof rec.id !== 'string') continue;
      if (rec.deleted === true) continue;
      const linked = typeof rec.universeId === 'string' && rec.universeId.trim();
      if (!linked) orphans.push(rec);
    }

    if (orphans.length === 0) {
      console.log('🧬 migration 039: no orphan series — no-op');
      return { ok: true, reason: 'no-orphans' };
    }

    // Ensure the universes type index exists (an install with orphan series but
    // zero universes won't have one) so the store + verifyCollectionVersions
    // can read what we write.
    await mkdir(universesDir, { recursive: true });
    const typeIndexPath = join(universesDir, 'index.json');
    if (!(await fileExists(typeIndexPath))) {
      await writeJson(typeIndexPath, {
        schemaVersion: TYPE_SCHEMA_VERSION,
        type: 'universes',
        updatedAt: new Date().toISOString(),
        config: { runs: [] },
      });
    }

    let created = 0;
    let linked = 0;
    for (const series of orphans) {
      const now = new Date().toISOString();
      const universeId = deriveOrphanUniverseId(series.id);
      const recordDir = join(universesDir, universeId);
      const recordPath = join(recordDir, 'index.json');
      if (!(await fileExists(recordPath))) {
        await mkdir(recordDir, { recursive: true });
        await writeJson(recordPath, makeUniverseRecord(universeId, series, now));
        created += 1;
        console.log(`🌌 migration 039: created universe ${universeId} for orphan series "${series.name}" (${series.id})`);
      }
      // Stamp the link onto the series record + bump updatedAt so the link
      // propagates via the normal LWW sync path on the next cycle.
      await writeJson(
        join(seriesDir, series.id, 'index.json'),
        { ...series, universeId, updatedAt: now },
      );
      linked += 1;
    }

    console.log(`🧬 migration 039: adopted ${linked} orphan series into ${created} synthesized universe(s)`);
    return { ok: true, reason: 'adopted', linked, created };
  },
};
