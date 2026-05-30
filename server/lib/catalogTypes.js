/**
 * Creative Ingredients Catalog — shared TYPE REGISTRY.
 *
 * Single source of truth for the catalog's ingredient types. Every place that
 * used to hard-code the six types (`catalogValidation.js` Zod enum,
 * `catalogExtraction.js` light-shape sanitizer, `catalogDB.js` ID prefix +
 * type guard, the `db.js` / init-db.sql CHECK constraint + FTS field set, and
 * the three client surfaces) now derives from this one list.
 *
 * Adding a new type becomes: one registry entry here (+ a mirrored client
 * entry in `client/src/lib/catalogTypes.js`), one editor field list, and one
 * migration that loosens the CHECK constraint. The validation enum, extraction
 * prompt slot, ID prefix, and FTS field set all pick the new type up
 * automatically.
 *
 * NOTE on the CHECK constraint: this registry SOURCES the allowed values for
 * the `catalog_ingredients.type` CHECK in db.js, but the DROP/re-ADD of the
 * constraint itself is the gated [catalog-type-table-vs-check] PLAN item.
 * Today the CHECK still lists the six types literally in init-db.sql + db.js —
 * `INGREDIENT_TYPE_IDS` is what those literals must equal (asserted by
 * `db.catalogDdlParity.test.js`).
 *
 * Per-type `payloadSchemaVersion` + `payloadUpgraders`: the JSONB `payload`
 * carries `payload.schemaVersion` stamped at create time (see
 * `catalogDB.createIngredient`). When a type's payload shape evolves, bump
 * `payloadSchemaVersion` and register an upgrader keyed by the FROM version;
 * `server/scripts/migrateCatalogPayload.js` walks rows below the current
 * version and applies the chain. Distinct from the cross-instance sync
 * contract (`PORTOS_SCHEMA_VERSIONS.catalog`) and from the storage-layout
 * version — this is the per-record payload-shape version.
 */

import { BIBLE_LIMITS } from './storyBible.js';

/**
 * One entry per ingredient type. Shape:
 *   id                     — catalog `type` discriminator (column value).
 *   label                  — human label (chips, badges, form options).
 *   idPrefix               — short token in `cat-<prefix>-<uuid>` ids.
 *   badgeColor             — Tailwind class string for the type chip/badge
 *                            (mirrored verbatim on the client).
 *   primaryContentKey      — payload key the inline "New" form writes the body
 *                            into (where the type's main prose lives).
 *   primaryContentLabel    — label for that field in the inline form.
 *   snippetFallbackKeys    — ordered payload keys the list/picker snippet pulls
 *                            from (first non-empty wins).
 *   ftsFields              — payload keys folded into the weighted FTS column.
 *   extractionShape        — 'bible' (runs through extractBible) or 'light'
 *                            (the bundled ideas/scenes/concepts LLM stage).
 *   payloadSchemaVersion   — current per-record payload-shape version.
 *   payloadUpgraders       — { <fromVersion>: (payload) => payload } chain.
 *   defaultTags            — canonical tag labels seeded onto every freshly-
 *                            created ingredient of this type (optional). Used by
 *                            the tag-normalization step so a new `scene` row
 *                            picks up `scene` etc. without the user typing it.
 */
const REGISTRY = [
  {
    id: 'character',
    label: 'Character',
    idPrefix: 'chr',
    badgeColor: 'bg-blue-500/20 text-blue-300 border-blue-500/40',
    primaryContentKey: 'physicalDescription',
    primaryContentLabel: 'Physical Description',
    snippetFallbackKeys: ['physicalDescription', 'description', 'summary', 'personality', 'significance', 'role', 'notes'],
    ftsFields: ['description', 'physicalDescription', 'personality', 'background', 'summary', 'notes', 'role', 'motivations', 'significance'],
    extractionShape: 'bible',
    payloadSchemaVersion: 1,
    payloadUpgraders: {},
    defaultTags: [],
  },
  {
    id: 'place',
    label: 'Place',
    idPrefix: 'plc',
    badgeColor: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
    primaryContentKey: 'description',
    primaryContentLabel: 'Description',
    snippetFallbackKeys: ['description', 'summary', 'significance', 'notes'],
    ftsFields: [],
    extractionShape: 'bible',
    payloadSchemaVersion: 1,
    payloadUpgraders: {},
    defaultTags: [],
  },
  {
    id: 'object',
    label: 'Object',
    idPrefix: 'obj',
    badgeColor: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
    primaryContentKey: 'description',
    primaryContentLabel: 'Description',
    snippetFallbackKeys: ['description', 'significance', 'summary', 'notes'],
    ftsFields: [],
    extractionShape: 'bible',
    payloadSchemaVersion: 1,
    payloadUpgraders: {},
    defaultTags: [],
  },
  {
    id: 'idea',
    label: 'Idea',
    idPrefix: 'idea',
    badgeColor: 'bg-purple-500/20 text-purple-300 border-purple-500/40',
    primaryContentKey: 'summary',
    primaryContentLabel: 'Summary',
    snippetFallbackKeys: ['summary', 'description', 'notes'],
    ftsFields: [],
    extractionShape: 'light',
    payloadSchemaVersion: 1,
    payloadUpgraders: {},
    defaultTags: [],
  },
  {
    id: 'scene',
    label: 'Scene',
    idPrefix: 'scn',
    badgeColor: 'bg-pink-500/20 text-pink-300 border-pink-500/40',
    primaryContentKey: 'summary',
    primaryContentLabel: 'Summary',
    snippetFallbackKeys: ['summary', 'description', 'notes'],
    ftsFields: [],
    extractionShape: 'light',
    payloadSchemaVersion: 1,
    payloadUpgraders: {},
    defaultTags: [],
  },
  {
    id: 'concept',
    label: 'Concept',
    idPrefix: 'cnc',
    badgeColor: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40',
    primaryContentKey: 'summary',
    primaryContentLabel: 'Summary',
    snippetFallbackKeys: ['summary', 'description', 'notes'],
    ftsFields: [],
    extractionShape: 'light',
    payloadSchemaVersion: 1,
    payloadUpgraders: {},
    defaultTags: [],
  },
];

// Fail-fast guards at module load — a bad/duplicate registry entry blocks
// server boot instead of silently breaking validation / extraction / DDL.
const seenIds = new Set();
const seenPrefixes = new Set();
for (const t of REGISTRY) {
  if (!t.id || typeof t.id !== 'string') throw new Error(`catalogTypes: entry missing id`);
  if (seenIds.has(t.id)) throw new Error(`catalogTypes: duplicate type id "${t.id}"`);
  seenIds.add(t.id);
  if (!t.idPrefix) throw new Error(`catalogTypes: "${t.id}" missing idPrefix`);
  if (seenPrefixes.has(t.idPrefix)) throw new Error(`catalogTypes: duplicate idPrefix "${t.idPrefix}"`);
  seenPrefixes.add(t.idPrefix);
  if (!t.primaryContentKey) throw new Error(`catalogTypes: "${t.id}" missing primaryContentKey`);
  if (!Array.isArray(t.snippetFallbackKeys) || t.snippetFallbackKeys.length === 0) {
    throw new Error(`catalogTypes: "${t.id}" missing snippetFallbackKeys`);
  }
  if (!Number.isInteger(t.payloadSchemaVersion) || t.payloadSchemaVersion < 1) {
    throw new Error(`catalogTypes: "${t.id}" payloadSchemaVersion must be a positive integer`);
  }
  if (t.payloadUpgraders && typeof t.payloadUpgraders !== 'object') {
    throw new Error(`catalogTypes: "${t.id}" payloadUpgraders must be an object`);
  }
  if (t.defaultTags !== undefined && !Array.isArray(t.defaultTags)) {
    throw new Error(`catalogTypes: "${t.id}" defaultTags must be an array`);
  }
}

export const CATALOG_TYPES = Object.freeze(REGISTRY.map((t) => Object.freeze({ ...t })));

/** Frozen ordered list of type ids — the canonical `INGREDIENT_TYPES`. */
export const INGREDIENT_TYPE_IDS = Object.freeze(CATALOG_TYPES.map((t) => t.id));

const BY_ID = Object.freeze(Object.fromEntries(CATALOG_TYPES.map((t) => [t.id, t])));

/** Look up a registry entry by type id. Returns `undefined` for unknown ids. */
export function getCatalogType(id) {
  return BY_ID[id];
}

/** Mint the `cat-<prefix>-<uuid>` id for a type, or throw on unknown type. */
export function ingredientIdPrefix(id) {
  const t = BY_ID[id];
  if (!t) throw new Error(`Unknown ingredient type: ${id}`);
  return t.idPrefix;
}

/**
 * Ordered, de-duplicated payload field set folded into the weighted FTS
 * column. Today only `character` declares `ftsFields` (matching the v2 search
 * expansion); the union here is what `db.js` / `init-db.sql` must index.
 */
export const FTS_PAYLOAD_FIELDS = Object.freeze((() => {
  const out = [];
  for (const t of CATALOG_TYPES) {
    for (const f of t.ftsFields || []) {
      if (!out.includes(f)) out.push(f);
    }
  }
  return out;
})());

/** Current payload-shape version for a type (1 when the type declares none). */
export function currentPayloadSchemaVersion(id) {
  return BY_ID[id]?.payloadSchemaVersion ?? 1;
}

/**
 * Registry-declared default tags for a type — seeded onto a freshly-created
 * ingredient so e.g. a new `scene` row picks up its type's default tags
 * automatically. Returns a fresh array (never the frozen registry array) so a
 * caller can mutate/merge without poisoning the registry. Unknown type → `[]`.
 */
export function defaultTagsForType(id) {
  return [...(BY_ID[id]?.defaultTags || [])];
}

// --- Tag taxonomy --------------------------------------------------------
// `catalog_tags` promotes the freeform `catalog_ingredients.tags TEXT[]` to a
// first-class table (id, label, description?, color?, parent_id?). The freeform
// column stays for write-path simplicity; the normalizer below maps user input
// through a canonical KEY so `Noir` / `noir` / ` noir ` collapse to one row.

/** Mint the `cat-tag-<slug>` deterministic id for a canonical tag key. */
export function tagIdForKey(key) {
  return `cat-tag-${key}`;
}

/**
 * Canonical key for a freeform tag label — the dedup discriminant for the
 * `catalog_tags` table. Lowercase + trim + collapse internal whitespace to a
 * single space. This intentionally does NOT fold `noir` and `film-noir` into
 * one (that's a synonym judgment the user makes via `parent_id`), but it DOES
 * collapse `Noir`, `noir`, and `  noir ` so casing/whitespace variants don't
 * accumulate as separate rows. Returns `''` for empty/non-string input so the
 * caller can drop it.
 */
export function canonicalTagKey(label) {
  if (typeof label !== 'string') return '';
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Catalog ingredient↔ingredient RELATION kinds.
 *
 * Drives the `catalog_ingredient_relations.kind` column (an app-layer enum, not
 * a DB CHECK — same loosening rationale as the type CHECK discussion above) and
 * the "Relations" panel on the ingredient detail page. Mirrored on the client
 * at `client/src/lib/catalogTypes.js` (drift asserted by the client test).
 *
 * Each entry:
 *   id      — the stored `kind` discriminator.
 *   label   — human label for the relation chip / picker option (the active
 *             "from → to" direction).
 *   inverseLabel — label shown when the relation is viewed from the `to` side
 *             (the inbound direction), so a single stored edge reads correctly
 *             from both ingredients' detail pages.
 */
const RELATION_REGISTRY = [
  { id: 'appears-in',  label: 'Appears in',  inverseLabel: 'Features' },
  { id: 'lives-in',    label: 'Lives in',    inverseLabel: 'Home of' },
  { id: 'created-by',  label: 'Created by',  inverseLabel: 'Creator of' },
  { id: 'parent-of',   label: 'Parent of',   inverseLabel: 'Child of' },
  { id: 'variant-of',  label: 'Variant of',  inverseLabel: 'Has variant' },
  { id: 'references',  label: 'References',   inverseLabel: 'Referenced by' },
  { id: 'related-to',  label: 'Related to',  inverseLabel: 'Related to' },
];

// Fail-fast at module load — duplicate / malformed relation kinds block boot.
const seenRelationIds = new Set();
for (const r of RELATION_REGISTRY) {
  if (!r.id || typeof r.id !== 'string') throw new Error('catalogTypes: relation entry missing id');
  if (seenRelationIds.has(r.id)) throw new Error(`catalogTypes: duplicate relation kind "${r.id}"`);
  seenRelationIds.add(r.id);
  if (!r.label) throw new Error(`catalogTypes: relation "${r.id}" missing label`);
}

export const RELATION_KINDS = Object.freeze(RELATION_REGISTRY.map((r) => Object.freeze({ ...r })));

/** Frozen ordered list of relation kind ids — the canonical enum source. */
export const RELATION_KIND_IDS = Object.freeze(RELATION_KINDS.map((r) => r.id));

const RELATION_BY_ID = Object.freeze(Object.fromEntries(RELATION_KINDS.map((r) => [r.id, r])));

/** Look up a relation-kind entry by id. Returns `undefined` for unknown ids. */
export function getRelationKind(id) {
  return RELATION_BY_ID[id];
}

/**
 * Catalog ingredient MEDIA-attachment kinds. An ingredient can carry typed
 * media references (a generated portrait, a mood/reference image, a recorded
 * voice memo, …) that point at the install's media library by `media_key` —
 * the bytes are never duplicated into the catalog. `label` drives the attach
 * picker; `accept` is the file-input MIME filter for drag-and-drop. The
 * `portrait` kind is special-cased by `setPortraitMedia` (one active portrait
 * per ingredient; attaching a new one demotes the prior). Client mirror lives
 * in `client/src/lib/catalogTypes.js` (drift asserted by the type tests).
 */
const MEDIA_KIND_REGISTRY = [
  { id: 'portrait', label: 'Portrait', accept: 'image/*' },
  { id: 'reference', label: 'Reference', accept: 'image/*' },
  { id: 'audio', label: 'Audio', accept: 'audio/*' },
  { id: 'video', label: 'Video', accept: 'video/*' },
  { id: 'document', label: 'Document', accept: '.pdf,.txt,.md' },
];

// Fail-fast at module load — duplicate / malformed media kinds block boot.
const seenMediaIds = new Set();
for (const m of MEDIA_KIND_REGISTRY) {
  if (!m.id || typeof m.id !== 'string') throw new Error('catalogTypes: media entry missing id');
  if (seenMediaIds.has(m.id)) throw new Error(`catalogTypes: duplicate media kind "${m.id}"`);
  seenMediaIds.add(m.id);
  if (!m.label) throw new Error(`catalogTypes: media "${m.id}" missing label`);
}

export const MEDIA_KINDS = Object.freeze(MEDIA_KIND_REGISTRY.map((m) => Object.freeze({ ...m })));

/** Frozen ordered list of media kind ids — the canonical enum source. */
export const MEDIA_KIND_IDS = Object.freeze(MEDIA_KINDS.map((m) => m.id));

const MEDIA_BY_ID = Object.freeze(Object.fromEntries(MEDIA_KINDS.map((m) => [m.id, m])));

/** Look up a media-kind entry by id. Returns `undefined` for unknown ids. */
export function getMediaKind(id) {
  return MEDIA_BY_ID[id];
}

/**
 * Run a payload through its registered upgrader chain up to the current
 * version. Each upgrader is keyed by the FROM version. Returns the upgraded
 * payload with `schemaVersion` stamped to current. A row at-or-above current
 * is returned unchanged (the chain is forward-only).
 */
export function upgradePayload(id, payload = {}) {
  const t = BY_ID[id];
  if (!t) return payload;
  const target = t.payloadSchemaVersion;
  let p = payload && typeof payload === 'object' ? { ...payload } : {};
  let v = Number.isInteger(p.schemaVersion) ? p.schemaVersion : 1;
  while (v < target) {
    const upgrader = t.payloadUpgraders?.[v];
    if (typeof upgrader !== 'function') {
      // No upgrader for this step — stamp to target and stop. A type that
      // bumps its version without registering the intermediate upgrader still
      // gets its rows marked current rather than re-walked forever.
      break;
    }
    p = upgrader(p) || p;
    v += 1;
  }
  p.schemaVersion = target;
  return p;
}

// TAG limit re-exported so the catalog validation module can keep one import
// surface (registry + limits) without a second import line in callers that
// already pull from here. Sourced from BIBLE_LIMITS so it stays in lockstep.
export const CATALOG_TAG_MAX = BIBLE_LIMITS.TAG_MAX;
