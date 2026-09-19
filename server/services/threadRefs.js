/**
 * Thread ref RESOLUTION — `(kind, id)` → `{ label, url, state }` (#7664).
 *
 * A Brain *thread* is a tracked topic or commitment (an open loop), NOT a
 * message thread — see server/lib/threadRefKinds.js for that distinction.
 *
 * This is the service half of the ref registry: `threadRefKinds.js` owns the
 * pure vocabulary and route table (and is re-exported to the client), this file
 * owns the existence/title lookups that need a store. The split is forced —
 * `server/lib` may not import upward into `server/services`.
 *
 * Modelled on `catalogRefResolver.resolveRefs`: batch, dedupe by a
 * JSON-stringified `(kind, id)` cache key, and DEGRADE an unresolvable ref to
 * `{ resolved: false, reason }` rather than throwing or dropping it — a ref can
 * name a kind this build does not know (a peer on newer code synced the thread)
 * or a target that was deleted, and a thread must still render.
 *
 * Sentinel discipline (AGENTS.md): `resolved: false` means this build genuinely
 * established the target is unknown or gone. A store that is unreachable is NOT
 * that — its error bubbles, so "the database was down" can never be recorded as
 * "the target was deleted".
 *
 * Import scoping: only the two stores most refs land in (the Brain collection
 * stores and Postgres) are static imports. The single-kind resolvers reach their
 * service through a lazy `await import()` so a thread list that references no
 * goal never instantiates the goals module — see "Import scoping" in
 * server/AGENTS.md.
 */

import { query } from '../lib/db.js';
import * as brainStorage from './brainStorage.js';
import {
  THREAD_REF_KINDS,
  canonicalThreadRefKind,
  threadRefLabel,
  threadRefUrl,
} from '../lib/threadRefKinds.js';

// ─── Brain-backed kinds ──────────────────────────────────────────────────────
// kind → the BRAIN_ENTITY_TYPES store its id lives in. People and projects key
// their display string off `name`; everything else off `title`.
const BRAIN_REF_TYPES = Object.freeze({
  'brain.idea': 'ideas',
  'brain.project': 'projects',
  'brain.person': 'people',
  'brain.admin': 'admin',
  'brain.memory': 'memories',
  'brain.link': 'links',
  'brain.journal': 'journals',
  'brain.song': 'songs',
});

// ─── Postgres-backed kinds ───────────────────────────────────────────────────
// kind → `{ table, titleExpr, liveClause }`. `titleExpr` is a SQL expression,
// not a bare column, because several of these keep their display name inside
// the record's `data` JSONB rather than in a column of its own. Every one of
// these tables soft-deletes, so a live target is `deleted = FALSE` throughout —
// the same predicate catalogRefResolver's REF_TARGET_TABLES uses.
const DB_REF_TABLES = Object.freeze({
  universe: { table: 'universes', titleExpr: 'name', liveClause: 'deleted = FALSE' },
  series: { table: 'pipeline_series', titleExpr: 'name', liveClause: 'deleted = FALSE' },
  issue: { table: 'pipeline_issues', titleExpr: "COALESCE(NULLIF(data->>'title', ''), 'Issue ' || COALESCE(number::text, id))", liveClause: 'deleted = FALSE' },
  'writers-room': { table: 'writers_room_works', titleExpr: 'title', liveClause: 'deleted = FALSE' },
  'creative-director': { table: 'creative_director_projects', titleExpr: "NULLIF(data->>'title', '')", liveClause: 'deleted = FALSE' },
  'catalog.ingredient': { table: 'catalog_ingredients', titleExpr: 'name', liveClause: 'deleted = FALSE', contextExpr: 'type' },
  'catalog.scrap': { table: 'catalog_scraps', titleExpr: "NULLIF(title, '')", liveClause: 'deleted = FALSE' },
});

// ─── Single-kind resolvers ───────────────────────────────────────────────────
// Each returns `{ title }` for a live target, or `null` when it is gone. Lazily
// imported so a thread set that never references one costs nothing.
const SERVICE_REF_LOOKUPS = Object.freeze({
  goal: async (id) => {
    const { getGoals } = await import('./identity/goals.js');
    const { goals } = await getGoals();
    const goal = (goals || []).find((g) => g?.id === id);
    return goal ? { title: goal.title } : null;
  },
  app: async (id) => {
    const { getAppById } = await import('./apps.js');
    const app = await getAppById(id);
    return app ? { title: app.name || app.id } : null;
  },
  message: async (id) => {
    const { getMessage } = await import('./messageSync.js');
    // A message is addressed by (accountId, messageId); the ref packs both as
    // `<accountId>:<messageId>`. Split on the FIRST colon only — a provider
    // message id may itself contain one.
    const separator = id.indexOf(':');
    if (separator <= 0) return null;
    const message = await getMessage(id.slice(0, separator), id.slice(separator + 1));
    return message ? { title: message.subject || message.snippet || message.id } : null;
  },
  'cos.task': async (id) => {
    const { getTaskById } = await import('./cosTaskStore.js');
    const task = await getTaskById(id);
    return task ? { title: task.text || task.title || task.id } : null;
  },
});

// Every kind THREAD_REF_KINDS calls internal must appear in exactly one of the
// three lookup groups. `threadRefs.drift.test.js` asserts that; this derived set
// is what it checks against (and what `hasThreadRefResolver` answers from).
export const RESOLVABLE_THREAD_REF_KINDS = Object.freeze([
  ...Object.keys(BRAIN_REF_TYPES),
  ...Object.keys(DB_REF_TABLES),
  ...Object.keys(SERVICE_REF_LOOKUPS),
]);

/** Does this build know how to look up a target of this kind? */
export function hasThreadRefResolver(kind) {
  return RESOLVABLE_THREAD_REF_KINDS.includes(canonicalThreadRefKind(kind));
}

// Cache key for one (kind, id) pair. JSON-stringify so the two fields join on an
// unambiguous printable delimiter no id can forge — catalogRefResolver's rule.
const cacheKey = (kind, id) => JSON.stringify([kind, id]);

// The display string for a resolved target, preferring what the target actually
// says over the ref's cached copy (which can be stale) over the kind's label
// (which is at least never empty).
const displayLabel = (targetTitle, cachedLabel, kind) => {
  if (typeof targetTitle === 'string' && targetTitle.trim()) return targetTitle.trim();
  if (typeof cachedLabel === 'string' && cachedLabel.trim()) return cachedLabel.trim();
  return threadRefLabel(kind);
};

async function lookupTarget(kind, id) {
  const brainType = BRAIN_REF_TYPES[kind];
  if (brainType) {
    const record = await brainStorage.getById(brainType, id);
    if (!record) return null;
    // A journal record is keyed by its date and carries no title of its own.
    return { title: record.title || record.name || (brainType === 'journals' ? id : '') };
  }

  const table = DB_REF_TABLES[kind];
  if (table) {
    const context = table.contextExpr ? `, ${table.contextExpr} AS context` : '';
    const { rows } = await query(
      `SELECT ${table.titleExpr} AS title${context} FROM ${table.table} WHERE id = $1 AND ${table.liveClause}`,
      [id],
    );
    if (rows.length === 0) return null;
    return { title: rows[0].title, context: rows[0].context };
  }

  const lookup = SERVICE_REF_LOOKUPS[kind];
  return lookup ? lookup(id) : null;
}

/**
 * Hydrate a thread's `refs` array for display.
 *
 * Returns one entry per INPUT ref, in input order, never fewer — a caller
 * rendering chips must be able to show every ref the record holds, including
 * the broken ones:
 *
 *   `{ kind, id, label, url, state: 'live', resolved: true }`      internal, found
 *   `{ kind, id, label, url, state: 'unknown', resolved: true }`   external (not probed)
 *   `{ kind, id, label, url: null, resolved: false, reason }`      unknown-kind /
 *                                                                  missing-ref-id /
 *                                                                  missing-target /
 *                                                                  unsafe-url
 *
 * Distinct (kind, id) pairs are probed once each; duplicates reuse the result.
 * A thread's ref set is bounded at 100, so per-tuple probes are fine.
 */
export async function resolveThreadRefs(refs) {
  if (!Array.isArray(refs) || refs.length === 0) return [];
  const cache = new Map();
  const out = [];

  for (const ref of refs) {
    const kind = canonicalThreadRefKind(ref?.kind);
    const id = ref?.id;
    const key = cacheKey(kind, id);

    if (!cache.has(key)) {
      const spec = THREAD_REF_KINDS[kind];
      if (!spec) {
        cache.set(key, { resolved: false, reason: 'unknown-kind', url: null });
      } else if (typeof id !== 'string' || !id) {
        cache.set(key, { resolved: false, reason: 'missing-ref-id', url: null });
      } else if (spec.external) {
        // Nothing local to probe. The id IS the URL, so the only failure mode is
        // an id that must never become an href.
        const url = threadRefUrl(kind, id);
        cache.set(key, url
          ? { resolved: true, state: 'unknown', url, title: '' }
          : { resolved: false, reason: 'unsafe-url', url: null });
      } else {
        const target = await lookupTarget(kind, id);
        cache.set(key, target
          ? { resolved: true, state: 'live', url: threadRefUrl(kind, id, { catalogType: target.context }), title: target.title }
          : { resolved: false, reason: 'missing-target', url: null });
      }
    }

    const hit = cache.get(key);
    out.push({
      kind,
      id,
      label: displayLabel(hit.title, ref?.label, kind),
      kindLabel: threadRefLabel(kind),
      ...(hit.resolved
        ? { url: hit.url, state: hit.state, resolved: true }
        : { url: null, resolved: false, reason: hit.reason }),
    });
  }

  return out;
}
