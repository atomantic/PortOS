/**
 * One-time data repair: friendlify legacy machine universe tags on catalog
 * ingredients.
 *
 * The original bible→catalog backfill stamped `from-universe` +
 * `universe:<universeId>` machine tags onto every promoted character/place/
 * object. Those are unreadable in the Catalog UI (a raw UUID means nothing to a
 * human) and leak an internal id into the tag taxonomy. This repair rewrites
 * them into the friendly universe NAME tag (e.g. "My Cool Universe") while
 * preserving every user-supplied tag — the structured universe link already
 * lives durably in `catalog_ingredient_refs`, so the tag never needed the id
 * for querying.
 *
 * Idempotent: the transform (`friendlifyUniverseTags`) only rewrites rows that
 * still carry a legacy machine tag, so a second pass over an already-repaired
 * row is a no-op. A marker in `data/catalog-universe-tags.applied.json` gates
 * the walk so it doesn't re-query every ingredient on every boot once done.
 *
 * Wired into server/index.js at boot, after `ensureSchema()` + the bible→
 * catalog backfill, so promoted rows exist before this runs.
 *
 * The corresponding `scripts/migrations/053-catalog-friendly-universe-tags.js`
 * is a registration stub for the migration ledger — the actual repair runs
 * here (boot-time) because the `scripts/migrations/` runner executes before the
 * DB pool is up, the same reason migrations 048–052 are boot-time + stubbed.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { PATHS } from '../lib/fileUtils.js';
import { friendlifyUniverseTags } from '../lib/catalogUniverseTags.js';
import { canonicalTagKey } from '../lib/catalogTypes.js';
import { listUniverses } from '../services/universeBuilder.js';
import * as catalogDB from '../services/catalogDB.js';

// v2: v1 shipped a no-op pass (it read `listIngredients()` as a bare array and
// broke before scanning any row, yet still wrote the v1 marker). Bumping to 2
// makes installs that already recorded the broken v1 marker re-run the now-fixed
// repair instead of skipping it forever.
const MARKER_VERSION = 2;
const MARKER_FILENAME = 'catalog-universe-tags.applied.json';

async function readMarker() {
  const path = join(PATHS.data, MARKER_FILENAME);
  const raw = await readFile(path, 'utf-8').catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function writeMarker(payload) {
  const path = join(PATHS.data, MARKER_FILENAME);
  await writeFile(path, JSON.stringify(payload, null, 2), 'utf-8');
}

/**
 * Build a universeId → name lookup from every universe (including deleted, so a
 * row tagged with a soft-deleted universe still resolves to a readable name
 * rather than getting its name dropped).
 */
async function buildUniverseNameMap() {
  const universes = await listUniverses({ includeDeleted: true });
  const map = new Map();
  for (const u of universes) {
    if (u?.id && typeof u.name === 'string' && u.name.trim()) {
      map.set(u.id, u.name.trim());
    }
  }
  return map;
}

/**
 * Public entry point. Runs once, then no-ops on every subsequent boot via the
 * marker file. `force` re-runs the walk (used by tests / an admin re-trigger).
 */
export async function repairUniverseTags({ force = false } = {}) {
  const marker = await readMarker();
  if (marker?.version === MARKER_VERSION && !force) {
    return { skipped: true, marker };
  }

  console.log('🏷️  universe-tag repair: starting');
  const nameMap = await buildUniverseNameMap();
  const nameForId = (id) => nameMap.get(id) || null;

  const totals = { scanned: 0, rewritten: 0, errors: 0, unresolved: 0 };
  // Page through every ingredient. Only character/place/object rows can carry
  // the legacy tags, but a tag-only scan is cheap and future-proof, so we walk
  // all rows and let the pure transform decide what's a no-op.
  const PAGE = 200;
  let offset = 0;
  for (;;) {
    // listIngredients returns `{ items, nextOffset }`, NOT a bare array.
    const { items: rows } = await catalogDB.listIngredients({ limit: PAGE, offset });
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const ing of rows) {
      totals.scanned++;
      const { tags, changed, unresolved } = friendlifyUniverseTags(ing.tags, nameForId, canonicalTagKey);
      // A row whose universe id can't be resolved yet is preserved (changed may
      // be false) — count it so the marker is withheld and a future boot retries.
      if (unresolved) totals.unresolved++;
      if (!changed) continue;
      try {
        // `source: 'sync'` keeps the rewrite out of the user-facing revision
        // diff noise — it's a system data repair, not a user edit. (Tag changes
        // still record a revision; the badge just reads as a sync rewrite.)
        await catalogDB.updateIngredient(ing.id, { tags }, { source: 'sync', actor: 'universe-tag-repair' });
        totals.rewritten++;
      } catch (err) {
        console.error(`🏷️  universe-tag repair failed (${ing.id}): ${err.message}`);
        totals.errors++;
      }
    }
    if (rows.length < PAGE) break;
    offset += PAGE;
  }

  const payload = {
    version: MARKER_VERSION,
    completedAt: new Date().toISOString(),
    stats: totals,
  };
  // Only stamp the completion marker on a CLEAN, COMPLETE pass — no row-level
  // failures (transient DB errors) AND no rows left with an unresolved
  // `universe:<id>` tag (its universe hasn't arrived locally yet). Writing the
  // marker in either case would skip the whole repair next boot and strand
  // those rows' legacy tags forever. Withholding it re-runs the (idempotent)
  // repair next boot — already-friendlified rows are no-ops, so only the failed
  // / not-yet-resolvable rows retry.
  const wroteMarker = totals.errors === 0 && totals.unresolved === 0;
  if (wroteMarker) await writeMarker(payload);

  console.log(
    `🏷️  universe-tag repair: ${totals.scanned} scanned, ` +
    `${totals.rewritten} rewritten, ${totals.errors} errors, ${totals.unresolved} unresolved` +
    (wroteMarker ? '' : ' — marker NOT written (will retry next boot)'),
  );

  return { skipped: false, markerWritten: wroteMarker, ...payload };
}
