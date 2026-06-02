/**
 * PortOS schema-version contract for cross-instance sync.
 *
 * Two PortOS instances that exchange data (federated peer push, snapshot
 * sync, share-bucket manifests) need a way to detect a version mismatch
 * BEFORE applying records the receiver can't parse. Without this, an
 * upgraded sender silently corrupts a downstream peer whose code doesn't
 * yet understand a new storage layout.
 *
 * `PORTOS_SCHEMA_VERSIONS` is the per-sync-category WIRE contract — distinct
 * from the storage-layout version stamped on `data/{type}/index.json` (see
 * each service's local `TYPE_SCHEMA_VERSION` const). Bump the wire contract
 * for either:
 *   (a) a storage layout change (e.g. universes 4→5 splitting out of the
 *       monolithic JSON), OR
 *   (b) an additive record-shape change that a not-yet-upgraded peer would
 *       silently strip on round-trip (e.g. pipelineSeries 1→2 for the
 *       `series.arc.readerMap` field).
 * For (a) ship the corresponding `scripts/migrations/NNN-…js` to update the
 * stamped storage version too; for (b) the local storage layout stays put.
 * The number flows through every outbound payload's `portosMeta.schemaVersions`;
 * receivers compare incoming vs local and reject ahead-mismatches (sender too
 * new) or behind-mismatches (sender too old to satisfy a forward-only field).
 *
 * Absent categories default to 0 — the comparator treats 0 as "no check"
 * so historical / un-versioned data categories pass through unchanged.
 * Future PRs that introduce a layout change for `series`, `issues`, etc.
 * add an entry here.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { PATHS } from './fileUtils.js';

export const PORTOS_SCHEMA_VERSIONS = Object.freeze({
  // Type-level (storage layout) version for `data/universes/{id}/index.json`.
  // v5 = post-split. Migration 034 introduced it. The per-record-shape version
  // stays at 4 (stamped inside each record by `sanitizeTemplate`).
  universes: 5,
  // v1 = post-split. Migrations 035/036 introduced the pipeline collection
  // layout for issues and series.
  pipelineIssues: 1,
  // v2 = `series.arc.readerMap` added (Unified Story Builder). Additive +
  // gracefully-degrading, but version-gated so a not-yet-upgraded peer can't
  // round-trip a series through its readerMap-unaware sanitizer and LWW-strip
  // the field back onto a newer peer. Per-category gate → only series sync
  // pauses with old peers; issues/universes keep flowing.
  pipelineSeries: 2,
  // NOT bumped for the manuscript-review sibling doc now bundled on series
  // pushes/exports (`data/pipeline-series/{id}/manuscript-review.json`).
  // Unlike `readerMap` (v2), the review is NOT a field inside the series
  // record — it's a separate doc that rides a dedicated `manuscriptReview`
  // payload key, so an older peer never round-trips it through the series
  // sanitizer (no silent-strip-then-LWW-back corruption — the readerMap gate's
  // whole reason to exist). It is additive + gracefully degrading: a pre-feature
  // receiver ignores the unknown key (review just doesn't reach it) and ships
  // no review back, so the newer peer's `if (manuscriptReview)` receive guard
  // is a no-op and the local review is preserved. Bumping `pipelineSeries` here
  // would be actively harmful — it would 412-reject the ENTIRE series push
  // (record + issues) to every not-yet-upgraded peer over an OPTIONAL doc that
  // degrades fine. Registering a brand-new gated category would hit the same
  // whole-payload footgun documented for `videoHistory` below. So manuscript-
  // review is intentionally UNGATED today (all peers ship review-doc shape v1).
  // The FIRST incompatible review-doc shape change (manuscriptReview.js
  // SCHEMA_VERSION 1→2, where an older peer's sanitizer would strip a field and
  // LWW it back) MUST introduce a gate then — mirroring the catalog
  // payloadSchemaVersion lockstep note below.
  mediaCollections: 1,
  // v1 = creative ingredients catalog (Postgres tables: catalog_scraps,
  // catalog_ingredients, catalog_ingredient_sources, catalog_ingredient_refs).
  // v2 = `catalog_ingredients.search_tsv` expanded to also index the
  // character canon fields (physicalDescription, personality) and the
  // type-specific role/motivations/significance fields, so bible-promoted
  // characters become searchable on their main narrative text. The schema
  // is a DROP+re-ADD of the STORED generated column (Postgres can't ALTER
  // its expression); applied in lockstep by `ensureSchema`.
  // v3 = `catalog_ingredient_refs` gained `deleted`/`deleted_at` soft-delete
  // tombstones + an UPDATE trigger that bumps sync_sequence on delete/revive.
  // Older peers (≤v2) hard-DELETE on unlink and never tombstone, so the
  // version gate prevents a v3 receiver from accepting an older sender's
  // payload that would silently miss tombstones.
  //
  // Per-category gate so a new peer can sync its catalog independently of
  // whether other categories are version-locked. Older peers are
  // sender-behind on `catalog` (not ahead), so the receiver still accepts
  // their pushes; newer peers pushing to older receivers are sender-ahead
  // and get 412. `cat-ingredient` and `cat-scrap` record kinds map back
  // here via RECORD_KIND_SCHEMA_CATEGORIES.
  //
  // NOT bumped for the per-record `payload.schemaVersion` stamp added by
  // catalog-payload-schemaversion: that key is additive JSONB that both old
  // and new peers store verbatim (`upsertIngredientFromPeer` writes payload
  // as-is — no sanitizer strips it), and all types are payload-v1 today so no
  // shape actually changed on the wire. The FIRST type that bumps its
  // registry `payloadSchemaVersion` to 2 with a genuine shape change (a peer
  // ≤ that version would round-trip the new shape through an unaware
  // sanitizer) MUST bump `catalog` here in lockstep.
  //
  // v4 = `catalog_ingredient_relations` table (ingredient↔ingredient edges)
  // + a new `relations: [...]` block in the catalog sync envelope. An older
  // (≤v3) receiver doesn't understand the relations block, so a v4 sender
  // pushing to it is sender-ahead on `catalog` and gets a 412 — correct,
  // since the older peer would silently drop every relation edge. v4 receivers
  // still accept ≤v3 senders (sender-behind): those envelopes simply carry no
  // `relations` block and the receiver applies the other four kinds as before.
  // v5 = `catalog_tags` first-class table (id, label, description?, color?,
  // parent_id?, created_at, sync_sequence) + a new `tags: [...]` block in the
  // catalog sync envelope. Same gating rationale as v4: a ≤v4 receiver doesn't
  // understand the `tags` block, so a v5 sender pushing to it is sender-ahead
  // and gets a 412 (otherwise the older peer would silently drop every canonical
  // tag row + its parent hierarchy). The freeform `catalog_ingredients.tags
  // TEXT[]` column is unchanged — canonical tag rows are an additive index, so
  // a v5 receiver still accepts ≤v4 ingredient/scrap/ref/relation pushes; those
  // envelopes simply carry no `tags` block.
  // v6 = `catalog_ingredient_media` join table (typed image/audio/video/doc
  // attachments) + a new `media: [...]` block in the catalog sync envelope.
  // Each media row ships a `media_key` REFERENCE into the receiver's own media
  // library (data/images + history.jsonl sidecar) — never the bytes. Same
  // gating rationale as v4/v5: a ≤v5 receiver doesn't understand the `media`
  // block, so a v6 sender pushing to it is sender-ahead on `catalog` and gets
  // a 412 (otherwise the older peer would silently drop every attachment). A v6
  // receiver still accepts ≤v5 senders (sender-behind); those envelopes carry
  // no `media` block. Media keys that don't resolve against the receiver's own
  // library surface via the metadata-missing integrity endpoint rather than
  // failing the apply.
  // v7 = `catalog_scraps` gained `chunk_index` + `parent_scrap_id` (a long paste
  // chunks into a parent + N child rows; the extractor unions per-child drafts).
  // Both fields ride the scrap sync envelope. Same gating rationale as v4–v6: a
  // ≤v6 receiver doesn't understand child scrap rows, so a v7 sender pushing to
  // it is sender-ahead and gets a 412. A v7 receiver still accepts ≤v6 senders
  // (their scraps carry no chunk fields → chunkIndex 0 / parentScrapId null).
  // v8 = user-defined ingredient types. The definitions live in settings.json
  // (`catalogUserTypes`), merge into the active type registry at boot/runtime,
  // and ride a new additive `catalogTypes: [...]` block in the catalog sync
  // envelope (LWW-merged into the receiver's own settings slice). Same gating
  // rationale as v4–v7: a ≤v7 receiver doesn't understand the `catalogTypes`
  // block, so a v8 sender pushing to it is sender-ahead and gets a 412
  // (otherwise the older peer would silently drop every user-type definition,
  // then reject every ingredient row carrying one of those unknown types). A v8
  // receiver still accepts ≤v7 senders (sender-behind); their envelopes carry no
  // `catalogTypes` block and the receiver applies the other kinds as before.
  catalog: 8,
  // NOTE: `videoHistory` is intentionally NOT listed here. The version gate
  // rejects the ENTIRE snapshot/push payload on ANY ahead-mismatch (the
  // comparator walks the union of keys), so declaring a brand-new key would
  // make every not-yet-upgraded peer reject ALL categories (universe,
  // pipeline, …) — severing sync across a federation that upgrades on
  // independent schedules. videoHistory is a flat append-only array merged by
  // id with LWW-on-createdAt; the merge already tolerates unknown/extra rows,
  // so it does not need whole-payload gating. An older peer that lacks the
  // `videoHistory` route simply rejects that one category request and keeps
  // syncing everything else.
  //
  // The gate is now PER-CATEGORY (see `scopeVersionDiff` below + its three
  // call sites: dataSync `applyRemote`, peerSync push, sharing importer), so
  // adding a new key here or bumping one category only gates transfers of
  // THAT category — unrelated categories keep flowing. videoHistory stays
  // unlisted because it has no versioned storage layout at all, not because
  // of the old whole-payload footgun.
});

/**
 * Map a federated record KIND (the unit a peer push or share manifest moves)
 * to the `PORTOS_SCHEMA_VERSIONS` categories its storage layout touches. The
 * per-category gate uses this to block a transfer ONLY when the sender is
 * ahead on a category that record actually writes.
 *
 * Kinds absent from this map carry no versioned storage layout and are never
 * gated — media-job records (flat re-render metadata), media-annotations,
 * goals/character/digitalTwin/meatspace, videoHistory, etc. A `series` push
 * that bundles issues, or a universe/series push that bundles a linked media
 * collection, unions the additional kinds' categories at the call site.
 */
export const RECORD_KIND_SCHEMA_CATEGORIES = Object.freeze({
  universe: Object.freeze(['universes']),
  series: Object.freeze(['pipelineSeries']),
  issue: Object.freeze(['pipelineIssues']),
  mediaCollection: Object.freeze(['mediaCollections']),
  'cat-ingredient': Object.freeze(['catalog']),
  'cat-scrap': Object.freeze(['catalog']),
});

/**
 * Lazy-read the current PortOS version from the ROOT package.json so a
 * pull-and-restart picks it up without a process-relative cache.
 *
 * Tested-without-files fallback: when PATHS.root is mutated for a test to
 * a directory without package.json, return '0.0.0' instead of throwing.
 * Mirrors `getCurrentVersion` in `server/services/updateChecker.js`.
 */
export async function getPortosVersion() {
  const pkgPath = join(PATHS.root, 'package.json');
  const raw = await readFile(pkgPath, 'utf-8').catch(() => null);
  if (!raw) return '0.0.0';
  const parsed = (() => { try { return JSON.parse(raw); } catch { return null; } })();
  return typeof parsed?.version === 'string' && parsed.version ? parsed.version : '0.0.0';
}

/**
 * Build the `portosMeta` envelope that every outbound sync payload carries
 * at the top level. Receivers feed `meta.schemaVersions` into
 * `compareSchemaVersions(sender, PORTOS_SCHEMA_VERSIONS)` to decide whether
 * to apply the payload.
 *
 *   {
 *     "portosMeta": {
 *       "portosVersion": "2.7.0",
 *       "schemaVersions": { "universes": 5 }
 *     }
 *   }
 *
 * `portosVersion` is informational — for UI surfacing only. The gate logic
 * runs on `schemaVersions` because the on-disk shape is what matters; the
 * PortOS version is just a friendly label users recognize.
 */
export async function buildPortosMeta(overrides = {}) {
  const portosVersion = await getPortosVersion();
  return {
    portosVersion,
    schemaVersions: { ...PORTOS_SCHEMA_VERSIONS, ...(overrides.schemaVersions || {}) },
  };
}

/**
 * Compare a peer's schemaVersions against the local code's expectations.
 *
 * Returns a structured diff so callers (push-rejection, UI surfacing) can
 * tell users WHICH category is mismatched and in which direction.
 *
 *   ahead[]  — categories where the SENDER has a newer schema than the
 *              RECEIVER. The receiver can't safely apply the payload; reject.
 *   behind[] — categories where the SENDER is older than the receiver. The
 *              sanitizer can usually backfill, but some forward-only
 *              contracts may still require the sender to upgrade. Callers
 *              decide whether to gate.
 *
 *   compatible — `true` only when neither list has entries.
 *
 * Absent or zero entries on either side are treated as "no contract" — the
 * comparator skips them. So legacy peers that don't send `portosMeta` at
 * all simply pass through (treat their schemaVersions as `{}` → no
 * `ahead` entries → compatible).
 */
export function compareSchemaVersions(senderVersions = {}, receiverVersions = PORTOS_SCHEMA_VERSIONS) {
  const sender = senderVersions && typeof senderVersions === 'object' ? senderVersions : {};
  const receiver = receiverVersions && typeof receiverVersions === 'object' ? receiverVersions : {};
  const ahead = [];
  const behind = [];
  // Walk the UNION of keys so we catch (a) sender has a category receiver
  // doesn't know (sender ahead), AND (b) receiver requires a category the
  // sender doesn't carry (sender behind on that category).
  const keys = new Set([
    ...Object.keys(sender),
    ...Object.keys(receiver),
  ]);
  for (const cat of keys) {
    const senderV = Number.isInteger(sender[cat]) ? sender[cat] : 0;
    const receiverV = Number.isInteger(receiver[cat]) ? receiver[cat] : 0;
    if (senderV === 0 && receiverV === 0) continue;          // no contract on either side
    if (senderV === receiverV) continue;                      // exact match
    if (senderV > receiverV) ahead.push({ category: cat, senderV, receiverV });
    else behind.push({ category: cat, senderV, receiverV });
  }
  return { ahead, behind, compatible: ahead.length === 0 && behind.length === 0 };
}

/**
 * Restrict a comparator result to the categories actually being transferred.
 *
 * `compareSchemaVersions` walks the UNION of every known category so the full
 * diff stays useful for diagnostics/UI. But the GATE decision must be
 * per-category: a sender that bumped (or added) one category should only be
 * blocked for transfers of THAT category — not for unrelated categories that
 * happen to ride a federation upgrading on independent schedules. Pass the
 * schema-version keys this transfer actually moves; categories outside the
 * set are dropped from `ahead`/`behind` so they can't block (and the scoped
 * `ahead` is what callers report, so a "pipeline" snapshot rejection never
 * mis-attributes a `universes` gap).
 *
 * `categories` non-array (null/undefined) → returns the diff unchanged
 * (whole-payload gate; the comparator's union result is used as-is). An empty
 * array → nothing can block (the transfer touches no versioned category).
 */
export function scopeVersionDiff(diff = {}, categories) {
  if (!Array.isArray(categories)) return diff;
  const allow = new Set(categories);
  const ahead = (Array.isArray(diff.ahead) ? diff.ahead : []).filter((g) => allow.has(g.category));
  const behind = (Array.isArray(diff.behind) ? diff.behind : []).filter((g) => allow.has(g.category));
  return { ahead, behind, compatible: ahead.length === 0 && behind.length === 0 };
}

/**
 * Human-readable explanation of a comparator result. Used both for log lines
 * and for the UI badge tooltip. Keeps the wording in one place so a peer-
 * sync 409 message, the Instances UI, and the share-bucket panel all
 * describe the gap identically.
 *
 *   formatVersionGap({ ahead: [{ category: 'universes', senderV: 5, receiverV: 4 }] })
 *     → 'sender ahead of receiver on universes (v5 vs v4)'
 */
export function formatVersionGap({ ahead = [], behind = [] } = {}) {
  const parts = [];
  if (ahead.length) {
    parts.push(`sender ahead of receiver on ${ahead.map((g) => `${g.category} (v${g.senderV} vs v${g.receiverV})`).join(', ')}`);
  }
  if (behind.length) {
    parts.push(`sender behind receiver on ${behind.map((g) => `${g.category} (v${g.senderV} vs v${g.receiverV})`).join(', ')}`);
  }
  return parts.join('; ') || 'compatible';
}
