/**
 * Universe Builder — constants + sanitizers (record-shape layer).
 *
 * Pure, side-effect-free foundation for the universe-builder service: every
 * exported limit/constant plus the `sanitize*` helpers that normalize a raw
 * on-disk / wire / route payload into the canonical universe record shape.
 * No storage, no peer-sync, no LLM — those live in the sibling crud / sync /
 * compile modules that import from here. Split out of the former monolithic
 * `universeBuilder.js` (#2529); the barrel at `../universeBuilder.js`
 * re-exports this module so existing import paths keep working.
 */

import { randomUUID } from 'crypto';
import { basename } from 'path';
import {
  sanitizeBibleList, BIBLE_KIND, BIBLE_FIELD, BIBLE_LIMITS, BIBLE_SOURCE,
  normalizeBibleName, isStr, trimTo,
} from '../../lib/storyBible.js';
import { sanitizeOrigin } from '../../lib/sharingOrigin.js';
import { sanitizeSoftDeleteFields } from '../../lib/syncWire.js';

// RECORD-shape schema version, stamped INSIDE each universe record. Distinct
// from the type-level (storage layout) schemaVersion carried by
// `data/universes/index.json` — see `server/lib/collectionStore.js` header.
//   v3 — drop prose stylePrompt/negativePrompt fields; legacy values are
//        split on commas and merged into influences.embrace / influences.avoid
//        so there is a single token-list editing surface.
//   v4 — categories carry a `kind` field tagging them to one of the 3 canon
//        trunks (characters/places/objects/other); the default `characters`
//        category is retired and any variations get folded into canon
//        characters[]. See "Categories vs canon — decision" in PLAN.md.
export const CURRENT_SCHEMA_VERSION = 4;

export const ERR_NOT_FOUND = 'NOT_FOUND';
export const ERR_VALIDATION = 'VALIDATION_ERROR';
export const ERR_DUPLICATE = 'DUPLICATE';
// Raised by deleteUniverse when live series still reference the universe. The
// thrown error carries `blockingSeries: [{id,name}]` so the route can tell the
// user which series to move or delete first. Maps to HTTP 409.
export const ERR_HAS_LIVE_SERIES = 'UNIVERSE_HAS_LIVE_SERIES';
export const makeErr = (message, code) => Object.assign(new Error(message), { code });

// Universe ids are bare UUIDs (no prefix). Accept any reasonable alphanumeric
// id 8–80 chars so future id-scheme changes upstream still round-trip; the
// importer is the only caller, and it gets ids from manifests it controls.
export const UNIVERSE_ID_RE = /^[A-Za-z0-9-]{8,80}$/;

export const NAME_MAX_LENGTH = 100;
// A render can enqueue up to 5 categories × 50 variations × 20 batchPerVariation
// = 5000 jobs. Cap at 10k to leave headroom against future bumps to those caps.
const MAX_RUN_JOB_IDS = 10000;
// The starter idea is whatever the user wants to write — anything from a
// one-line pitch to a multi-page treatment. Cap is a sanity ceiling against
// runaway payloads, not an artificial brevity constraint.
export const STARTER_PROMPT_MAX = 200_000;
export const PROMPT_FRAGMENT_MAX = 2000;
export const COMPOSITE_PROMPT_MAX = 4000;
export const VARIATION_LABEL_MAX = 120;
// Narrative bible fields — surfaced into the Pipeline "new series" form so a
// universe's logline/premise/style notes can seed a production series in one click.
export const LOGLINE_MAX = 500;
export const PREMISE_MAX = 4000;
export const STYLE_NOTES_MAX = 4000;
export const VARIATIONS_PER_CATEGORY_MAX = 50;
export const COMPOSITE_SHEETS_MAX = 50;
export const COMPOSITE_SHEET_KINDS = Object.freeze([
  'reference_sheet',
  'world_pitch_poster',
]);
export const WORLD_CATEGORY_KEY_MAX = 64;
export const WORLD_CATEGORY_COUNT_MAX = 30;
// Per-entry render history caps reuse the bible's existing limits so a
// variation/sheet entry can't accrue more refs than canon already allows.
export const IMAGE_REFS_PER_ENTRY_MAX = BIBLE_LIMITS.IMAGE_REFS_PER_ENTRY_MAX;
export const IMAGE_REF_FILENAME_MAX = BIBLE_LIMITS.IMAGE_REF_MAX;
// `entryRef.kind` discriminator — the kind tag that universeRun job tags carry
// so the collection hook knows which list to append the rendered filename to.
export const ENTRY_REF_KIND = Object.freeze({
  VARIATION: 'variation',
  SHEET: 'sheet',
  CANON: 'canon',
});

// Influences — structured token lists that ARE the universe's style + negative
// prompts. Surfaced in the UI as "Style prompt" (embrace) and "Negative prompt"
// (avoid) and managed via the draggable-chip editor. Joined verbatim with the
// per-variation prompt at render-compile time.
export const INFLUENCE_ENTRY_MAX = 120;
export const INFLUENCES_PER_LIST_MAX = 30;

// Top-level fields the user can lock against AI-driven changes (refine /
// expand). When a field is locked, both the refiner and the expansion-merge
// must preserve the user's value verbatim. Categories + composite sheets are
// not lockable yet — start with the bible/prompt scalars the user owns.
export const LOCKABLE_FIELDS = Object.freeze([
  'starterPrompt',
  'logline',
  'premise',
  'styleNotes',
  'influencesEmbrace',
  'influencesAvoid',
]);

// Human-readable labels for lockable fields. Single source of truth for the
// LLM prompt builders (refine emits "starter idea", expand emits "STARTER IDEA"
// — both derive from this map). Adding a new lockable field only requires
// extending LOCKABLE_FIELDS + this map; the prompts pick it up automatically.
export const LOCKABLE_FIELD_LABELS = Object.freeze({
  starterPrompt: 'starter idea',
  logline: 'logline',
  premise: 'premise',
  styleNotes: 'style notes',
  influencesEmbrace: 'style prompt tokens',
  influencesAvoid: 'negative prompt tokens',
});

// Lockable lock-map keys that target one of the two influence sub-lists.
// Use `isInfluenceLockField` instead of `.startsWith('influences')` so a
// future LOCKABLE_FIELDS entry like `influencesPriority` doesn't accidentally
// get swept into per-list handling.
export const INFLUENCE_LOCK_FIELDS = Object.freeze(['influencesEmbrace', 'influencesAvoid']);
export const isInfluenceLockField = (key) => INFLUENCE_LOCK_FIELDS.includes(key);

// Built-in default category buckets the Universe Builder seeds on every new
// universe. Each is tagged with a canon trunk (see WORLD_CATEGORY_DEFAULT_KINDS)
// so the Phase C UI renders it under the right tab without needing a per-bucket
// picker. The default `characters` bucket was retired in schema v4 — canon
// owns characters now; any pre-v4 variations are folded into universe.characters[].
export const WORLD_CATEGORIES = Object.freeze([
  'landscapes',
  'environments',
  'structures',
  'vehicles',
]);

// Valid values for a category's `kind`. Tagged onto each category so the UI
// knows which canon trunk to render it under. `other` is the sink for
// un-classified custom buckets; an "Auto-sort" UI action LLM-classifies them
// into one of the 3 real kinds.
export const CATEGORY_KINDS = Object.freeze(['characters', 'places', 'objects', 'other']);
export const DEFAULT_CATEGORY_KIND = 'other';


// Built-in default categories carry a known kind so they land under the right
// trunk in the UI without user intervention. Custom keys not in this map fall
// to DEFAULT_CATEGORY_KIND ('other') unless the input carries an explicit
// valid `kind`.
export const WORLD_CATEGORY_DEFAULT_KINDS = Object.freeze({
  landscapes: 'places',
  environments: 'places',
  structures: 'places',
  vehicles: 'objects',
});

// Resolve a category's kind. Precedence: explicit valid kind on the input wins;
// otherwise the built-in default map; otherwise DEFAULT_CATEGORY_KIND.
const resolveCategoryKind = (key, rawKind) => {
  if (CATEGORY_KINDS.includes(rawKind)) return rawKind;
  return WORLD_CATEGORY_DEFAULT_KINDS[key] || DEFAULT_CATEGORY_KIND;
};

// Maps v1 category buckets to canon kinds + tags. Unknown keys fall to
// object (catch-all kind) tagged with the bucket name. Still used by the
// v3→v4 backfill that folds the retired `characters` bucket into canon, and
// by the optional pre-v4 backfill for legacy `landscapes/vehicles/etc` buckets.
const CATEGORY_TO_CANON = Object.freeze({
  characters:   { kind: BIBLE_KIND.CHARACTER, tags: [] },
  landscapes:   { kind: BIBLE_KIND.PLACE,   tags: ['landscape'] },
  environments: { kind: BIBLE_KIND.PLACE,   tags: ['environment'] },
  structures:   { kind: BIBLE_KIND.OBJECT,    tags: ['structure'] },
  vehicles:     { kind: BIBLE_KIND.OBJECT,    tags: ['vehicle'] },
});
const resolveCanonForCategory = (categoryKey) =>
  CATEGORY_TO_CANON[categoryKey] || { kind: BIBLE_KIND.OBJECT, tags: [categoryKey] };

// Case-insensitive key for matching variation/composite labels across the
// original + LLM-refined sets. Returning the same lowercase string ensures
// "Lollipop Bureau" and "lollipop bureau" collapse to one identity.
export const normalizeLabelKey = (label) =>
  typeof label === "string" ? label.trim().toLowerCase() : "";

export const normalizeCategoryKey = (raw) => {
  if (!isStr(raw)) return '';
  return raw
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_')
    .slice(0, WORLD_CATEGORY_KEY_MAX);
};

// Matches the retired `characters` bucket and its variant spellings
// ("character_variations", "Characters", etc.) after key normalization.
const isCharactersBucket = (k) => /^characters?(_|$)/i.test(normalizeCategoryKey(k));

// Mint a stable id when raw is missing/blank. Variations and composite sheets
// historically had no id (just label+prompt); ensuring one now means rename and
// bucket-move preserve the linkage to the entry's rendered imageRefs[]. Existing
// non-empty ids are normalized (whitespace-trimmed and capped to 80 chars) on
// every read/write, so callers controlling ids (sync importer) should supply
// already-normalized values to ensure verbatim round-trip — any leading/trailing
// whitespace or excess length will be silently truncated.
//
// WARNING: minted ids are NOT persisted by readState() — every read of a
// legacy record mints a fresh UUID. Callers that queue async work referencing
// the id (e.g. an `entryRef` on a render job that a completion hook will
// resolve later) must force a write first via `needsEntryIdPersist(id)` +
// `updateUniverse(id, () => ({}))` so the queued id matches the next read.
const ensureEntryId = (raw, prefix) => {
  if (isStr(raw) && raw.trim()) return raw.trim().slice(0, 80);
  return `${prefix}${randomUUID()}`;
};

// Sanitize a filename-only image reference. Basename strip + traversal guards
// mirror server/lib/fileUtils.js#resolveGalleryImage — no FS check here because
// sanitize runs on every read. Stale-file collapse happens in the UI via the
// thumbnail's onError fallback.
export const sanitizeImageRefFilename = (raw) => {
  if (!isStr(raw)) return '';
  const trimmed = raw.trim().slice(0, IMAGE_REF_FILENAME_MAX);
  if (!trimmed) return '';
  // Reject any path separator before basename() — POSIX basename() doesn't
  // treat `\` as a separator, so a Windows-style traversal like `..\foo.png`
  // would otherwise pass through as a single token.
  if (/[/\\]/.test(trimmed)) return '';
  const safe = basename(trimmed);
  if (!safe || safe === '.' || safe === '..') return '';
  return safe;
};

// Render history for variations + composite sheets. Newest last. Deduped so a
// re-render that produced the same gallery filename doesn't bloat the list.
const sanitizeEntryImageRefs = (raw) => {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const v of raw) {
    const safe = sanitizeImageRefFilename(v);
    if (!safe || seen.has(safe)) continue;
    seen.add(safe);
    out.push(safe);
  }
  // Keep the most recent `IMAGE_REFS_PER_ENTRY_MAX` entries — older ones drop
  // off the front so the cap doesn't strand new renders.
  return out.length > IMAGE_REFS_PER_ENTRY_MAX
    ? out.slice(-IMAGE_REFS_PER_ENTRY_MAX)
    : out;
};

const sanitizeVariation = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const label = trimTo(raw.label, VARIATION_LABEL_MAX);
  const prompt = trimTo(raw.prompt, PROMPT_FRAGMENT_MAX);
  if (!label || !prompt) return null;
  // Per-item lock — when true, expand merges preserve this entry instead of
  // letting the LLM regenerate it. Default is `true` (locked) so newly-arriving
  // variations from extract / generate / manual add are protected by default;
  // only explicit `locked: false` records the user's unlock so it survives
  // round-trips through the sanitizer.
  const out = {
    id: ensureEntryId(raw.id, 'var-'),
    label,
    prompt,
    imageRefs: sanitizeEntryImageRefs(raw.imageRefs),
    locked: raw.locked === false ? false : true,
  };
  return out;
};

const sanitizeCompositeSheet = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const label = trimTo(raw.label, VARIATION_LABEL_MAX);
  const prompt = trimTo(raw.prompt, COMPOSITE_PROMPT_MAX);
  if (!label || !prompt) return null;
  const kind = COMPOSITE_SHEET_KINDS.includes(raw.kind) ? raw.kind : 'reference_sheet';
  // Default to locked — same rationale as sanitizeVariation; user explicitly
  // unlocks via `locked: false` and that survives round-trips.
  const out = {
    id: ensureEntryId(raw.id, 'sheet-'),
    kind,
    label,
    prompt,
    imageRefs: sanitizeEntryImageRefs(raw.imageRefs),
    locked: raw.locked === false ? false : true,
  };
  return out;
};

const sanitizeCategory = (raw, key) => {
  // Per-category structure: { kind, variations: [{ label, prompt }] }. Cap so a
  // runaway LLM can't blow up the universe template; matches the route schema.
  // `kind` tags the bucket to one of the 3 canon trunks (characters/places/
  // objects) or 'other'; resolveCategoryKind picks the best value from
  // (explicit input || built-in default || 'other').
  if (!raw || typeof raw !== 'object') {
    return { kind: resolveCategoryKind(key), variations: [] };
  }
  const variations = [];
  if (Array.isArray(raw.variations)) {
    for (const v of raw.variations) {
      const s = sanitizeVariation(v);
      if (!s) continue;
      variations.push(s);
      if (variations.length >= VARIATIONS_PER_CATEGORY_MAX) break;
    }
  }
  return { kind: resolveCategoryKind(key, raw.kind), variations };
};

// Merges an `incoming` category into `base`, concatenating variations under
// the cap and trusting `incoming.kind`. The sole caller (`sanitizeCategories`)
// always passes a `sanitizeCategory`-produced `incoming`, so kind is
// guaranteed valid — no fallback needed.
const mergeCategories = (base, next) => {
  const merged = { ...base };
  for (const [key, category] of Object.entries(next)) {
    const current = merged[key]?.variations || [];
    const incoming = category.variations;
    merged[key] = {
      kind: category.kind,
      variations: [...current, ...incoming].slice(0, VARIATIONS_PER_CATEGORY_MAX),
    };
  }
  return merged;
};

export const sanitizeCategories = (raw = {}) => {
  const categories = Object.fromEntries(
    WORLD_CATEGORIES.map((key) => [key, { kind: resolveCategoryKind(key), variations: [] }])
  );
  if (!raw || typeof raw !== 'object') return categories;

  let customCount = WORLD_CATEGORIES.length;
  for (const [rawKey, rawCategory] of Object.entries(raw)) {
    const key = normalizeCategoryKey(rawKey);
    if (!key) continue;
    // Retired buckets get dropped here; variations are folded into the
    // matching canon array by backfillCanonFromCategories, which runs
    // alongside this sanitizer in sanitizeTemplate.
    if (isCharactersBucket(key)) continue;
    if (!categories[key] && customCount >= WORLD_CATEGORY_COUNT_MAX) continue;
    if (!categories[key]) customCount += 1;
    Object.assign(categories, mergeCategories(categories, { [key]: sanitizeCategory(rawCategory, key) }));
  }
  return categories;
};

export const getWorldCategoryKeys = (categories = {}) => {
  const seen = new Set();
  const keys = [];
  for (const key of [...WORLD_CATEGORIES, ...Object.keys(categories || {})]) {
    const normalized = normalizeCategoryKey(key);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    keys.push(normalized);
  }
  return keys;
};

// Sanitize one influence list (embrace OR avoid):
// - drop non-strings, trim, slice to per-entry cap
// - drop empties + case-insensitive duplicates within the list
// - cap list length
const sanitizeInfluenceList = (raw) => {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const v of raw) {
    if (!isStr(v)) continue;
    const trimmed = v.trim().slice(0, INFLUENCE_ENTRY_MAX);
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= INFLUENCES_PER_LIST_MAX) break;
  }
  return out;
};

export const sanitizeInfluences = (raw = {}) => {
  if (!raw || typeof raw !== 'object') return { embrace: [], avoid: [] };
  return {
    embrace: sanitizeInfluenceList(raw.embrace),
    avoid: sanitizeInfluenceList(raw.avoid),
  };
};

// v2 → v3 migration helper. Splits a legacy comma/newline-separated prose
// prompt into individual chip tokens. Returns an array suitable for appending
// to an influence list before sanitization (sanitizeInfluenceList handles the
// per-entry cap, list cap, and dedupe).
const splitProsePrompt = (prose) => {
  if (typeof prose !== 'string') return [];
  return prose.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
};

// Append legacy prose stylePrompt / negativePrompt tokens onto the structured
// influences. Existing chip tokens stay at the front so the user's deliberate
// chip ordering is preserved; prose tokens land at the back and are deduped
// case-insensitively by the downstream sanitizeInfluenceList. Tolerates raw
// being missing / non-object.
export const mergeLegacyPromptsIntoInfluences = (rawInfluences, legacyStylePrompt, legacyNegativePrompt) => {
  const baseEmbrace = Array.isArray(rawInfluences?.embrace) ? rawInfluences.embrace : [];
  const baseAvoid = Array.isArray(rawInfluences?.avoid) ? rawInfluences.avoid : [];
  const extraEmbrace = splitProsePrompt(legacyStylePrompt);
  const extraAvoid = splitProsePrompt(legacyNegativePrompt);
  if (!extraEmbrace.length && !extraAvoid.length) return rawInfluences || {};
  return {
    embrace: [...baseEmbrace, ...extraEmbrace],
    avoid: [...baseAvoid, ...extraAvoid],
  };
};

// Build a refined influences object that honors per-list locks. Locked lists
// take their value from `fallback` (originals); unlocked lists take from
// `fresh` (the LLM output), falling back to `fallback` ONLY when the LLM
// omitted that list (key absent). An explicit `[]` is applied so the user
// can intentionally clear an unlocked list. Mirrors `mergeInfluencesWithLocks`
// in client/services/apiUniverseBuilder.js.
export const mergeInfluencesWithLocks = (locked, fresh, fallback) => {
  const freshSafe = sanitizeInfluences(fresh);
  const fallbackSafe = sanitizeInfluences(fallback);
  const freshHasEmbrace = Array.isArray(fresh?.embrace);
  const freshHasAvoid = Array.isArray(fresh?.avoid);
  return {
    embrace: locked?.influencesEmbrace
      ? fallbackSafe.embrace
      : (freshHasEmbrace ? freshSafe.embrace : fallbackSafe.embrace),
    avoid: locked?.influencesAvoid
      ? fallbackSafe.avoid
      : (freshHasAvoid ? freshSafe.avoid : fallbackSafe.avoid),
  };
};

// Refine-time variant: when a list is locked, preserve every existing token in
// order but allow the LLM to APPEND new tokens (case-insensitive de-dup). The
// user explicitly wants "lock = no rebuild, additions still welcome" in the
// holistic refine flow; Expand should keep using the strict variant above.
const appendUnique = (existing, additions) => {
  const seen = new Set(existing.map((t) => normalizeLabelKey(t)));
  const out = [...existing];
  for (const t of additions) {
    const key = normalizeLabelKey(t);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= INFLUENCES_PER_LIST_MAX) break;
  }
  return out;
};

export const mergeInfluencesWithLocksAdditive = (locked, fresh, fallback) => {
  const freshSafe = sanitizeInfluences(fresh);
  const fallbackSafe = sanitizeInfluences(fallback);
  // Distinguish "LLM omitted the list" (preserve fallback) from "LLM
  // returned []" (apply — user explicitly cleared the unlocked list).
  // The additive locked path is unaffected: an empty append-list is a no-op.
  const freshHasEmbrace = Array.isArray(fresh?.embrace);
  const freshHasAvoid = Array.isArray(fresh?.avoid);
  return {
    embrace: locked?.influencesEmbrace
      ? appendUnique(fallbackSafe.embrace, freshSafe.embrace)
      : (freshHasEmbrace ? freshSafe.embrace : fallbackSafe.embrace),
    avoid: locked?.influencesAvoid
      ? appendUnique(fallbackSafe.avoid, freshSafe.avoid)
      : (freshHasAvoid ? freshSafe.avoid : fallbackSafe.avoid),
  };
};

export const sanitizeLocked = (raw = {}) => {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const key of LOCKABLE_FIELDS) {
    if (raw[key] === true) out[key] = true;
  }
  // Migration: prior schema had a single `influences` lock covering both
  // embrace + avoid. Expand into the two per-list locks so existing universes
  // keep working without a data migration step.
  if (raw.influences === true) {
    out.influencesEmbrace = true;
    out.influencesAvoid = true;
  }
  return out;
};

export const sanitizeCompositeSheets = (raw = []) => {
  if (!Array.isArray(raw)) return [];
  const sheets = [];
  for (const sheet of raw) {
    const sanitized = sanitizeCompositeSheet(sheet);
    if (!sanitized) continue;
    sheets.push(sanitized);
    if (sheets.length >= COMPOSITE_SHEETS_MAX) break;
  }
  return sheets;
};

// Always-on fold of the retired `characters` category bucket into
// universe.characters[]. Runs regardless of schemaVersion so the Phase A
// retirement contract holds for every write path (createUniverse,
// updateUniverse, importer share-bucket, stale-client PATCH). Dedupes by
// normalized name so existing canon records are preserved on collision.
// Returns the (mutated-shape) canon arrays the caller should consume.
function foldRetiredCharactersBucket(raw, canon) {
  // `typeof null === 'object'` so the truthy check is load-bearing — without
  // it, a payload with `categories: null` would dereference null below and
  // throw inside sanitizeTemplate.
  const categories = raw && raw.categories && typeof raw.categories === 'object'
    ? raw.categories
    : {};
  let variations = null;
  for (const [rawKey, value] of Object.entries(categories)) {
    if (!isCharactersBucket(rawKey)) continue;
    const fromKey = Array.isArray(value)
      ? value
      : Array.isArray(value?.variations)
        ? value.variations
        : null;
    if (!fromKey) continue;
    variations = variations ? [...variations, ...fromKey] : fromKey;
  }
  if (!variations) return canon;
  const next = {
    characters: Array.isArray(canon.characters) ? [...canon.characters] : [],
    places: canon.places,
    objects: canon.objects,
  };
  // Index existing canon character names AND aliases — server-side
  // MERGE_CONFIG.character treats both as identity keys, so a retired-bucket
  // variation matching an existing alias should collide and NOT create a
  // duplicate. Without alias indexing, an "Ashley" character with alias
  // "Ash" plus a `categories.characters: [{label: "Ash"}]` payload would
  // produce two records. We keep a Set (rather than re-scanning the live
  // array via findBibleEntryByName each iteration) so the per-variation
  // membership test stays O(1) — folding a large retired bucket against a
  // large canon would otherwise be O(n*m).
  const seen = new Set();
  for (const e of next.characters) {
    if (e?.name) seen.add(normalizeBibleName(e.name));
    if (Array.isArray(e?.aliases)) {
      for (const alias of e.aliases) {
        const key = normalizeBibleName(alias);
        if (key) seen.add(key);
      }
    }
  }
  for (const variation of variations) {
    const labelSource = typeof variation === 'string' ? variation : variation?.label;
    const label = trimTo(labelSource, BIBLE_LIMITS.NAME_MAX);
    if (!label) continue;
    const nameKey = normalizeBibleName(label);
    if (seen.has(nameKey)) continue;
    // Do NOT cap by length here against raw canon entries — they haven't
    // been sanitized yet, and a malformed bunch of pre-existing entries
    // could cause this fold to skip legitimate variations. sanitizeBibleList
    // applies ENTRIES_PER_BIBLE_MAX after both arrays are merged and shape-
    // validated.
    const entry = {
      name: label,
      prompt: trimTo(typeof variation === 'object' ? variation?.prompt : '', BIBLE_LIMITS.PROMPT_MAX),
      tags: [],
      source: BIBLE_SOURCE.UNIVERSE_EXPAND,
    };
    if (typeof variation === 'object' && variation?.locked === true) entry.locked = true;
    next.characters.push(entry);
    seen.add(nameKey);
  }
  return next;
}

// Backfill canon arrays from v1 `categories[].variations[]`. Idempotent:
// entries matching an existing canon name (case-insensitive) are skipped, so
// hand-authored / series-extracted records are never overwritten. The
// retired `characters` bucket is handled by foldRetiredCharactersBucket
// before this runs; here we only fold the *other* legacy categories
// (landscapes/environments/structures/vehicles + customs) into
// places/objects for the v3→v4 transition.
function backfillCanonFromCategories(raw, existingCanon) {
  // v4 hot path — already backfilled. Sanitize through the kind sanitizers
  // once and return; no category scan needed.
  if (raw.schemaVersion >= CURRENT_SCHEMA_VERSION) {
    return {
      characters: sanitizeBibleList(existingCanon.characters, BIBLE_KIND.CHARACTER),
      places: sanitizeBibleList(existingCanon.places, BIBLE_KIND.PLACE),
      objects: sanitizeBibleList(existingCanon.objects, BIBLE_KIND.OBJECT),
      schemaVersion: raw.schemaVersion,
    };
  }

  const next = {
    characters: Array.isArray(existingCanon.characters) ? [...existingCanon.characters] : [],
    places: Array.isArray(existingCanon.places) ? [...existingCanon.places] : [],
    objects: Array.isArray(existingCanon.objects) ? [...existingCanon.objects] : [],
  };
  const nameSeen = {
    characters: new Set(next.characters.map((e) => normalizeBibleName(e?.name))),
    places: new Set(next.places.map((e) => normalizeBibleName(e?.name))),
    objects: new Set(next.objects.map((e) => normalizeBibleName(e?.name))),
  };

  const categories = raw && typeof raw.categories === 'object' ? raw.categories : {};
  for (const [rawKey, value] of Object.entries(categories)) {
    const categoryKey = normalizeCategoryKey(rawKey) || rawKey;
    // Skip retired characters buckets — foldRetiredCharactersBucket
    // already handled them on the always-on path.
    if (isCharactersBucket(categoryKey)) continue;
    const { kind, tags } = resolveCanonForCategory(categoryKey);
    const targetField = BIBLE_FIELD[kind];
    const variations = Array.isArray(value?.variations) ? value.variations : [];
    for (const variation of variations) {
      const label = trimTo(variation?.label, BIBLE_LIMITS.NAME_MAX);
      if (!label) continue;
      const nameKey = normalizeBibleName(label);
      if (nameSeen[targetField].has(nameKey)) continue;
      if (next[targetField].length >= BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX) break;
      const entry = {
        name: label,
        prompt: trimTo(variation?.prompt, BIBLE_LIMITS.PROMPT_MAX),
        tags,
        source: BIBLE_SOURCE.UNIVERSE_EXPAND,
      };
      if (variation?.locked === true) entry.locked = true;
      // Place sanitizer requires a name OR slugline; planting the label as
      // both preserves the variation identity for scene-matchers.
      if (kind === BIBLE_KIND.PLACE) entry.slugline = label;
      next[targetField].push(entry);
      nameSeen[targetField].add(nameKey);
    }
  }

  return {
    characters: sanitizeBibleList(next.characters, BIBLE_KIND.CHARACTER),
    places: sanitizeBibleList(next.places, BIBLE_KIND.PLACE),
    objects: sanitizeBibleList(next.objects, BIBLE_KIND.OBJECT),
    schemaVersion: CURRENT_SCHEMA_VERSION,
  };
}

export const sanitizeTemplate = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  if (!isStr(raw.id) || !raw.id) return null;
  const name = trimTo(raw.name, NAME_MAX_LENGTH);
  if (!name) return null;
  const starterPrompt = trimTo(raw.starterPrompt, STARTER_PROMPT_MAX);
  const logline = trimTo(raw.logline, LOGLINE_MAX);
  const premise = trimTo(raw.premise, PREMISE_MAX);
  const styleNotes = trimTo(raw.styleNotes, STYLE_NOTES_MAX);
  const categories = sanitizeCategories(raw.categories || {});
  const compositeSheets = sanitizeCompositeSheets(raw.compositeSheets || []);
  // Legacy v2 universes carried prose stylePrompt / negativePrompt fields
  // alongside influences. v3 collapses both into the chip-based influences
  // editor: split each prose field on commas/newlines and append to the
  // matching list. sanitizeInfluenceList handles trim, cap, and
  // case-insensitive dedupe so a token that already exists as a chip is not
  // re-added by the migration.
  const influences = sanitizeInfluences(
    mergeLegacyPromptsIntoInfluences(raw.influences, raw.stylePrompt, raw.negativePrompt),
  );
  const locked = sanitizeLocked(raw.locked);
  // Canon registries. Two passes:
  //   1. foldRetiredCharactersBucket — Phase A retirement contract. ALWAYS
  //      runs (regardless of schemaVersion) so a `categories.characters`
  //      bucket arriving from any write path folds into universe.characters[].
  //   2. backfillCanonFromCategories — legacy v3→v4 migration. Runs ONLY for
  //      pre-v4 reads, folds all OTHER category buckets (landscapes/vehicles/
  //      custom) into places/objects. New v4 universes skip this so Phase
  //      B's separation of canon (named entities) and categories (exploratory
  //      variations) stays clean.
  const foldedCanon = foldRetiredCharactersBucket(raw, {
    characters: raw.characters,
    places: raw.places,
    objects: raw.objects,
  });
  const canonBackfill = backfillCanonFromCategories(raw, foldedCanon);
  const { schemaVersion } = canonBackfill;
  // Default-lock universe canon entries. Existing records on disk that pre-
  // date the lock-by-default contract have no `locked` field; stamp `true`
  // here so reads return a locked view. Explicit `locked: false` is preserved
  // verbatim so a user-unlock survives round-trips (applyCanonExtras now
  // persists both true and false).
  const defaultLockCanon = (list) => (Array.isArray(list) ? list : []).map((e) =>
    e && typeof e === 'object' && e.locked === undefined ? { ...e, locked: true } : e
  );
  const characters = defaultLockCanon(canonBackfill.characters);
  const places = defaultLockCanon(canonBackfill.places);
  const objects = defaultLockCanon(canonBackfill.objects);
  const llm = raw.llm && typeof raw.llm === 'object'
    ? {
      provider: trimTo(raw.llm.provider, 80) || null,
      model: trimTo(raw.llm.model, 200) || null,
    }
    : { provider: null, model: null };
  const createdAt = isStr(raw.createdAt) ? raw.createdAt : new Date().toISOString();
  const updatedAt = isStr(raw.updatedAt) ? raw.updatedAt : createdAt;
  // Soft-delete fields — peer sync needs the tombstone in the record itself
  // so LWW merge can resolve delete-vs-edit races by `updatedAt`. Existing
  // records without these fields read as live (deleted=false, deletedAt=null).
  const { deleted, deletedAt } = sanitizeSoftDeleteFields(raw);
  return {
    id: raw.id,
    name,
    starterPrompt,
    logline,
    premise,
    styleNotes,
    categories,
    compositeSheets,
    influences,
    // Base "style probe" renders — images generated from the raw style preset
    // (influences embrace/avoid + styleNotes) with NO subject, so the user can
    // see the world's base visual emphasis. Additive + regenerable; sanitized
    // like canon imageRefs (dedupe + cap). WIRE-LOCAL: stripped from every
    // universe payload by sanitizeRecordForWire (so an older peer can't
    // drop-then-LWW-strip it off a newer one) and excluded from the
    // conflict-journal content hash (which reuses that projection). Per-peer +
    // one-click to regenerate, so no schema-version gate is needed.
    styleImageRefs: sanitizeEntryImageRefs(raw.styleImageRefs),
    locked,
    characters,
    places,
    objects,
    schemaVersion,
    llm,
    // Share-bucket provenance — present on imported records, absent on locally-authored ones.
    origin: sanitizeOrigin(raw.origin),
    createdAt,
    updatedAt,
    deleted,
    deletedAt,
    // Local-only "don't sync to peers" marker. Only persisted when true so
    // every existing universe keeps the same on-disk shape — and so the wire
    // checksum stays byte-stable for non-ephemeral records (see
    // sanitizeRecordForWire). Mark a scratch universe ephemeral to keep it
    // off the federation; test fixtures stamp this too.
    ...(raw.ephemeral === true ? { ephemeral: true } : {}),
    // Importer-orphan marker (issue #727). Stamped only by analyzeImport on a
    // brand-new shell so the orphan-shell GC can distinguish an abandoned
    // analyze from a user's deliberately-private empty universe (which is also
    // `ephemeral`). commitImport clears it on promotion. Server-set only —
    // never accepted from a route body — and persisted only when true so the
    // on-disk shape and wire checksum stay stable for every other record.
    ...(raw.importDraft === true ? { importDraft: true } : {}),
  };
};

export const sanitizeRun = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  if (!isStr(raw.id) || !raw.id) return null;
  if (!isStr(raw.universeId) || !raw.universeId) return null;
  return {
    id: raw.id,
    universeId: raw.universeId,
    collectionId: isStr(raw.collectionId) ? raw.collectionId : null,
    jobIds: Array.isArray(raw.jobIds) ? raw.jobIds.filter(isStr).slice(0, MAX_RUN_JOB_IDS) : [],
    promptCount: Number.isFinite(raw.promptCount) ? raw.promptCount : 0,
    createdAt: isStr(raw.createdAt) ? raw.createdAt : new Date().toISOString(),
  };
};
