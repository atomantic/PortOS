/**
 * Client mirror of `server/lib/catalogTypes.js` — the catalog ingredient type
 * registry. The server registry carries extra server-only fields (idPrefix,
 * ftsFields, payloadSchemaVersion, payloadUpgraders); the client mirror keeps
 * only what the UI renders: label, badge color, the inline-form primary
 * content key/label, the snippet fallback chain, and the per-type editor field
 * list.
 *
 * Drift is asserted by `server/lib/catalogTypes.parity.test.js` against the
 * server registry's shared fields — if you change one side, change the other.
 *
 * Adding a type: add an entry here AND in the server registry (+ one migration
 * loosening the CHECK constraint). The Catalog list/picker/inline-form, the
 * detail editor, and the type chips all map over `CATALOG_TYPES` so the new
 * type surfaces everywhere without a per-surface edit.
 */

// Per-type detail-editor field list. Each entry is `[key, label, kind]` where
// `kind` is 'text' (single line) or 'textarea' (multi-line). The light types
// (idea/scene/concept) share LIGHT_FIELDS.
const LIGHT_FIELDS = [
  ['summary',     'Summary',     'textarea'],
  ['description', 'Description', 'textarea'],
  ['notes',       'Notes',       'textarea'],
];

// Grouped "character sheet" layout for the rich canon types
// (character/place/object). Each section is `{ title, fields }` where `fields`
// is the same `[key, label, kind]` tuple list as `editorFields`. The CatalogIngredient
// detail editor renders `editorSections` as collapsible DnD-style sheet
// sections when present, and falls back to the flat `editorFields` list for
// the light types. The keys mirror the canon sanitizers in
// `server/lib/storyBible.js` (`sanitizeCharacter`/`sanitizePlace`/`sanitizeObject`)
// EXACTLY so an edit on the Catalog surface lands in the same payload field the
// Universe Builder canon surface reads — the two are the same durable record.
//
// Complex array fields (stats[], colorPalette[], props[], expressions[],
// handGestures[], wardrobes[], imageRefs[]) are intentionally NOT in these
// scalar sections — they are surfaced read-only by the sheet (see
// CHARACTER_LIST_FIELDS / CHARACTER_IMAGE_FIELDS) and remain editable on the
// Universe Builder canon surface where their structured editors live.
const CHARACTER_SECTIONS = [
  {
    title: 'Identity',
    fields: [
      ['role',          'Role / Archetype',  'text'],
      ['pronouns',      'Pronouns',          'text'],
      ['age',           'Age',               'text'],
      ['coreTheme',     'Core Theme',        'text'],
    ],
  },
  {
    title: 'Appearance',
    fields: [
      ['physicalDescription', 'Physical Description', 'textarea'],
      ['visualNotes',         'Visual Notes',         'textarea'],
      ['visualIdentity',      'Visual Identity',      'textarea'],
      ['silhouetteNotes',     'Silhouette Notes',     'textarea'],
      ['postureNotes',        'Posture Notes',        'textarea'],
      ['specialTraits',       'Special Traits',       'textarea'],
    ],
  },
  {
    title: 'Personality & Voice',
    fields: [
      ['personality',   'Personality',     'textarea'],
      ['mannerisms',    'Mannerisms',      'textarea'],
      ['speechAccent',  'Speech Accent',   'text'],
      ['speechPattern', 'Speech Pattern',  'textarea'],
    ],
  },
  {
    title: 'Goals & Drives',
    fields: [
      ['motivations',   'Motivations / Goals', 'textarea'],
      ['likes',         'Likes',               'textarea'],
      ['dislikes',      'Dislikes / Fears',    'textarea'],
    ],
  },
  {
    title: 'Background & Relationships',
    fields: [
      ['background',    'Background',    'textarea'],
      ['relationships', 'Relationships', 'textarea'],
      ['skills',        'Skills / Abilities', 'textarea'],
    ],
  },
  {
    title: 'Notes',
    fields: [
      ['notes', 'Notes', 'textarea'],
    ],
  },
];

const PLACE_SECTIONS = [
  {
    title: 'Identity',
    fields: [
      ['slugline', 'Slugline', 'text'],
      ['era',      'Era',      'text'],
      ['weather',  'Weather',  'text'],
    ],
  },
  {
    title: 'Appearance',
    fields: [
      ['description',      'Description',       'textarea'],
      ['palette',          'Color Palette',     'textarea'],
      ['recurringDetails', 'Recurring Details', 'textarea'],
    ],
  },
  {
    title: 'Notes',
    fields: [
      ['notes', 'Notes', 'textarea'],
    ],
  },
];

const OBJECT_SECTIONS = [
  {
    title: 'Identity',
    fields: [
      ['description',  'Description',  'textarea'],
    ],
  },
  {
    title: 'Significance',
    fields: [
      ['significance', 'Significance', 'textarea'],
    ],
  },
  {
    title: 'Notes',
    fields: [
      ['notes', 'Notes', 'textarea'],
    ],
  },
];

// Flatten a section list back into the legacy `[key, label, kind]` flat list.
// `editorFields` stays the canonical flat enumeration used by the revision-diff
// builder + any consumer that just wants "every editable scalar key"; the
// sections are an additional grouped VIEW over the same fields.
function flattenSections(sections) {
  return sections.flatMap((s) => s.fields);
}

// Read-only array fields surfaced by the character sheet. These are edited on
// the Universe Builder canon surface (structured per-item editors live there);
// the Catalog sheet renders them as labeled chips/cards so the enriched canon
// is visible without leaving the page. `kind` drives the renderer:
//   'colorPalette' → swatch row ({ name, hex }); 'kv' → key/value stat rows
//   ({ key, value }); 'text' → string-array chips.
export const CHARACTER_LIST_FIELDS = Object.freeze([
  { key: 'aliases',      label: 'Aliases',       kind: 'text' },
  { key: 'colorPalette', label: 'Color Palette', kind: 'colorPalette' },
  { key: 'stats',        label: 'Stats',         kind: 'kv' },
]);

// Structured array-field editors for the bible types — client MIRROR of the
// server `editableListFields` (server/lib/catalogTypes.js). The Catalog detail
// editor renders these as inline structured editors (AliasListEditor /
// ColorPaletteEditor / StatListEditor) instead of read-only chips. The numeric
// caps are hardcoded BIBLE_LIMITS values (the client can't import storyBible) —
// the parity test asserts they match the server's BIBLE_LIMITS-sourced values
// EXACTLY, so a limit bump on the server fails CI here until it's mirrored.
//   ALIAS_MAX=100, ALIASES_PER_ENTRY_MAX=12, COLOR_NAME_MAX=80,
//   COLORS_PER_PALETTE_MAX=12, STAT_VALUE_MAX=200, STATS_PER_CHARACTER_MAX=30
const CHARACTER_EDITABLE_LIST_FIELDS = [
  { key: 'aliases', label: 'Aliases', kind: 'stringArray', itemMax: 100, listMax: 12 },
  { key: 'colorPalette', label: 'Color Palette', kind: 'colorPalette', itemMax: 80, listMax: 12 },
  { key: 'stats', label: 'Stats', kind: 'kv', itemMax: 200, listMax: 30 },
];
const PLACE_EDITABLE_LIST_FIELDS = [];
const OBJECT_EDITABLE_LIST_FIELDS = [
  { key: 'aliases', label: 'Aliases', kind: 'stringArray', itemMax: 100, listMax: 12 },
];

export const CATALOG_TYPES = Object.freeze([
  {
    id: 'character',
    label: 'Character',
    badgeColor: 'bg-blue-500/20 text-blue-300 border-blue-500/40',
    primaryContentKey: 'physicalDescription',
    primaryContentLabel: 'Physical Description',
    snippetFallbackKeys: ['physicalDescription', 'description', 'summary', 'personality', 'significance', 'role', 'notes'],
    // Grouped DnD-style sheet sections (rendered by CatalogIngredient). Keys
    // mirror `sanitizeCharacter` in server/lib/storyBible.js EXACTLY so a
    // Catalog-surface edit lands in the same canon field the Universe Builder
    // reads. `editorFields` is the flattened enumeration of these same keys.
    editorSections: CHARACTER_SECTIONS,
    editorFields: flattenSections(CHARACTER_SECTIONS),
    editableListFields: CHARACTER_EDITABLE_LIST_FIELDS,
  },
  {
    id: 'place',
    label: 'Place',
    badgeColor: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
    primaryContentKey: 'description',
    primaryContentLabel: 'Description',
    snippetFallbackKeys: ['description', 'summary', 'significance', 'notes'],
    editorSections: PLACE_SECTIONS,
    editorFields: flattenSections(PLACE_SECTIONS),
    editableListFields: PLACE_EDITABLE_LIST_FIELDS,
  },
  {
    id: 'object',
    label: 'Object',
    badgeColor: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
    primaryContentKey: 'description',
    primaryContentLabel: 'Description',
    snippetFallbackKeys: ['description', 'significance', 'summary', 'notes'],
    editorSections: OBJECT_SECTIONS,
    editorFields: flattenSections(OBJECT_SECTIONS),
    editableListFields: OBJECT_EDITABLE_LIST_FIELDS,
  },
  {
    id: 'idea',
    label: 'Idea',
    badgeColor: 'bg-purple-500/20 text-purple-300 border-purple-500/40',
    primaryContentKey: 'summary',
    primaryContentLabel: 'Summary',
    snippetFallbackKeys: ['summary', 'description', 'notes'],
    editorFields: LIGHT_FIELDS,
  },
  {
    id: 'scene',
    label: 'Scene',
    badgeColor: 'bg-pink-500/20 text-pink-300 border-pink-500/40',
    primaryContentKey: 'summary',
    primaryContentLabel: 'Summary',
    snippetFallbackKeys: ['summary', 'description', 'notes'],
    editorFields: LIGHT_FIELDS,
  },
  {
    id: 'concept',
    label: 'Concept',
    badgeColor: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40',
    primaryContentKey: 'summary',
    primaryContentLabel: 'Summary',
    snippetFallbackKeys: ['summary', 'description', 'notes'],
    editorFields: LIGHT_FIELDS,
  },
]);

/**
 * Catalog ingredient↔ingredient RELATION kinds — client mirror of
 * `server/lib/catalogTypes.js` RELATION_KINDS. Drives the "Relations" panel
 * picker on the ingredient detail page. `label` is the from→to direction;
 * `inverseLabel` renders the same stored edge from the `to` side.
 *
 * Drift is asserted by `server/lib/catalogTypes.parity.test.js` against the server
 * registry — change one side, change the other.
 */
export const RELATION_KINDS = Object.freeze([
  { id: 'appears-in', label: 'Appears in', inverseLabel: 'Features' },
  { id: 'lives-in', label: 'Lives in', inverseLabel: 'Home of' },
  { id: 'created-by', label: 'Created by', inverseLabel: 'Creator of' },
  { id: 'parent-of', label: 'Parent of', inverseLabel: 'Child of' },
  { id: 'variant-of', label: 'Variant of', inverseLabel: 'Has variant' },
  { id: 'references', label: 'References', inverseLabel: 'Referenced by' },
  { id: 'related-to', label: 'Related to', inverseLabel: 'Related to' },
]);

/**
 * Canonical key for a freeform tag label — client mirror of
 * `server/lib/catalogTypes.js` `canonicalTagKey`. Lowercase + trim + collapse
 * internal whitespace. Used by the tag picker to dedup the chosen-tags set
 * (so `Noir` and `noir` don't both show as chips before save). Returns `''`
 * for empty/non-string input.
 */
export function canonicalTagKey(label) {
  if (typeof label !== 'string') return '';
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

const RELATION_BY_ID = Object.freeze(Object.fromEntries(RELATION_KINDS.map((r) => [r.id, r])));

/** Look up a relation-kind entry by id. Returns `undefined` for unknown ids. */
export function getRelationKind(id) {
  return RELATION_BY_ID[id];
}

/**
 * Catalog ingredient MEDIA-attachment kinds — client mirror of
 * `server/lib/catalogTypes.js` MEDIA_KINDS. Drives the "Media" panel attach
 * picker / drag-drop on the ingredient detail page. `accept` is the file-input
 * MIME filter. Drift is asserted by `server/lib/catalogTypes.parity.test.js`
 * against the server registry — change one side, change the other.
 */
export const MEDIA_KINDS = Object.freeze([
  { id: 'portrait', label: 'Portrait', accept: 'image/*' },
  { id: 'reference', label: 'Reference', accept: 'image/*' },
  { id: 'audio', label: 'Audio', accept: 'audio/*' },
  { id: 'video', label: 'Video', accept: 'video/*' },
  { id: 'document', label: 'Document', accept: '.pdf,.txt,.md' },
]);

const MEDIA_BY_ID = Object.freeze(Object.fromEntries(MEDIA_KINDS.map((m) => [m.id, m])));

/** Look up a media-kind entry by id. Returns `undefined` for unknown ids. */
export function getMediaKind(id) {
  return MEDIA_BY_ID[id];
}

const BY_ID = Object.freeze(Object.fromEntries(CATALOG_TYPES.map((t) => [t.id, t])));

/** Look up a registry entry by type id. Returns `undefined` for unknown ids. */
export function getCatalogType(id) {
  return BY_ID[id];
}

/** Ordered list of type ids. */
export const CATALOG_TYPE_IDS = Object.freeze(CATALOG_TYPES.map((t) => t.id));

/** Map type id → Tailwind badge color class string. */
export const CATALOG_BADGE_BY_ID = Object.freeze(
  Object.fromEntries(CATALOG_TYPES.map((t) => [t.id, t.badgeColor])),
);

/**
 * Pull a short snippet from a payload using a type's fallback chain (first
 * non-empty key wins), trimmed + ellipsised to `max` chars. When `typeId` is
 * unknown/absent, falls back to a broad union of every type's keys so a row of
 * unknown type still renders a snippet.
 *
 * `resolveType` (optional) lets a caller pass the MERGED registry resolver
 * (`useCatalogTypes().getType`) so a user-defined type's custom
 * `snippetFallbackKeys` (e.g. a `creed` key) are honored — the static `BY_ID`
 * only knows the built-ins. Falls back to the static lookup when omitted.
 */
export function payloadSnippet(payload, typeId, max = 120, resolveType = null) {
  if (!payload || typeof payload !== 'object') return '';
  const typeDef = (resolveType && resolveType(typeId)) || BY_ID[typeId];
  const keys = typeDef?.snippetFallbackKeys || UNION_SNIPPET_KEYS;
  let raw = '';
  for (const k of keys) {
    if (payload[k]) { raw = payload[k]; break; }
  }
  const text = String(raw).trim().replace(/\s+/g, ' ');
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}…`;
}

// Ordered union of every type's snippet keys — used as the unknown-type
// fallback so a row whose type isn't in the registry still gets a snippet.
const UNION_SNIPPET_KEYS = (() => {
  const out = [];
  for (const t of CATALOG_TYPES) {
    for (const k of t.snippetFallbackKeys) {
      if (!out.includes(k)) out.push(k);
    }
  }
  return out;
})();

// --- User-defined types (client mirror) ----------------------------------
// User types are defined in Settings → Catalog, persisted server-side in
// settings.json, and served (merged with the system registry) via
// `GET /api/catalog/types`. The `useCatalogTypes` hook fetches them and merges
// with the static `CATALOG_TYPES` above so the Catalog list/picker/editor pick
// them up. The static registry stays the synchronous fallback so first render
// never blanks.

/** Field kinds a user type may declare — mirror of the server constant. */
export const USER_TYPE_FIELD_KINDS = Object.freeze(['string', 'longtext', 'tags', 'ref']);

// Map a server field `kind` to the client editor widget kind. `string` → a
// single-line input ('text'), `longtext` → a textarea, `tags`/`ref` keep their
// names (the generic renderer special-cases them). Unknown kinds fall back to
// 'text' so a forked-peer field never crashes the renderer.
const FIELD_KIND_TO_WIDGET = { string: 'text', longtext: 'textarea', tags: 'tags', ref: 'ref' };

/**
 * Normalize a server-served user type (system:false) into the client registry
 * shape the UI consumes — the same surface a static `CATALOG_TYPES` entry
 * exposes, plus `system: false` and a generic `editorFields` list derived from
 * the server `fields`. Returns `null` for a structurally-invalid entry.
 */
export function normalizeUserTypeForClient(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
  const fields = Array.isArray(raw.fields) ? raw.fields : [];
  const editorFields = fields
    .filter((f) => f && typeof f.key === 'string')
    .map((f) => ({
      key: f.key,
      label: typeof f.label === 'string' && f.label ? f.label : f.key,
      widget: FIELD_KIND_TO_WIDGET[f.kind] || 'text',
      ...(Number.isInteger(f.maxLength) ? { maxLength: f.maxLength } : {}),
    }));
  return {
    id: raw.id,
    label: typeof raw.label === 'string' && raw.label ? raw.label : raw.id,
    badgeColor: raw.badgeColor || 'bg-gray-500/20 text-gray-300 border-gray-500/40',
    primaryContentKey: raw.primaryContentKey || 'description',
    primaryContentLabel: raw.primaryContentLabel
      || editorFields.find((f) => f.key === raw.primaryContentKey)?.label
      || 'Description',
    snippetFallbackKeys: Array.isArray(raw.snippetFallbackKeys) && raw.snippetFallbackKeys.length
      ? raw.snippetFallbackKeys
      : [raw.primaryContentKey || 'description'],
    editorFields,
    system: false,
  };
}

/**
 * Merge the static system registry with normalized user types into an ordered
 * list (system first) + a BY_ID lookup. `userTypes` is the raw server array
 * (system entries are dropped — they're already in `staticTypes`); each user
 * entry is normalized. A user id colliding with a system id is skipped (system
 * wins). Returns `{ list, byId }`.
 */
export function mergeCatalogTypes(staticTypes = CATALOG_TYPES, userTypes = []) {
  const list = staticTypes.map((t) => ({ ...t, system: true }));
  const systemIds = new Set(staticTypes.map((t) => t.id));
  const seen = new Set(systemIds);
  for (const raw of Array.isArray(userTypes) ? userTypes : []) {
    if (raw?.system) continue; // server may include system entries; skip — already present
    const normalized = normalizeUserTypeForClient(raw);
    if (!normalized || seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    list.push(normalized);
  }
  const byId = Object.fromEntries(list.map((t) => [t.id, t]));
  return { list, byId };
}

/** Look up a type by id from a merged `byId` map (from `mergeCatalogTypes`). */
export function getCatalogTypeFrom(byId, id) {
  return byId?.[id];
}
