/**
 * Grouping + search for the Sprite Manager sidebar's record picker (#2932).
 *
 * `groupSpriteRecords(records)` → ordered `[{ key, label, records }]` under **Characters / Places /
 * Objects** (`props` folded into Objects alongside `object`, no migration).
 * `filterSpriteRecords(records, query, limit=8)` is the autocomplete filter — multi-term (AND)
 * substring over `name`/`id`/`kind`, capped at `limit`. `groupKeyForKind(kind)` maps a kind to its
 * group key (unknown → `objects`). `SPRITE_RECORD_GROUPS` / `NEW_SPRITE_KINDS` back the browse
 * disclosure and the create-panel kind selector. Pure — no React, no I/O; the page owns the per-group
 * icons.
 *
 * The `props` kind is a legacy import-only value, folded into **Objects** alongside `object` so imported prop atlas families need no data migration. The sidebar owns the per-group icons (a lib module can't import lucide components without pulling React into pure code), so groups carry a stable `key` the page maps to an icon.
 */

// Render order of the three noun groups. Each maps one or more record `kind`
// values; `object` and the legacy `props` share the Objects group.
export const SPRITE_RECORD_GROUPS = [
  { key: 'characters', label: 'Characters', kinds: ['character'] },
  { key: 'places', label: 'Places', kinds: ['place'] },
  { key: 'objects', label: 'Objects', kinds: ['object', 'props'] },
];

// The kinds a user can create through the New Sprite panel — `props` is
// import-only and never offered here.
export const NEW_SPRITE_KINDS = [
  { value: 'character', label: 'Character' },
  { value: 'place', label: 'Place' },
  { value: 'object', label: 'Object' },
];

const KIND_TO_GROUP = new Map();
for (const group of SPRITE_RECORD_GROUPS) {
  for (const kind of group.kinds) KIND_TO_GROUP.set(kind, group.key);
}

// An unknown/legacy kind lands in Objects rather than vanishing from the
// sidebar — the same fold that keeps `props` visible protects any future
// stray value until it gets its own group.
export function groupKeyForKind(kind) {
  return KIND_TO_GROUP.get(kind) || 'objects';
}

/**
 * Group records into the ordered noun groups, preserving each record's
 * incoming order within its group. Empty groups are omitted. Returns
 * `[{ key, label, records }]`.
 */
export function groupSpriteRecords(records) {
  const byKey = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const key = groupKeyForKind(record?.kind);
    const list = byKey.get(key);
    if (list) list.push(record); else byKey.set(key, [record]);
  }
  return SPRITE_RECORD_GROUPS
    .filter((g) => byKey.has(g.key))
    .map((g) => ({ key: g.key, label: g.label, records: byKey.get(g.key) }));
}

/**
 * Multi-term substring filter over a record's `name`, `id`, and `kind`. Every
 * whitespace-separated term must match somewhere (AND semantics) so "hero
 * place" narrows rather than widening. An empty/whitespace query returns the
 * list unchanged. The result is capped at `limit` (default 8) so the
 * suggestion list stays bounded regardless of library size.
 */
export function filterSpriteRecords(records, query, limit = 8) {
  const list = Array.isArray(records) ? records : [];
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return list.slice(0, limit);
  const matches = list.filter((record) => {
    const haystack = `${record?.name || ''} ${record?.id || ''} ${record?.kind || ''}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
  return matches.slice(0, limit);
}
