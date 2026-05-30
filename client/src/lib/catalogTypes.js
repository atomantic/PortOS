/**
 * Client mirror of `server/lib/catalogTypes.js` — the catalog ingredient type
 * registry. The server registry carries extra server-only fields (idPrefix,
 * ftsFields, payloadSchemaVersion, payloadUpgraders); the client mirror keeps
 * only what the UI renders: label, badge color, the inline-form primary
 * content key/label, the snippet fallback chain, and the per-type editor field
 * list.
 *
 * Drift is asserted by `client/src/lib/catalogTypes.test.js` against the
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

export const CATALOG_TYPES = Object.freeze([
  {
    id: 'character',
    label: 'Character',
    badgeColor: 'bg-blue-500/20 text-blue-300 border-blue-500/40',
    primaryContentKey: 'physicalDescription',
    primaryContentLabel: 'Physical Description',
    snippetFallbackKeys: ['physicalDescription', 'description', 'summary', 'personality', 'significance', 'role', 'notes'],
    editorFields: [
      ['role',                'Role',                  'text'],
      // Canon character shape uses `physicalDescription` (matches
      // sanitizeCharacter and the writers-room/bible extractor). A plain
      // `description` here would render empty for backfill-promoted characters
      // and edits would land in a sibling field the canon doesn't read.
      ['physicalDescription', 'Physical Description',  'textarea'],
      ['personality',         'Personality',           'textarea'],
      ['background',          'Background',            'textarea'],
      ['motivations',         'Motivations',           'textarea'],
      ['notes',               'Notes',                 'textarea'],
    ],
  },
  {
    id: 'place',
    label: 'Place',
    badgeColor: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
    primaryContentKey: 'description',
    primaryContentLabel: 'Description',
    snippetFallbackKeys: ['description', 'summary', 'significance', 'notes'],
    editorFields: [
      ['slugline',     'Slugline',     'text'],
      ['era',          'Era',          'text'],
      ['description',  'Description',  'textarea'],
      ['notes',        'Notes',        'textarea'],
    ],
  },
  {
    id: 'object',
    label: 'Object',
    badgeColor: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
    primaryContentKey: 'description',
    primaryContentLabel: 'Description',
    snippetFallbackKeys: ['description', 'significance', 'summary', 'notes'],
    editorFields: [
      ['description',  'Description',  'textarea'],
      ['significance', 'Significance', 'textarea'],
      ['notes',        'Notes',        'textarea'],
    ],
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
 * Drift is asserted by `client/src/lib/catalogTypes.test.js` against the server
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

const RELATION_BY_ID = Object.freeze(Object.fromEntries(RELATION_KINDS.map((r) => [r.id, r])));

/** Look up a relation-kind entry by id. Returns `undefined` for unknown ids. */
export function getRelationKind(id) {
  return RELATION_BY_ID[id];
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
 */
export function payloadSnippet(payload, typeId, max = 120) {
  if (!payload || typeof payload !== 'object') return '';
  const keys = BY_ID[typeId]?.snippetFallbackKeys || UNION_SNIPPET_KEYS;
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
