// Mirror of server/lib/canonPrompt.js — logic kept in sync (specs + helpers
// must match exactly). Header comments differ intentionally (the server copy
// carries the full JSDoc); when editing, port logic changes verbatim and
// leave commentary scoped to each side. The server copy is authoritative;
// tests in server/lib/canonPrompt.test.js are the contract.

const trim = (s) => (typeof s === 'string' ? s.trim() : '');

// SHORT spec: chars/objects use single-with-fallback; places uses a
// sequence so palette can carry its prefix.
const SHORT_SPEC = Object.freeze({
  characters: Object.freeze({ primary: 'physicalDescription', fallback: 'description' }),
  places: Object.freeze({
    sequence: Object.freeze([
      { field: 'description' },
      { field: 'palette', prefix: 'Palette' },
      { field: 'recurringDetails' },
    ]),
  }),
  objects: Object.freeze({ primary: 'description', fallback: 'significance' }),
});

// RICH spec: ordered list of all descriptor fields. Prefixes capitalized
// uniformly so flattened output reads as natural sentence fragments.
const RICH_SPEC = Object.freeze({
  characters: Object.freeze([
    { field: 'physicalDescription' },
    { field: 'role' },
    { field: 'visualNotes' },
    { field: 'silhouetteNotes' },
    { field: 'postureNotes' },
    { field: 'specialTraits' },
    { field: 'visualIdentity' },
  ]),
  places: Object.freeze([
    { field: 'description' },
    { field: 'palette', prefix: 'Palette' },
    { field: 'era', prefix: 'Era' },
    { field: 'weather', prefix: 'Weather' },
    { field: 'recurringDetails' },
  ]),
  objects: Object.freeze([
    { field: 'description' },
    { field: 'significance', prefix: 'Significance' },
  ]),
});

function normalizeKind(kind) {
  const k = String(kind || '').toLowerCase();
  if (k === 'character' || k === 'characters') return 'characters';
  if (k === 'place' || k === 'places') return 'places';
  if (k === 'object' || k === 'objects') return 'objects';
  return null;
}

function fragmentsFromSequence(sequence, entry) {
  const out = [];
  for (const spec of sequence) {
    const value = trim(entry[spec.field]);
    if (!value) continue;
    out.push(spec.prefix ? { field: spec.field, value, prefix: spec.prefix } : { field: spec.field, value });
  }
  return out;
}

// Short-circuit "any non-blank field in this sequence" — used by
// `hasCanonDescriptorContent` so per-entry render-count filters don't
// allocate a full fragments array just to read `.length > 0`.
function sequenceHasAnyField(sequence, entry) {
  for (const spec of sequence) {
    if (trim(entry[spec.field])) return true;
  }
  return false;
}

/**
 * SHORT descriptor fragments — the visual subset used in canon UI cards
 * and the render-ref button-enable predicate.
 *
 * Returns `[{ field, value, prefix? }]` in display order. Empty/missing
 * fields produce no fragment. For chars/objects this is at most a single
 * fragment (primary with single-field fallback).
 */
export function shortCanonDescriptorFragments(kind, entry) {
  if (!entry || typeof entry !== 'object') return [];
  const spec = SHORT_SPEC[normalizeKind(kind)];
  if (!spec) return [];
  if (spec.sequence) return fragmentsFromSequence(spec.sequence, entry);
  const primary = trim(entry[spec.primary]);
  if (primary) return [{ field: spec.primary, value: primary }];
  const fallback = trim(entry[spec.fallback]);
  if (fallback) return [{ field: spec.fallback, value: fallback }];
  return [];
}

/**
 * RICH descriptor fragments — every descriptive field that contributes to
 * a render prompt body. Used by render-synthesis and the
 * "has any content?" gate.
 */
export function richCanonDescriptorFragments(kind, entry) {
  if (!entry || typeof entry !== 'object') return [];
  const sequence = RICH_SPEC[normalizeKind(kind)];
  if (!sequence) return [];
  return fragmentsFromSequence(sequence, entry);
}

/**
 * Flatten SHORT fragments into a sentence-style descriptor string.
 * Matches the legacy `KINDS[].descFor` output:
 *   characters: "physicalDescription" else "description"
 *   settings:   "description. Palette: <palette>. recurringDetails"
 *   objects:    "description" else "significance"
 */
export function descriptorForCanonEntry(kind, entry) {
  return shortCanonDescriptorFragments(kind, entry)
    .map((f) => (f.prefix ? `${f.prefix}: ${f.value}` : f.value))
    .join('. ');
}

/**
 * True when the entry has any non-blank value across the RICH field set.
 * Mirrors `canonEntryHasContent`'s per-kind union check (UniverseBuilder.jsx)
 * and is the read-side mirror of `synthesizeCanonPrompt`'s skip-empty-seed
 * rule.
 */
export function hasCanonDescriptorContent(kind, entry) {
  if (!entry || typeof entry !== 'object') return false;
  const sequence = RICH_SPEC[normalizeKind(kind)];
  if (!sequence) return false;
  return sequenceHasAnyField(sequence, entry);
}
