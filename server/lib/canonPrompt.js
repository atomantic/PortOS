/**
 * Shared per-kind field-precedence rules for canon entries. Pure ESM, no
 * Node-only deps — mirrored to `client/src/lib/canonPrompt.js` for the
 * client bundle.
 *
 * Source of truth for "which fields describe a canon entry of this kind,
 * in what order". Consumers:
 *   - `synthesizeCanonPrompt` (server/services/universeBuilder.js) →
 *     render-prompt body (RICH fields)
 *   - `canonEntryHasContent` (client/src/pages/UniverseBuilder.jsx) →
 *     "is there any descriptive content?" gate (RICH fields)
 *   - `KINDS[].descFor` (client/src/components/universe/UniverseCanonSection.jsx) →
 *     UI summary + handleRenderRef button-enable predicate (SHORT fields)
 *   - `settingFrags` (server/lib/scenePrompt.js) → scene-prompt framing
 *     for places (SHORT fields)
 *   - `CanonReviewSection` (client/src/pages/Importer.jsx) → importer
 *     pre-commit per-card preview (PREVIEW fields)
 *
 * SHORT vs PREVIEW vs RICH:
 *   - SHORT = the visual descriptor subset shown in UI cards. For
 *     chars/objects: single primary field with a single fallback (mirrors
 *     the legacy `descFor` `||` chain). For places: description +
 *     palette + recurringDetails (the "place baseline" from scenePrompt).
 *   - PREVIEW = narrative + identity-disambiguation fields surfaced in the
 *     importer's pre-commit review cards. Includes prose-only fields
 *     (`personality`, `background`, `slugline`) that have no visual role.
 *   - RICH = every descriptive field that contributes to a render prompt.
 *     Adds `role` (chars), `era`+`weather` (places), additive
 *     `significance` (objects).
 */

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

// PREVIEW spec: importer pre-commit review surface. Wider than SHORT (the
// user needs to see narrative-only fields like `personality` / `background`
// to judge "include this character?") and intentionally distinct from RICH
// (RICH drives render prompts; preview is about identity disambiguation).
// `subtitleField` is the single-line tagline; `bodyFields` uses the same
// `[{ field }]` sequence shape as RICH_SPEC so `fragmentsFromSequence` can
// be reused (no prefixes — importer cards render values verbatim).
const PREVIEW_SPEC = Object.freeze({
  characters: Object.freeze({
    subtitleField: 'role',
    bodyFields: Object.freeze([
      { field: 'physicalDescription' },
      { field: 'personality' },
      { field: 'background' },
    ]),
  }),
  places: Object.freeze({
    subtitleField: 'slugline',
    bodyFields: Object.freeze([{ field: 'description' }]),
  }),
  objects: Object.freeze({
    subtitleField: null,
    bodyFields: Object.freeze([
      { field: 'description' },
      { field: 'significance' },
    ]),
  }),
});

// RICH spec: ordered list of all descriptor fields. Prefixes capitalized
// uniformly so flattened output reads as natural sentence fragments.
const RICH_SPEC = Object.freeze({
  characters: Object.freeze([
    { field: 'physicalDescription' },
    { field: 'role' },
    // Extended visual descriptors — flow into per-page render prompts so the
    // model has continuity beyond the bare physicalDescription. Structured
    // fields (colorPalette, props, expressions) are flattened by the
    // reference-sheet builder, not here, to keep this spec field-keyed.
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
 * Render `[{ prefix?, value }]` fragments as an array of display strings.
 *
 * When `trailingPeriod` is true, each prefixed fragment is rendered as
 * `${prefix}: ${value}.` so that a downstream caller can later join the array
 * with a single space and still preserve "Palette: red. Era: Victorian."
 * sentence boundaries (see `buildScenePrompt`'s budget-truncation join).
 * Bare-value fragments never get a trailing period — the caller controls
 * sentence punctuation when no prefix is involved.
 */
export function mapCanonDescriptorFragments(fragments, { trailingPeriod = false } = {}) {
  if (!Array.isArray(fragments)) return [];
  return fragments.map((f) => {
    if (!f) return '';
    const body = f.prefix ? `${f.prefix}: ${f.value}` : (f.value ?? '');
    return f.prefix && trailingPeriod ? `${body}.` : body;
  });
}

/**
 * Flatten `[{ prefix?, value }]` fragments to a single sentence-style string.
 *
 * Shared by `descriptorForCanonEntry` (SHORT spec, `. ` separator),
 * `composeComicPagePrompt` (RICH spec, `. ` separator), and
 * `synthesizeCanonPrompt` (RICH spec, `. ` separator). The 4-arg
 * `mapCanonDescriptorFragments` companion supports the scene-prompt budget
 * truncator that needs the array form (`buildScenePrompt`).
 */
export function flattenCanonDescriptorFragments(fragments, { separator = '. ', trailingPeriod = false } = {}) {
  return mapCanonDescriptorFragments(fragments, { trailingPeriod }).join(separator);
}

/**
 * Flatten SHORT fragments into a sentence-style descriptor string.
 * Matches the legacy `KINDS[].descFor` output:
 *   characters: "physicalDescription" else "description"
 *   places:     "description. Palette: <palette>. recurringDetails"
 *   objects:    "description" else "significance"
 */
export function descriptorForCanonEntry(kind, entry) {
  return flattenCanonDescriptorFragments(shortCanonDescriptorFragments(kind, entry));
}

/**
 * PREVIEW fragments — importer pre-commit review surface.
 *
 * Returns `{ subtitle, body }` where `subtitle` is a single trimmed string
 * (empty when the kind has no subtitle field or the value is blank) and
 * `body` is an ordered `[{ field, value }]` array of non-blank fields,
 * intended for ` • `-joined rendering in importer cards. Unknown kinds and
 * non-object entries return the empty shape so callers can render
 * unconditionally.
 *
 * This is intentionally wider than `shortCanonDescriptorFragments` (which
 * is scoped to the visual subset that drives render-prompts and ref-image
 * gating). PREVIEW exists so the user can disambiguate which character /
 * place / object to commit, so it surfaces narrative-only fields
 * (`personality`, `background`, `slugline`) that have no visual role.
 */
export function previewCanonFragments(kind, entry) {
  if (!entry || typeof entry !== 'object') return { subtitle: '', body: [] };
  const spec = PREVIEW_SPEC[normalizeKind(kind)];
  if (!spec) return { subtitle: '', body: [] };
  const subtitle = spec.subtitleField ? trim(entry[spec.subtitleField]) : '';
  return { subtitle, body: fragmentsFromSequence(spec.bodyFields, entry) };
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

// Flatteners for character bible list fields — used by the reference-sheet
// builder and future per-page render prompts so the join logic stays in one
// place. Each returns `''` when the input is missing/empty.
//
// Server-only — NOT part of the `client/src/lib/canonPrompt.js` mirror
// contract. Adding them client-side would bloat the bundle for code that
// only runs in image-gen / prompt-building paths.
export function flattenStats(stats) {
  if (!Array.isArray(stats) || stats.length === 0) return '';
  return stats
    .map((s) => (s?.label && s?.value ? `${s.label}: ${s.value}` : s?.label || ''))
    .filter(Boolean)
    .join(' | ');
}

export function flattenPalette(palette) {
  if (!Array.isArray(palette) || palette.length === 0) return '';
  return palette
    .map((c, i) => {
      const name = trim(c?.name);
      const hex = trim(c?.hex);
      const role = trim(c?.role);
      if (!name) return '';
      const hexBit = hex ? ` ${hex}` : '';
      const roleBit = role ? ` — ${role}` : '';
      return `Swatch ${i + 1}: ${name}${hexBit}${roleBit}`;
    })
    .filter(Boolean)
    .join(', ');
}

export function flattenWardrobes(wardrobes) {
  if (!Array.isArray(wardrobes) || wardrobes.length === 0) return '';
  return wardrobes
    .map((w) => (w?.name && w?.description ? `"${w.name}": ${w.description}` : w?.name || ''))
    .filter(Boolean)
    .join(' | ');
}

export function flattenProps(props) {
  if (!Array.isArray(props) || props.length === 0) return '';
  return props
    .map((p) => {
      const name = trim(p?.name);
      const purpose = trim(p?.purpose);
      const materials = trim(p?.materials);
      if (!name) return '';
      const bits = [purpose ? `(${purpose})` : '', materials ? `[${materials}]` : '']
        .filter(Boolean)
        .join(' ');
      return bits ? `${name} ${bits}` : name;
    })
    .filter(Boolean)
    .join(' | ');
}

// `defaults` is consulted when the entry has no items at all — keeps the
// reference-sheet prompt's expression / hand-gesture panels populated even
// when the bible omitted them. Caps at 7 entries so the rendered sheet
// stays legible across providers (codex/local both honor the cap).
export function flattenNamedList(items, defaults) {
  const list = Array.isArray(items) && items.length > 0
    ? items.map((e) => (e?.name && e?.description ? `${e.name} (${e.description})` : trim(e?.name))).filter(Boolean)
    : [...defaults];
  return list.slice(0, 7).join(', ');
}
