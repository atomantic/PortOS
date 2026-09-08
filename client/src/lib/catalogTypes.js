/**
 * The catalog ingredient type registry as the UI consumes it — the server
 * registry in `server/lib/catalogTypes.js` plus the per-type editor layout.
 *
 * The registry itself is NOT copied. `CATALOG_TYPES` below is projected from
 * the server entries, so `label` / `badgeColor` / the primary-content key and
 * label / the snippet fallback chain / `editableListFields` (and its
 * `BIBLE_LIMITS`-derived caps) have exactly one definition and cannot drift.
 * `RELATION_KINDS`, `MEDIA_KINDS`, `canonicalTagKey`, `payloadSnippet` and
 * `USER_TYPE_FIELD_KINDS` are re-exported outright.
 *
 * What stays here is presentation the server has no use for: the grouped
 * "character sheet" `editorSections` and their flattened `editorFields`, the
 * read-only `CHARACTER_LIST_FIELDS`, badge/ref-role lookups, and the
 * user-defined-type normalization the `useCatalogTypes` hook merges in.
 *
 * Adding a type: add it to the SERVER registry (+ one migration loosening the
 * CHECK constraint), then give it an editor layout in `TYPE_EDITOR_LAYOUT`
 * below. The Catalog list/picker/inline-form, the detail editor, and the type
 * chips all map over `CATALOG_TYPES`, so it surfaces everywhere at once.
 */
import { CATALOG_TYPES as SERVER_CATALOG_TYPES } from '../../../server/lib/catalogTypes.js';

export {
  MEDIA_KINDS,
  RELATION_KINDS,
  USER_TYPE_FIELD_KINDS,
  canonicalTagKey,
  getMediaKind,
  getRelationKind,
  payloadSnippet,
} from '../../../server/lib/catalogTypes.js';

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

// Per-type editor layout — the one thing the server registry has no use for.
// `editorSections` is the grouped "character sheet" view the detail editor
// renders; `editorFields` stays the flat enumeration the revision-diff builder
// and every "each editable scalar key" consumer reads. The keys mirror the canon
// sanitizers in `server/lib/storyBible.js` (`sanitizeCharacter` /
// `sanitizePlace` / `sanitizeObject`) EXACTLY, so a Catalog-surface edit lands
// in the same payload field the Universe Builder canon surface reads.
const TYPE_EDITOR_LAYOUT = {
  character: { editorSections: CHARACTER_SECTIONS, editorFields: flattenSections(CHARACTER_SECTIONS) },
  place: { editorSections: PLACE_SECTIONS, editorFields: flattenSections(PLACE_SECTIONS) },
  object: { editorSections: OBJECT_SECTIONS, editorFields: flattenSections(OBJECT_SECTIONS) },
  idea: { editorFields: LIGHT_FIELDS },
  scene: { editorFields: LIGHT_FIELDS },
  concept: { editorFields: LIGHT_FIELDS },
};

// The UI projection of the server registry: only the fields a component reads,
// plus the layout above. Server-only concerns (idPrefix, ftsFields,
// extractionShape, payloadSchemaVersion, payloadUpgraders, defaultTags) stay off
// the client entries so a component can't start depending on one.
export const CATALOG_TYPES = Object.freeze(SERVER_CATALOG_TYPES.map((type) => Object.freeze({
  id: type.id,
  label: type.label,
  badgeColor: type.badgeColor,
  primaryContentKey: type.primaryContentKey,
  primaryContentLabel: type.primaryContentLabel,
  snippetFallbackKeys: type.snippetFallbackKeys,
  ...(type.editableListFields ? { editableListFields: type.editableListFields } : {}),
  ...(TYPE_EDITOR_LAYOUT[type.id] || { editorFields: LIGHT_FIELDS }),
})));

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

// Catalog ingredient `type` → ref role when linking the ingredient to a
// universe/series from the UI (#1762 bulk "Add to universe/series" + the cast
// panel). character/place/object carry a typed `cast-*` role; everything else
// (idea/scene/concept/user types) links as a generic 'reference'. The server
// validates role as a free string (min1/max64), so this is the client-side
// convention shared by CatalogCastPanel and the Catalog bulk-place action.
const CATALOG_REF_ROLE_BY_TYPE = Object.freeze({
  character: 'cast-character',
  place: 'cast-place',
  object: 'cast-object',
});
export const catalogRefRoleForType = (type) => CATALOG_REF_ROLE_BY_TYPE[type] || 'reference';

// --- User-defined types (client mirror) ----------------------------------
// User types are defined in Settings → Catalog, persisted server-side in
// settings.json, and served (merged with the system registry) via
// `GET /api/catalog/types`. The `useCatalogTypes` hook fetches them and merges
// with the static `CATALOG_TYPES` above so the Catalog list/picker/editor pick
// them up. The static registry stays the synchronous fallback so first render
// never blanks.

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
