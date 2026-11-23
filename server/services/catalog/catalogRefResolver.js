/**
 * Catalog ref resolver + dangling-ref integrity (#1018).
 *
 * `catalog_ingredient_refs` records which app-native record (universe / series /
 * issue / work / creative-director / music-video) consumes a catalog ingredient, by a
 * `(ref_kind, ref_id)` STRING tuple with NO database foreign key — deliberately
 * (design #999, decision D3): a ref can federate to a peer BEFORE its target
 * arrives, and a hard FK would make catalog sync FAIL on out-of-order apply.
 *
 * Now that every target kind is DB-native (universes #1014, pipeline
 * series/issues #1015, writers_room_works #1017, creative_director_projects
 * #997, music_video_projects), this module delivers the integrity #999 asked
 * for WITHOUT a constraint:
 *
 *   - resolveRefs(tuples)          → which tuples point at a LIVE target
 *
 * Read-only + local — it never touches the wire. The existing
 * `idx_catalog_ing_refs_target (ref_kind, ref_id)` index already makes the
 * reverse lookup cheap, so no schema change is required.
 */

import { query } from '../../lib/db.js';

// ref_kind → the DB table its ref_id points at, plus the predicate that makes a
// row a LIVE target. Every target kind soft-deletes (a `deleted` column;
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
  'music-video': { table: 'music_video_projects', liveClause: 'deleted = FALSE' },
  storyboard: { table: 'storyboards', liveClause: 'deleted = FALSE' },
});

/** The ref kinds this resolver can resolve (those with a known target table). */
export const RESOLVABLE_REF_KINDS = Object.freeze(Object.keys(REF_TARGET_TABLES));

const REF_TITLE_SQL = Object.freeze({ universe: 'name', series: 'name', work: 'title',
  issue: "COALESCE(data->>'title', data->>'name', 'Issue ' || number::text)",
  'creative-director': "COALESCE(data->>'name', data->>'title')",
  'music-video': "COALESCE(data->>'name', data->>'title')",
  storyboard: 'name', fableloom: 'name', 'voice-profile': "data->>'name'" });

const DERIVED_TARGETS = Object.freeze({ fableloom: { table: 'fableloom_stories', liveClause: 'deleted = false' },
  'voice-profile': { table: 'voice_profiles', liveClause: "approval_status <> 'retired'" } });

// Batch labels by kind; missing targets stay visible without dead deep links.
export async function describeCatalogRefs(refs, exec = query) {
  const names = new Map();
  const byKind = new Map();
  for (const ref of refs) {
    if (ref.resolved === true && typeof ref.refName === 'string' && ref.refName) {
      names.set(JSON.stringify([ref.refKind, ref.refId]), ref.refName);
      continue;
    }
    if (!byKind.has(ref.refKind)) byKind.set(ref.refKind, new Set());
    byKind.get(ref.refKind).add(ref.refId);
  }
  const lookups = [...byKind].filter(([kind]) => REF_TARGET_TABLES[kind] || DERIVED_TARGETS[kind]).map(([kind, ids]) => {
    const target = REF_TARGET_TABLES[kind] || DERIVED_TARGETS[kind];
    return async () => {
      const { rows } = await exec(`SELECT id, ${REF_TITLE_SQL[kind]} AS name FROM ${target.table}
        WHERE id = ANY($1) AND ${target.liveClause}`, [[...ids]]);
      for (const row of rows) names.set(JSON.stringify([kind, row.id]), row.name || row.id);
    };
  });
  // A caller-supplied exec is a single transaction client, which cannot run
  // concurrent queries; only the default pool may fan out.
  if (exec === query) await Promise.all(lookups.map((run) => run()));
  else for (const run of lookups) await run();
  return refs.map((ref) => {
    const name = names.get(JSON.stringify([ref.refKind, ref.refId]));
    return { ...ref, refName: name || null, resolved: name !== undefined,
      ...(name === undefined ? { reason: REF_TARGET_TABLES[ref.refKind] || DERIVED_TARGETS[ref.refKind] ? 'missing-target' : 'unknown-kind' } : {}) };
  });
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
 * Distinct ids are probed with one `id = ANY($1)` query per refKind, run
 * concurrently; duplicates in the input reuse the result.
 */
export async function resolveRefs(tuples) {
  if (!Array.isArray(tuples) || tuples.length === 0) return [];
  const cache = new Map();
  const idsByKind = new Map();
  for (const t of tuples) {
    const refKind = t?.refKind;
    const refId = t?.refId;
    const key = cacheKey(refKind, refId);
    if (cache.has(key)) continue;
    if (!REF_TARGET_TABLES[refKind]) {
      cache.set(key, { resolved: false, reason: 'unknown-kind' });
    } else if (typeof refId !== 'string' || !refId) {
      cache.set(key, { resolved: false, reason: 'missing-ref-id' });
    } else {
      cache.set(key, { resolved: false, reason: 'missing-target' });
      if (!idsByKind.has(refKind)) idsByKind.set(refKind, new Set());
      idsByKind.get(refKind).add(refId);
    }
  }
  await Promise.all([...idsByKind].map(async ([refKind, ids]) => {
    const target = REF_TARGET_TABLES[refKind];
    const live = target.liveClause ? ` AND ${target.liveClause}` : '';
    const { rows } = await query(`SELECT id FROM ${target.table} WHERE id = ANY($1)${live}`, [[...ids]]);
    for (const row of rows) cache.set(cacheKey(refKind, row.id), { resolved: true });
  }));
  return tuples.map((t) => ({ refKind: t?.refKind, refId: t?.refId, ...cache.get(cacheKey(t?.refKind, t?.refId)) }));
}
