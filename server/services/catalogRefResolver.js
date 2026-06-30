/**
 * Catalog ref resolver + dangling-ref integrity (#1018).
 *
 * `catalog_ingredient_refs` records which app-native record (universe / series /
 * issue / work / creative-director) consumes a catalog ingredient, by a
 * `(ref_kind, ref_id)` STRING tuple with NO database foreign key — deliberately
 * (design #999, decision D3): a ref can federate to a peer BEFORE its target
 * arrives, and a hard FK would make catalog sync FAIL on out-of-order apply.
 *
 * Now that all five target kinds are DB-native (universes #1014, pipeline
 * series/issues #1015, writers_room_works #1017, creative_director_projects
 * #997), this module delivers the integrity #999 asked for WITHOUT a constraint:
 *
 *   - resolveRefs(tuples)          → which tuples point at a LIVE target
 *   - listDanglingRefs()           → live refs whose target no longer resolves
 *                                    (mirrors the media `metadata-missing` check)
 *
 * Read-only + local — it never touches the wire. The existing
 * `idx_catalog_ing_refs_target (ref_kind, ref_id)` index already makes the
 * reverse lookup cheap, so no schema change is required.
 */

import { query } from '../lib/db.js';

// ref_kind → the DB table its ref_id points at, plus the predicate that makes a
// row a LIVE target. All five target kinds soft-delete (a `deleted` column;
// creative_director_projects gained one in #1564 so its deletion federates), so
// a live target is `deleted = FALSE` in every case. This map is the single
// source of truth for the resolver — adding a new referenceable record kind
// means adding one row here.
export const REF_TARGET_TABLES = Object.freeze({
  universe: { table: 'universes', liveClause: 'deleted = FALSE' },
  series: { table: 'pipeline_series', liveClause: 'deleted = FALSE' },
  issue: { table: 'pipeline_issues', liveClause: 'deleted = FALSE' },
  work: { table: 'writers_room_works', liveClause: 'deleted = FALSE' },
  'creative-director': { table: 'creative_director_projects', liveClause: 'deleted = FALSE' },
});

/** The ref kinds this resolver can resolve (those with a known target table). */
export const RESOLVABLE_REF_KINDS = Object.freeze(Object.keys(REF_TARGET_TABLES));

// SELECT 1 … existence probe for one target, honoring its live predicate.
function targetExistsSql(refKind) {
  const target = REF_TARGET_TABLES[refKind];
  if (!target) return null;
  const where = target.liveClause ? `id = $1 AND ${target.liveClause}` : 'id = $1';
  return `SELECT EXISTS(SELECT 1 FROM ${target.table} WHERE ${where}) AS ok`;
}

// Cache key for a (refKind, refId) pair. JSON-stringify so the two fields are
// joined by an unambiguous, printable delimiter — no in-band separator a refId
// could itself contain, and no non-printable byte that would make this source
// read as binary to git/grep/diff.
function cacheKey(refKind, refId) {
  return JSON.stringify([refKind, refId]);
}

/**
 * For a batch of `{ refKind, refId }` tuples, return each annotated with
 * `resolved` (true = a live target row exists). An unknown ref_kind resolves to
 * `resolved: false` with `reason: 'unknown-kind'` rather than throwing — a
 * peer-sourced ref could name a kind this build doesn't know.
 *
 * Distinct (refKind, refId) pairs are probed once each; duplicates in the input
 * reuse the result. Small N (a record's ref set), so per-tuple probes are fine.
 */
export async function resolveRefs(tuples) {
  if (!Array.isArray(tuples) || tuples.length === 0) return [];
  const cache = new Map();
  const out = [];
  for (const t of tuples) {
    const refKind = t?.refKind;
    const refId = t?.refId;
    const key = cacheKey(refKind, refId);
    if (!cache.has(key)) {
      if (!REF_TARGET_TABLES[refKind]) {
        cache.set(key, { resolved: false, reason: 'unknown-kind' });
      } else if (typeof refId !== 'string' || !refId) {
        cache.set(key, { resolved: false, reason: 'missing-ref-id' });
      } else {
        const { rows } = await query(targetExistsSql(refKind), [refId]);
        const resolved = rows[0]?.ok === true;
        // Tag the unresolved-but-known case with the same `missing-target` reason
        // listDanglingRefs uses, so both read paths describe the state identically.
        cache.set(key, resolved ? { resolved: true } : { resolved: false, reason: 'missing-target' });
      }
    }
    out.push({ refKind, refId, ...cache.get(key) });
  }
  return out;
}

/**
 * Every LIVE ref whose `ref_id` no longer resolves to a live target — the
 * dangling-ref integrity report. One grouped query per known kind (over the
 * distinct targets, not every ref row) keeps it cheap; refs whose kind has no
 * target table are reported as `unknown-kind` so nothing is silently dropped.
 *
 * Only refs that are themselves live AND whose ingredient is live count — a
 * soft-deleted ingredient leaves its ref rows in place (deleted = FALSE), but
 * those have no live "Appears in" consumer, so reporting them would be a false
 * positive (matches the `JOIN … i.deleted = false` filter every user-facing ref
 * path uses).
 *
 * Returns one entry per dangling (ref_kind, ref_id) target, with the count of
 * live ingredient links pointing at it: `{ refKind, refId, reason, linkCount }`.
 */
export async function listDanglingRefs() {
  // Distinct live targets actually referenced by a LIVE ingredient, with how
  // many such links each has.
  const { rows } = await query(
    `SELECT r.ref_kind, r.ref_id, COUNT(*)::int AS link_count
       FROM catalog_ingredient_refs r
       JOIN catalog_ingredients i ON i.id = r.ingredient_id AND i.deleted = FALSE
      WHERE r.deleted = FALSE
      GROUP BY r.ref_kind, r.ref_id`,
  );
  const dangling = [];
  // Probe each distinct target. Group by kind so we can batch the resolvable
  // ones with a single ANY() query per table instead of one probe per target.
  const byKind = new Map();
  for (const r of rows) {
    if (!byKind.has(r.ref_kind)) byKind.set(r.ref_kind, []);
    byKind.get(r.ref_kind).push({ refId: r.ref_id, linkCount: r.link_count });
  }
  for (const [refKind, targets] of byKind) {
    const meta = REF_TARGET_TABLES[refKind];
    if (!meta) {
      // Unknown kind — every target of it is unresolvable on this build.
      for (const t of targets) dangling.push({ refKind, refId: t.refId, reason: 'unknown-kind', linkCount: t.linkCount });
      continue;
    }
    const ids = targets.map((t) => t.refId);
    const where = meta.liveClause ? `${meta.liveClause} AND id = ANY($1)` : 'id = ANY($1)';
    const live = await query(`SELECT id FROM ${meta.table} WHERE ${where}`, [ids]);
    const liveSet = new Set(live.rows.map((row) => row.id));
    for (const t of targets) {
      if (!liveSet.has(t.refId)) {
        dangling.push({ refKind, refId: t.refId, reason: 'missing-target', linkCount: t.linkCount });
      }
    }
  }
  return dangling;
}
