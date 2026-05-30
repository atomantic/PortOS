/**
 * Universe Builder Service
 *
 * Stores user-created "universe templates" — sci-fi/fantasy/etc. universe
 * descriptions expanded by an LLM into a structured prompt set:
 *
 *   - influences.embrace / influences.avoid (token lists managed as draggable
 *     chips) act as both the style prompt and the negative prompt — they are
 *     joined verbatim at render-compile time and form the single source of
 *     truth for the universe's positive + negative tokens.
 *   - categories: named prompt buckets, seeded with common universe-art buckets
 *     like landscapes / characters / vehicles, but open to project-specific
 *     buckets like colonies, factions, species, clothing_styles, or raider_clans
 *     (each with a list of `variations` — short prompt fragments)
 *   - compositeSheets: complete board/poster prompts that combine several
 *     buckets into one image, e.g. a colony costume guide or a universe summary
 *     concept pitch poster
 *
 * From those pieces the route can compile a flat list of full prompts and
 * enqueue them as image-gen jobs, all tagged with the same `universeId` and
 * `runId` so the resulting renders form a self-contained collection.
 *
 * Persisted to data/universe-builder.json. Renders for a run land in a
 * media-collections.json collection named "Universe: <worldName>" (or any
 * other name the user picks at kickoff).
 */

import { join, basename } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, atomicWrite, ensureDir, resolveImageRef } from '../lib/fileUtils.js';
import { createCollectionStore } from '../lib/collectionStore.js';
import { composeStyledPrompt } from '../lib/composeStyledPrompt.js';
import { flattenCanonDescriptorFragments, richCanonDescriptorFragments } from '../lib/canonPrompt.js';
import {
  sanitizeBibleList, BIBLE_KIND, BIBLE_FIELD, BIBLE_LIMITS, BIBLE_SOURCE,
  pruneStaleReferenceSheets, mergePreservedSheetPointers,
  normalizeBibleName, isStr, trimTo,
} from '../lib/storyBible.js';
import { sanitizeOrigin } from '../lib/sharingOrigin.js';
import { sanitizeSoftDeleteFields } from '../lib/syncWire.js';
import {
  maybeJournalBeforeOverwrite, setSyncBaseHash, contentHashForRecord, flushBaseHashes,
  deleteSyncBaseHash,
} from '../lib/conflictJournal.js';
import { emitRecordUpdated, emitRecordDeleted } from './sharing/recordEvents.js';
import { renameCollectionForUniverse, unlinkCollectionsForUniverse } from './mediaCollections.js';
import {
  clearPendingSheetSlot, clearPendingSheetSlotsForUniverse,
} from './universeCharacterSheetSlot.js';
// Hierarchy guard: a universe can't be deleted while live series reference it.
// series.js does NOT import universeBuilder (one-directional), so this static
// import is cycle-safe — unlike canonUsage.js, which back-imports this module.
import { listSeries } from './pipeline/series.js';

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

// TYPE-level (storage layout) schema version stamped on `data/universes/index.json`.
//   v5 — universes split out of monolithic `data/universe-builder.json` into
//        per-record `data/universes/{id}/index.json`. Cross-record `runs[]`
//        moves into `index.json`'s `config.runs`. See migration 034.
const TYPE_SCHEMA_VERSION = 5;

// Lazy store factory so test harnesses that swap PATHS.data per-test
// (mkdtempSync + Proxy mock) still see the right temp root — the store
// captures PATHS.data once at first call, then stays warm.
let _store = null;
const store = () => {
  if (_store && _store.dir === join(PATHS.data, 'universes')) return _store;
  _store = createCollectionStore({
    dir: join(PATHS.data, 'universes'),
    type: 'universes',
    schemaVersion: TYPE_SCHEMA_VERSION,
    sanitizeRecord: sanitizeTemplate,
    // Permissive — defense-in-depth against stray non-id entries from
    // readdir, not an authoritative validator. The 8–80 / dash-only rule
    // lives on UNIVERSE_ID_RE inside insertUniverseWithId, which is where
    // user-supplied ids actually arrive.
    idPattern: /^[A-Za-z0-9_-]{1,128}$/,
  });
  return _store;
};

/**
 * Exported for the boot-time verifier in `server/index.js`. Lazy because the
 * universe-builder module loads BEFORE PATHS.data resolves in some test
 * harnesses; calling this getter at boot time picks up the right root.
 */
export const universeStore = () => store();

export const ERR_NOT_FOUND = 'NOT_FOUND';
export const ERR_VALIDATION = 'VALIDATION_ERROR';
export const ERR_DUPLICATE = 'DUPLICATE';
// Raised by deleteUniverse when live series still reference the universe. The
// thrown error carries `blockingSeries: [{id,name}]` so the route can tell the
// user which series to move or delete first. Maps to HTTP 409.
export const ERR_HAS_LIVE_SERIES = 'UNIVERSE_HAS_LIVE_SERIES';
const makeErr = (message, code) => Object.assign(new Error(message), { code });

// Universe ids are bare UUIDs (no prefix). Accept any reasonable alphanumeric
// id 8–80 chars so future id-scheme changes upstream still round-trip; the
// importer is the only caller, and it gets ids from manifests it controls.
const UNIVERSE_ID_RE = /^[A-Za-z0-9-]{8,80}$/;

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
const sanitizeImageRefFilename = (raw) => {
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

const sanitizeTemplate = (raw) => {
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
    // like canon imageRefs (dedupe + cap). Not wire-version-gated (low-stakes,
    // one-click to regenerate if an older peer round-trips and strips it).
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
  };
};

const sanitizeRun = (raw) => {
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

// Once-per-process flag for the canon-backfill log — readState() runs in both
// the queue and from un-queued readers, and the in-memory migration is cheap
// to recompute every read, but the log line should fire once.
let canonBackfillLogged = false;

async function readState() {
  await ensureDir(PATHS.data);
  const s = store();
  // Load raw records in parallel (no sanitizer) so we can detect schema-
  // version drift before the in-memory sanitization step. We deliberately
  // do NOT use store.loadAll() here — that runs sanitizeRecord, losing the
  // pre-sanitized schemaVersion needed for the backfill log.
  const ids = await s.listIds();
  const rawRecords = await Promise.all(ids.map((id) => s.loadOneRaw(id)));
  const rawById = new Map();
  for (const r of rawRecords) {
    if (r && typeof r.id === 'string') rawById.set(r.id, r);
  }
  const universes = rawRecords.map((r) => sanitizeTemplate(r)).filter(Boolean);
  const typeIndex = await s.loadTypeIndex();
  const runs = Array.isArray(typeIndex.config?.runs)
    ? typeIndex.config.runs.map(sanitizeRun).filter(Boolean)
    : [];
  // The in-memory result is always at CURRENT_SCHEMA_VERSION (sanitizeTemplate
  // re-stamps it on every read). Don't persist the migration here — that
  // write would race against any concurrent per-record mutator and could
  // overwrite a freshly-patched record with the pre-patch migration baseline.
  // The next per-record write persists the migrated shape naturally.
  if (!canonBackfillLogged) {
    const migrated = universes.filter((u) => (rawById.get(u.id)?.schemaVersion || 0) < CURRENT_SCHEMA_VERSION);
    if (migrated.length > 0) {
      console.log(`🌍 Universe Builder canon backfill — migrated ${migrated.length} universe(s) in-memory to schemaVersion=${CURRENT_SCHEMA_VERSION}; persists on next write`);
      canonBackfillLogged = true;
    }
  }
  return { universes, runs };
}

export async function listUniverses({ includeDeleted = false } = {}) {
  const { universes } = await readState();
  const filtered = includeDeleted ? universes : universes.filter((u) => !u.deleted);
  // Newest first — matches user expectation for a "your universes" list.
  return [...filtered].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export async function getUniverse(id, { includeDeleted = false } = {}) {
  // Direct per-record load — no full collection scan needed for a by-id read.
  // The store's sanitizer (sanitizeTemplate) runs on the loaded record, so the
  // returned object is shape-equivalent to what listUniverses would surface.
  const w = await store().loadOne(id);
  if (!w) throw makeErr(`Universe not found: ${id}`, ERR_NOT_FOUND);
  if (w.deleted && !includeDeleted) throw makeErr(`Universe not found: ${id}`, ERR_NOT_FOUND);
  return w;
}

// Returns true when the raw on-disk universe carries variations or composite
// sheets that are missing a stable `id` field — i.e. sanitizeTemplate would
// mint fresh UUIDs (and those UUIDs would differ on every read until the
// migration is persisted). The render route uses this to gate a one-time
// no-op write before queueing jobs whose `entryRef.id` must match the on-disk
// record at completion time. Reads raw JSON without sanitizing, so callers
// can skip the write entirely when the universe is already fully migrated —
// avoiding unwanted `updatedAt` bumps that would otherwise interfere with
// LWW sync and trigger spurious re-export/notification emits.
export async function needsEntryIdPersist(id) {
  // Raw read (no sanitizer) so we inspect the on-disk shape, not the
  // freshly-minted ids the sanitizer would stamp in-memory.
  const rec = await store().loadOneRaw(id);
  if (!rec || rec.deleted) return false;
  const cats = rec.categories && typeof rec.categories === 'object' ? rec.categories : {};
  for (const cat of Object.values(cats)) {
    const vars = Array.isArray(cat?.variations) ? cat.variations : [];
    for (const v of vars) {
      if (!isStr(v?.id) || !v.id.trim()) return true;
    }
  }
  const sheets = Array.isArray(rec.compositeSheets) ? rec.compositeSheets : [];
  for (const s of sheets) {
    if (!isStr(s?.id) || !s.id.trim()) return true;
  }
  return false;
}

export async function createUniverse(input = {}) {
  const name = trimTo(input.name, NAME_MAX_LENGTH);
  if (!name) throw makeErr(`Universe name is required (1..${NAME_MAX_LENGTH} chars)`, ERR_VALIDATION);
  const id = randomUUID();
  const created = await store().queueRecordWrite(id, async () => {
    const now = new Date().toISOString();
    const next = sanitizeTemplate({
      id,
      name,
      starterPrompt: input.starterPrompt || '',
      stylePrompt: input.stylePrompt || '',
      negativePrompt: input.negativePrompt || '',
      logline: input.logline || '',
      premise: input.premise || '',
      styleNotes: input.styleNotes || '',
      categories: input.categories || {},
      compositeSheets: input.compositeSheets || [],
      influences: input.influences || {},
      styleImageRefs: input.styleImageRefs || [],
      locked: input.locked || {},
      // Canon registries — let callers seed a universe at creation time
      // (writers-room promote, share-bucket import). sanitizeTemplate runs
      // each through sanitizeBibleList, so per-entry shape is enforced.
      characters: input.characters || [],
      places: input.places || [],
      objects: input.objects || [],
      // Stamp the current schema so backfillCanonFromCategories takes its
      // hot-path skip on first read. Without this, the legacy categories→
      // canon backfill fires on every brand-new universe and re-pollutes
      // `characters/places/objects` with every category variation —
      // counter to Phase B's separation of canon (named entities) from
      // categories (exploratory variations). New universes are always at
      // CURRENT_SCHEMA_VERSION; the backfill exists only for legacy reads.
      schemaVersion: CURRENT_SCHEMA_VERSION,
      llm: input.llm || {},
      createdAt: now,
      updatedAt: now,
      // Optional local-only marker — when true, every sync transport
      // (snapshot loop + per-record push) skips this universe (see
      // sanitizeRecordForWire) and the auto-subscribe below short-circuits.
      ephemeral: input.ephemeral === true,
    });
    // Write through the store — we're inside the per-id queue so use
    // atomicWrite directly to avoid re-queueing on the same id.
    await ensureDir(store().recordDir(next.id));
    await atomicWrite(store().recordPath(next.id), next);
    return next;
  });
  // Fire-and-forget auto-subscribe to every peer with universe-sync enabled.
  // Skip the auto-subscribe entirely for ephemeral universes — the push
  // would short-circuit anyway via sanitizeRecordForWire returning null, but
  // not creating the subscription in the first place keeps peer_subscriptions.json
  // free of orphan rows tied to records the user explicitly excluded.
  // Dynamic import keeps peerSync.js OUT of the universeBuilder module-load
  // graph — peerSync already imports getUniverse / mergeUniversesFromSync
  // from here, so a static import would close a cycle.
  if (!created.ephemeral) {
    import('./sharing/peerSync.js').then(({ autoSubscribeRecordToAllPeers }) =>
      autoSubscribeRecordToAllPeers('universe', created.id)
    ).catch((err) => {
      console.log(`⚠️ universe: auto-subscribe after create failed: ${err.message}`);
    });
  }
  return created;
}

/**
 * Insert a universe with a caller-supplied id (used by the share-bucket
 * importer so re-imports of the same universe LWW-merge onto the same local
 * row). Throws ERR_DUPLICATE / ERR_VALIDATION on contract violations.
 */
export async function insertUniverseWithId(input = {}) {
  if (!isStr(input.id) || !UNIVERSE_ID_RE.test(input.id)) {
    throw makeErr(`insertUniverseWithId: invalid id "${input.id}"`, ERR_VALIDATION);
  }
  const name = trimTo(input.name, NAME_MAX_LENGTH);
  if (!name) throw makeErr(`Universe name is required (1..${NAME_MAX_LENGTH} chars)`, ERR_VALIDATION);
  const s = store();
  const { next, wasResurrection } = await s.queueRecordWrite(input.id, async () => {
    // Tombstone-overwrite: a previously-deleted record with the same id is
    // overwritten (effectively undeleted) — this keeps the share-bucket
    // re-import flow idempotent (deleting then re-importing the same manifest
    // restores the universe rather than 409ing). The peer-sync resurrection
    // hazard is already prevented by `mergeUniversesFromSync`'s LWW check,
    // which is the transport the federation uses.
    const existing = await s.loadOne(input.id);
    if (existing && !existing.deleted) {
      throw makeErr(`Universe id already exists: ${input.id}`, ERR_DUPLICATE);
    }
    const wasResurrection = !!existing;
    const next = sanitizeTemplate({ ...input, name });
    if (!next) throw makeErr('Invalid universe payload', ERR_VALIDATION);
    if (wasResurrection) {
      console.warn(`♻️  insertUniverseWithId: overwriting tombstone for ${input.id}`);
    }
    await ensureDir(s.recordDir(next.id));
    await atomicWrite(s.recordPath(next.id), next);
    return { next, wasResurrection };
  });
  // Mirror createUniverse's federation side-effects on tombstone-overwrite:
  // peers that still have the deleted record need the resurrection propagated.
  if (wasResurrection && !next.ephemeral) {
    emitRecordUpdated('universe', next.id);
    import('./sharing/peerSync.js').then(({ autoSubscribeRecordToAllPeers }) =>
      autoSubscribeRecordToAllPeers('universe', next.id)
    ).catch((err) => {
      console.log(`⚠️ universe: auto-subscribe after resurrection failed: ${err.message}`);
    });
  }
  return next;
}

export async function updateUniverse(id, patchOrMutator = {}, options = {}) {
  // The queued section covers only the universe-builder read/modify/write
  // cycle. The cross-file media-collection rename runs *after* the queue
  // releases so a slow/stuck collection write can't block unrelated universe
  // mutators (the universe row is already persisted by then).
  //
  // `patchOrMutator` overloads:
  //   - Plain object: patch is applied directly inside the queue (legacy).
  //   - `async (latest) => patch | null`: mutator runs INSIDE the queue with
  //     the freshest persisted record so callers whose read-modify-write
  //     straddles a slow LLM call can't race a concurrent edit. Returning
  //     `null`/`undefined` short-circuits the write and resolves with the
  //     unchanged record (no `updatedAt` bump, no rename cascade, no
  //     `recordUpdated` emit).
  //
  // `options.silent: true` suppresses the post-write `emitRecordUpdated`
  // peer-sync fan-out — used by the bible→catalog backfill which would
  // otherwise emit one event per universe at boot on every install. The
  // universe is still persisted; peers learn about the change on the next
  // normal sync cycle.
  const isMutator = typeof patchOrMutator === 'function';
  const { silent = false } = options;
  const s = store();
  const { merged, nameChanged, skipped, removedCharacterIds, prevEphemeral, nextEphemeral } = await s.queueRecordWrite(id, async () => {
    const cur = await s.loadOne(id);
    if (!cur) throw makeErr(`Universe not found: ${id}`, ERR_NOT_FOUND);
    if (cur.deleted) throw makeErr(`Universe not found: ${id}`, ERR_NOT_FOUND);

    let patch;
    if (isMutator) {
      patch = await patchOrMutator(cur);
      if (patch === null || patch === undefined) {
        return { merged: cur, nameChanged: false, skipped: true };
      }
      // `typeof === 'object'` matches arrays and null — reject both so a stray
      // `return []` can't slip through and silently no-op the categories merge.
      if (Array.isArray(patch) || typeof patch !== 'object') {
        throw makeErr('updateUniverse mutator must return a plain object or null', ERR_VALIDATION);
      }
    } else {
      patch = patchOrMutator;
    }

    // Merge `categories` per-key — a partial PATCH that only includes
    // `landscapes` must NOT wipe characters/structures/etc. Whole categories
    // not present in the patch are kept as-is from the current universe.
    const mergedCategories = 'categories' in patch
      ? { ...cur.categories, ...(patch.categories || {}) }
      : cur.categories;

    // Merge `llm` field-by-field — sending only `{ provider }` shouldn't
    // clear `model` and vice versa.
    const mergedLlm = 'llm' in patch
      ? { ...(cur.llm || {}), ...(patch.llm || {}) }
      : cur.llm;

    // `locked` replaces wholesale when the patch sends it (so unticking a lock
    // actually unlocks). Skipped when the patch omits it.
    const mergedLocked = 'locked' in patch ? (patch.locked || {}) : (cur.locked || {});

    // `influences` also replaces wholesale (each list is the user's full
    // intended state — partial merging would leave stale entries the user
    // thought they removed).
    const mergedInfluences = 'influences' in patch ? (patch.influences || {}) : (cur.influences || {});

    // Scalar fields: only apply what the patch actually carries, so a partial
    // PATCH never clobbers a field the caller didn't send. `categories` + `llm`
    // + `locked` are handled above (they need per-key merging or wholesale
    // replacement, not the simple scalar copy).
    const PATCHABLE_SCALARS = [
      'name', 'starterPrompt',
      'logline', 'premise', 'styleNotes', 'compositeSheets',
      // Base style-probe render refs — patched wholesale (sanitizer re-caps).
      'styleImageRefs',
      // Canon entity arrays — patched wholesale (the sanitizer reruns
      // sanitizeBibleList so per-entry shape is enforced on every save).
      'characters', 'places', 'objects',
      // Share-bucket origin metadata (importer sets it; user clears via wholesale null).
      'origin',
      // Local-only "don't sync" marker — see sanitizeTemplate. The safety
      // property is one-directional: ONLY a literal `true` marks the record
      // ephemeral; every other value (`false`, `'true'`, `1`, etc.) is
      // dropped at the sanitizer back to absent — i.e. sync-enabled. A
      // mutator PATCH like `{ ephemeral: 'false' }` therefore CLEARS the
      // flag (re-enabling sync), it does NOT mark the record ephemeral.
      // The asymmetry is intentional: protecting "private by default" is
      // not the goal — protecting "you can't accidentally truthy your way
      // into ephemeral and never sync again" is.
      'ephemeral',
    ];
    const scalarPatch = Object.fromEntries(
      PATCHABLE_SCALARS.filter((k) => k in patch).map((k) => [k, patch[k]]),
    );
    // Server-owned operational fields on characters (see
    // SERVER_OWNED_CHARACTER_FIELDS in storyBible.js) are written only by
    // server-side render-completion mutators. A literal-object PATCH that
    // round-trips a character body the client loaded before a newer
    // render finished would otherwise clobber the freshly-stamped
    // pointer (multi-tab / parallel render race). Preserve cur's value
    // per-(id, field); new characters in the patch start fresh.
    //
    // ONLY applies to literal-object patches. The mutator path is the
    // trusted writer here — `onSheetComplete` reads `cur` itself and
    // intentionally constructs a patch with the newly stamped value, so
    // running preservation against its output would clobber the stamp
    // back to the OLD/null value and the sheet would never persist. The
    // sharing importer wraps `updateUniverse(id, () => record)` for the
    // same reason — sync's intent is LWW including operational pointers,
    // so it opts into the mutator-bypass.
    if (!isMutator
      && Array.isArray(scalarPatch.characters)
      && Array.isArray(cur.characters)) {
      const curById = new Map(cur.characters.filter((c) => c?.id).map((c) => [c.id, c]));
      // Preserve cur's server-stamped sheet pointers ONLY when they still
      // resolve on disk. Without the FS check, this guard reintroduces
      // stale pointers that the GET route's lazy `pruneStaleReferenceSheets`
      // already nulled out: GET → null (file gone) → client PATCH carries
      // null → guard overwrites null with cur's stale filename → thumbnail
      // 404s again. The map variant (`referenceSheets`) merges per-key so a
      // freshly-stamped blueprint can't be clobbered by a patch that omits
      // the field while a separately-rendered standard sheet survives.
      const checkExists = (name) => !!resolveImageRef(name, { mustExist: true });
      scalarPatch.characters = scalarPatch.characters.map((c) => {
        const prev = c?.id ? curById.get(c.id) : null;
        if (!prev) return c;
        return mergePreservedSheetPointers(prev, c, checkExists);
      });
    }

    // Server-stamped render history on variations + composite sheets. The
    // collection hook is the sole writer (via the mutator-form of
    // updateUniverse, which bypasses this guard). A literal-object PATCH that
    // round-trips the variation body the client loaded before a render
    // completed would otherwise clobber the freshly-appended filename. Match
    // by `id` and preserve cur's `imageRefs` when it has more entries than
    // the patch OR when their tails differ (the at-cap rotation case, where
    // an append drops the oldest and lengths stay equal). Same-length +
    // same-tail means the client is current and the patch survives — note
    // that as a corollary, an empty patched list against a non-empty cur is
    // treated as stale and cur's history is preserved (the current UI has
    // no explicit-clear control, so this is the safer default).
    if (!isMutator && 'categories' in patch && patch.categories && typeof patch.categories === 'object') {
      for (const [catKey, catVal] of Object.entries(mergedCategories)) {
        if (!catVal || !Array.isArray(catVal.variations)) continue;
        const curCat = cur.categories?.[catKey];
        if (!curCat || !Array.isArray(curCat.variations)) continue;
        // Only run preservation against categories the patch actually sent —
        // categories preserved verbatim from cur already have the right imageRefs.
        if (!(catKey in patch.categories)) continue;
        mergedCategories[catKey] = {
          ...catVal,
          variations: preserveImageRefsById(catVal.variations, curCat.variations),
        };
      }
    }
    if (!isMutator && Array.isArray(scalarPatch.compositeSheets) && Array.isArray(cur.compositeSheets)) {
      scalarPatch.compositeSheets = preserveImageRefsById(scalarPatch.compositeSheets, cur.compositeSheets);
    }

    const mergedRecord = sanitizeTemplate({
      ...cur,
      ...scalarPatch,
      // sanitizeTemplate runs the v2 → v3 prose-prompt merge — see its
      // `mergeLegacyPromptsIntoInfluences` call.
      ...(patch.stylePrompt !== undefined ? { stylePrompt: patch.stylePrompt } : {}),
      ...(patch.negativePrompt !== undefined ? { negativePrompt: patch.negativePrompt } : {}),
      categories: mergedCategories,
      influences: mergedInfluences,
      locked: mergedLocked,
      llm: mergedLlm,
      updatedAt: new Date().toISOString(),
    });
    if (!mergedRecord) throw makeErr('Invalid universe payload', ERR_VALIDATION);
    // Persist the stale-reference-sheet null at write time so the on-disk
    // record catches up with what the GET-route pruner shows. Otherwise a
    // PATCH that omits `characters` (e.g. rename) merges from `cur` and
    // returns the stale filename, and the UI re-renders the broken thumbnail.
    // Render-completion writes are unaffected — the renderer copies the file
    // BEFORE its mutator runs, so the just-stamped pointer resolves on disk
    // and the prune skips it.
    if (Array.isArray(mergedRecord.characters)) {
      mergedRecord.characters = pruneStaleReferenceSheets(mergedRecord.characters);
    }
    await ensureDir(s.recordDir(id));
    await atomicWrite(s.recordPath(id), mergedRecord);
    // Diff inside the queue so we read against the freshest merged state;
    // gate on patches that could have touched characters (mutator or
    // literal-PATCH carrying `characters`) — rename/scalar PATCHes are the
    // common case and skip the Set construction entirely.
    let removedCharacterIds = null;
    if (isMutator || 'characters' in patch) {
      const idsOf = (arr) => (Array.isArray(arr)
        ? arr.filter((c) => c?.id).map((c) => c.id) : []);
      const prevIds = new Set(idsOf(cur.characters));
      const nextIds = new Set(idsOf(mergedRecord.characters));
      removedCharacterIds = [...prevIds].filter((id) => !nextIds.has(id));
    }
    return {
      merged: mergedRecord,
      nameChanged: mergedRecord.name !== cur.name,
      skipped: false,
      removedCharacterIds,
      // Surface the (prev, next) ephemeral pair so the post-queue side
      // effects can wire subscribe / unsubscribe for the transition.
      // Compare against `cur` (the pre-merge record) so transitions are
      // detected regardless of patch shape (literal-object or mutator).
      prevEphemeral: cur.ephemeral === true,
      nextEphemeral: mergedRecord.ephemeral === true,
    };
  });
  if (skipped) return merged;
  // Slot map is in-process; without this it persists past the logical delete.
  for (const removedId of removedCharacterIds ?? []) {
    clearPendingSheetSlot(id, removedId);
  }
  // Cascade rename onto the linked media collection — log but don't fail
  // the save: a stale collection name is recoverable, a failed save isn't.
  // Runs OUTSIDE the queue so the media-collections write tail can't stall
  // subsequent universe mutators.
  if (nameChanged) {
    await renameCollectionForUniverse(merged.id, merged.name).catch((err) => {
      console.error(`❌ universe-collection rename cascade failed for ${merged.id}: ${err?.message || err}`);
    });
  }
  // Ephemeral lifecycle wiring — fires AFTER the queued write so the on-disk
  // state already reflects the transition before any peer-sync work runs.
  // false→true: tear down every existing per-record sub for this universe
  //             (peers keep their last-pushed copy on disk; we just stop
  //             future pushes). Mirror of createUniverse's `if (!created.ephemeral)`
  //             auto-subscribe-skip — both ends of the lifecycle keep
  //             peer_subscriptions.json free of orphan rows.
  // true→false: fire autoSubscribeRecordToAllPeers so the now-shareable
  //             record reaches every peer with the universe category
  //             enabled via the responsive per-record push pipeline. (The 60s
  //             snapshot loop would also carry it now — the source only
  //             excludes records it ALREADY pushes per-record, so an
  //             un-subscribed record rides the snapshot — but the push path
  //             converges it immediately instead of waiting up to a cycle.)
  // Await the dynamic import — fire-and-forget .then() resolves on a
  // microtask AFTER the synchronous emitRecordUpdated below, so the
  // peerSync 'updated' listener would schedule pushes against subs the
  // user just disabled. The await keeps the documented "BEFORE
  // emitRecordUpdated" contract honest.
  if (prevEphemeral && !nextEphemeral) {
    await import('./sharing/peerSync.js')
      .then(({ autoSubscribeRecordToAllPeers }) => autoSubscribeRecordToAllPeers('universe', merged.id))
      .catch((err) => {
        console.log(`⚠️ universe: re-subscribe after un-ephemeralizing failed: ${err.message}`);
      });
  } else if (!prevEphemeral && nextEphemeral) {
    await import('./sharing/peerSync.js')
      .then(({ unsubscribeAllForRecord }) => unsubscribeAllForRecord('universe', merged.id))
      .catch((err) => {
        console.log(`⚠️ universe: unsubscribe after ephemeralizing failed: ${err.message}`);
      });
  }
  if (!silent) {
    emitRecordUpdated('universe', merged.id);
  }
  return merged;
}

export async function deleteUniverse(id) {
  // Soft-delete: mark the record with `deleted: true` + `deletedAt` and bump
  // `updatedAt` so federated peers learn about the deletion via the existing
  // LWW merge (tombstone-as-state). The orchestrator's tombstone-cleanup
  // sweep prunes the record entirely once every subscribed peer has acked.
  //
  // Cross-file side effects still run on the local delete: drop runs,
  // unlink media collections, clear sheet slots. These cascades also run on
  // the receiving peer when a soft-delete arrives via mergeUniversesFromSync
  // so a synced delete doesn't leave orphan media-collection locks.
  const s = store();
  // Hierarchy invariant (block-until-empty): refuse to delete a universe that
  // still has live (non-deleted) series — the user must move or delete those
  // series first. Filter listSeries() inline rather than calling
  // canonUsage.listLinkedSeriesNames (canonUsage back-imports this module → a
  // require cycle). This runs OUTSIDE the record queue: a read-only pre-check,
  // and the queued write below re-validates existence anyway.
  const blockingSeries = (await listSeries())
    .filter((ser) => ser.universeId === id)
    .map((ser) => ({ id: ser.id, name: ser.name }));
  if (blockingSeries.length > 0) {
    throw Object.assign(
      makeErr(`Universe has ${blockingSeries.length} live series — move or delete them first`, ERR_HAS_LIVE_SERIES),
      { blockingSeries },
    );
  }
  await s.queueRecordWrite(id, async () => {
    const cur = await s.loadOne(id);
    if (!cur) throw makeErr(`Universe not found: ${id}`, ERR_NOT_FOUND);
    if (cur.deleted) throw makeErr(`Universe not found: ${id}`, ERR_NOT_FOUND);
    const now = new Date().toISOString();
    const tombstone = { ...cur, deleted: true, deletedAt: now, updatedAt: now };
    await ensureDir(s.recordDir(id));
    await atomicWrite(s.recordPath(id), tombstone);
  });
  // Drop runs referencing the deleted universe — they're useless without it.
  // CRITICAL: the load + filter + write MUST run inside queueTypeIndexWrite as a
  // single critical section. An earlier version did the load OUTSIDE the queue
  // and then saveTypeIndex inside it — saveTypeIndex's shallow merge then
  // wholesale-replaced `config.runs` with the stale filtered snapshot,
  // silently dropping any recordRun that landed between the outer load and
  // the queued write. Stay inside the queue and use atomicWrite directly
  // (saveTypeIndex would self-re-queue and deadlock).
  await s.queueTypeIndexWrite(async () => {
    const typeIndex = await s.loadTypeIndex();
    const filteredRuns = (typeIndex.config?.runs || []).filter((r) => r.universeId !== id);
    const next = {
      schemaVersion: typeIndex.schemaVersion,
      type: typeIndex.type,
      config: { ...(typeIndex.config || {}), runs: filteredRuns },
      updatedAt: new Date().toISOString(),
    };
    await ensureDir(s.dir);
    await atomicWrite(s.typeIndexPath(), next);
  });
  // Release the rename-lock on any linked media collections — without this,
  // the orphan collection's `universeId` stays stamped and the lock in
  // updateCollection blocks renames forever even though the universe is gone.
  // Best-effort: a failure here mustn't fail the delete (the universe is
  // already tombstoned). Runs OUTSIDE the universe-builder queue.
  await unlinkCollectionsForUniverse(id).catch((err) => {
    console.error(`❌ unlink media collections for deleted universe ${id} failed: ${err?.message || err}`);
  });
  // Slot map is in-process; persists across the logical delete without this.
  clearPendingSheetSlotsForUniverse(id);
  emitRecordDeleted('universe', id);
  return { id };
}

/**
 * Cascade orphan cleanup for a universe whose soft-delete arrived via peer
 * sync (mergeUniversesFromSync detected a deleted=false → deleted=true
 * transition). Mirrors the post-queue cleanup in deleteUniverse so a synced
 * delete on the receiver leaves the same orphan-free state as a local delete.
 * Runs outside the universe-builder write queue.
 */
async function cascadeDeleteSideEffects(id) {
  await unlinkCollectionsForUniverse(id).catch((err) => {
    console.error(`❌ unlink media collections for synced-delete universe ${id} failed: ${err?.message || err}`);
  });
  clearPendingSheetSlotsForUniverse(id);
  emitRecordDeleted('universe', id);
}

/**
 * Sync-orchestrator entry point. Merges a remote peer's universe array into
 * local state INSIDE the store's per-id write queue, so each remote record's
 * read-modify-write can't clobber (or be clobbered by) a concurrent local LLM
 * auto-save, promote-variation, or handleSave on the same universe id.
 *
 * Each incoming remote record passes through `sanitizeTemplate` so older-
 * schema payloads (pre-v4 universes missing `kind`, prose stylePrompt/
 * negativePrompt, retired `characters` bucket) land on disk already migrated —
 * matching every other entry path into this file (`createUniverse`,
 * `insertUniverseWithId`, `updateUniverse`).
 *
 * LWW semantics by `updatedAt`. Local-only `runs[]` survives the merge
 * (ephemeral, per-peer). Returns `{ applied, count }` where `count` is the
 * number of universes actually changed/added by this merge — NOT the total
 * post-merge count — so callers summing across categories don't over-report.
 */
export async function mergeUniversesFromSync(remoteUniverses, { source = { via: 'sync', peerId: null } } = {}) {
  if (!Array.isArray(remoteUniverses)) return { applied: false, count: 0 };
  // Records that transitioned to deleted via this merge get their orphan
  // cascade fired after the write queue releases — matches the side-effect
  // contract of locally-initiated `deleteUniverse`.
  //
  // Edit-merges (no delete-transition) DO NOT call `emitRecordUpdated` here.
  // Unlike `updateUniverse`, the snapshot sync is meant to be silent — every
  // 60s cycle would otherwise trigger a re-export storm in share-bucket
  // subscriptions even when nothing user-visible changed. The Stage 2
  // per-record peer-sync push pipeline will own the "edit arrived from
  // peer" emit so subscribers fire exactly once per actual edit.
  const transitionedToDeleted = [];
  const s = store();
  // Each remote runs through its own per-id queue. The LWW check sits INSIDE
  // each queued write so a concurrent updateUniverse on the same id can't
  // sneak in between the LWW comparison and the write. Different ids fan out
  // in parallel — the scalability win vs. the old single-tail queue.
  let changed = 0;
  const writeTasks = [];
  for (const remote of remoteUniverses) {
    if (!remote || typeof remote !== 'object' || !isStr(remote.id)) continue;
    const sanitized = sanitizeTemplate(remote);
    if (!sanitized) continue;
    // `ephemeral` is a LOCAL-only marker — never trust the inbound value.
    // sanitizeTemplate only persists a literal `{ ephemeral: true }` (any
    // other value gets dropped at the sanitizer); strip even that here so
    // a buggy/older/non-conformant peer (or the share-bucket importer's
    // mutator-form path) can't plant a "dark" record on us that's
    // permanently un-syncable. The on-disk-only contract is enforced on
    // the receive boundary.
    if ('ephemeral' in sanitized) delete sanitized.ephemeral;
    writeTasks.push(s.queueRecordWrite(sanitized.id, async () => {
      const local = await s.loadOne(sanitized.id);
      if (!local) {
        // No local counterpart — accept the record (live OR tombstone) but
        // do NOT cascade orphan-cleanup. A tombstone for a record we never
        // had has nothing to clean up; firing `emitRecordDeleted` would
        // spuriously tear down share-bucket subscriptions.
        await ensureDir(s.recordDir(sanitized.id));
        await atomicWrite(s.recordPath(sanitized.id), sanitized);
        // No local counterpart to lose — nothing to journal, but seed the base
        // hash so a FUTURE divergence on this record is detected.
        await setSyncBaseHash('universe', sanitized.id, contentHashForRecord('universe', sanitized));
        changed += 1;
        return;
      }
      if (local.ephemeral === true) {
        // Local-ephemeral records are IMMUNE to inbound merges. The user
        // explicitly marked this record local-only — peer edits can't
        // overwrite its content, peer deletes can't trigger our orphan
        // cascade, and the post-merge asset-pull worker never gets the
        // chance to download bytes for it.
        return;
      }
      const localTs = local.updatedAt || '';
      const remoteTs = sanitized.updatedAt || '';
      if (remoteTs > localTs) {
        // Non-blocking conflict journal: archive the about-to-be-lost local
        // version when BOTH sides diverged from the last synced base. Always
        // advances the base hash (clean or conflict) so the next snapshot
        // cycle doesn't re-journal the same divergence. Never throws.
        await maybeJournalBeforeOverwrite({ kind: 'universe', id: sanitized.id, local, remote: sanitized, source });
        await ensureDir(s.recordDir(sanitized.id));
        await atomicWrite(s.recordPath(sanitized.id), sanitized);
        if (sanitized.deleted && !local.deleted) transitionedToDeleted.push(sanitized.id);
        changed += 1;
      }
    }));
  }
  await Promise.all(writeTasks);
  // Persist the batched base-hash updates accumulated above in one write.
  await flushBaseHashes();
  if (changed === 0) return { applied: false, count: 0 };
  // Drop runs for any record that just transitioned to deleted — matches
  // the local-delete contract that ditches now-orphan runs. Same critical-
  // section requirement as deleteUniverse: load + filter + write all stay
  // inside queueTypeIndexWrite so a concurrent recordRun doesn't get its
  // newly-appended run overwritten by a stale filtered snapshot.
  if (transitionedToDeleted.length) {
    const tombstoned = new Set(transitionedToDeleted);
    await s.queueTypeIndexWrite(async () => {
      const typeIndex = await s.loadTypeIndex();
      const filtered = (typeIndex.config?.runs || []).filter((r) => !tombstoned.has(r.universeId));
      const next = {
        schemaVersion: typeIndex.schemaVersion,
        type: typeIndex.type,
        config: { ...(typeIndex.config || {}), runs: filtered },
        updatedAt: new Date().toISOString(),
      };
      await ensureDir(s.dir);
      await atomicWrite(s.typeIndexPath(), next);
    });
  }
  const result = { applied: true, count: changed };
  // Fire cascades after the queue releases (mirrors deleteUniverse ordering)
  // so a slow media-collections write can't block other universe mutators.
  for (const id of transitionedToDeleted) {
    await cascadeDeleteSideEffects(id);
  }
  return result;
}

/**
 * Garbage-collect universe tombstones older than `beforeMs`. Pure of GC
 * policy — the caller (server/services/sharing/tombstoneGc.js) owns the
 * ack-cursor + grace-period math and just tells us the cutoff timestamp.
 *
 * Tombstones whose `deletedAt` is a non-parseable string are conservatively
 * KEPT — we'd rather leak a few garbled records than silently delete data.
 * Returns `{ pruned }` with the count actually removed.
 */
export async function pruneTombstonedUniverses(beforeMs) {
  if (!Number.isFinite(beforeMs)) return { pruned: 0 };
  const s = store();
  const ids = await s.listIds();
  const records = await Promise.all(ids.map((id) => s.loadOne(id)));
  const candidates = [];
  for (const u of records) {
    if (!u?.deleted) continue;
    const t = Date.parse(u.deletedAt || '');
    if (!Number.isFinite(t)) continue;
    if (t < beforeMs) candidates.push(u.id);
  }
  // Per-id deletes fan out, but we re-check the tombstone status INSIDE each
  // per-id queue. A concurrent mergeUniversesFromSync could have un-deleted
  // the record (newer remote `updatedAt`, `deleted: false`) between our
  // out-of-queue snapshot read and the queued delete; without the re-check,
  // we'd rm -rf a freshly un-deleted record. Counts only the records we
  // actually pruned (the candidates set minus any rescued by a concurrent
  // un-delete).
  const results = await Promise.allSettled(candidates.map((id) =>
    s.queueRecordWrite(id, async () => {
      const fresh = await s.loadOne(id);
      if (!fresh?.deleted) return false; // un-deleted between snapshot and queue
      const t = Date.parse(fresh.deletedAt || '');
      if (!Number.isFinite(t) || t >= beforeMs) return false;
      const { rm } = await import('fs/promises');
      await rm(s.recordDir(id), { recursive: true, force: true });
      await deleteSyncBaseHash('universe', id);
      return true;
    })
  ));
  let pruned = 0;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value === true) pruned += 1;
    else if (r.status === 'rejected') console.log(`⚠️ pruneTombstonedUniverses: delete failed: ${r.reason?.message || r.reason}`);
  }
  return { pruned };
}

export async function recordRun(run) {
  const sanitized = sanitizeRun(run);
  if (!sanitized) throw makeErr('Invalid run payload', ERR_VALIDATION);
  const s = store();
  // Type-index queue serializes the runs[] read→append→write so concurrent
  // recordRun + delete-cascade can't clobber each other's runs.
  return s.queueTypeIndexWrite(async () => {
    const typeIndex = await s.loadTypeIndex();
    const runs = Array.isArray(typeIndex.config?.runs) ? [...typeIndex.config.runs] : [];
    runs.push(sanitized);
    // Keep last 200 runs to bound state growth.
    const capped = runs.length > 200 ? runs.slice(-200) : runs;
    // saveTypeIndex also queues, but we're already on the type-index queue —
    // write the file directly with atomicWrite to avoid a re-entrant queue.
    const next = {
      schemaVersion: typeIndex.schemaVersion,
      type: typeIndex.type,
      config: { ...(typeIndex.config || {}), runs: capped },
      updatedAt: new Date().toISOString(),
    };
    await ensureDir(s.dir);
    await atomicWrite(s.typeIndexPath(), next);
    return sanitized;
  });
}

export async function listRuns(universeId = null) {
  const s = store();
  const typeIndex = await s.loadTypeIndex();
  const runs = Array.isArray(typeIndex.config?.runs)
    ? typeIndex.config.runs.map(sanitizeRun).filter(Boolean)
    : [];
  const filtered = universeId ? runs.filter((r) => r.universeId === universeId) : runs;
  return [...filtered].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

// Append a rendered gallery filename to the imageRefs[] of the entry the job
// targeted. `entryRef` shape mirrors what `compilePrompts` stamps onto each
// job (see `universeRun.entryRef`); the mutator branches on `kind`:
//   - 'variation' → `universe.categories[categoryKey].variations[id]`
//   - 'sheet'     → `universe.compositeSheets[id]`
//   - 'canon'     → `universe[kindKey][id]` (characters/places/objects)
// Dedupes against the existing list so a re-render that produces the same
// filename doesn't bloat the history. Runs through `updateUniverse`'s mutator
// form so the read→modify→write window is serialized against concurrent edits
// on the same universe.
/**
 * Bulk-set `locked` on every variation in a category bucket. When
 * `categoryKey` is null, every variation in every bucket of the universe is
 * affected. Composite sheets are included in the universe-wide path (caller
 * intent for "lock everything" is consistent across both lists). Returns the
 * updated universe plus the count of variations whose state actually changed
 * — entries already at the target state are no-ops so the toast can read
 * "Locked N variations".
 */
export async function setVariationsLockAll(universeId, { categoryKey = null, locked, includeSheets = false } = {}) {
  const target = locked === true;
  let changed = 0;
  let total = 0;
  const updated = await updateUniverse(universeId, (cur) => {
    const patch = {};
    const categories = cur.categories || {};
    const nextCategories = {};
    let touchedCategories = false;
    for (const [key, bucket] of Object.entries(categories)) {
      const variations = Array.isArray(bucket?.variations) ? bucket.variations : [];
      if (categoryKey && key !== categoryKey) {
        nextCategories[key] = bucket;
        continue;
      }
      // Increment `total` only for buckets the caller actually targeted —
      // otherwise a single-bucket lock-all would report every variation in
      // every bucket as the denominator and the response toast lies.
      total += variations.length;
      let bucketTouched = false;
      const nextVariations = variations.map((v) => {
        if (!v || typeof v !== 'object') return v;
        if ((v.locked === true) === target) return v;
        changed += 1;
        bucketTouched = true;
        return { ...v, locked: target };
      });
      nextCategories[key] = bucketTouched ? { ...bucket, variations: nextVariations } : bucket;
      if (bucketTouched) touchedCategories = true;
    }
    if (touchedCategories) patch.categories = nextCategories;

    if (!categoryKey && includeSheets && Array.isArray(cur.compositeSheets)) {
      total += cur.compositeSheets.length;
      let sheetsTouched = false;
      const nextSheets = cur.compositeSheets.map((s) => {
        if (!s || typeof s !== 'object') return s;
        if ((s.locked === true) === target) return s;
        changed += 1;
        sheetsTouched = true;
        return { ...s, locked: target };
      });
      if (sheetsTouched) patch.compositeSheets = nextSheets;
    }

    if (!Object.keys(patch).length) return null;
    return patch;
  });
  return { universe: updated, locked: target, changed, total, categoryKey: categoryKey || null };
}

export async function appendEntryImageRef(universeId, entryRef, filename) {
  if (!isStr(universeId) || !entryRef || typeof entryRef !== 'object') return null;
  // Apply the same filename guard the sanitizer uses on round-trip so a
  // pathy or traversal-laden filename is rejected up-front rather than
  // entering the queued write and triggering a no-op `updatedAt` bump
  // when sanitizeTemplate strips it on the way out.
  const safe = sanitizeImageRefFilename(filename);
  if (!safe) return null;
  return updateUniverse(universeId, (cur) => {
    if (entryRef.kind === ENTRY_REF_KIND.VARIATION && isStr(entryRef.categoryKey) && isStr(entryRef.id)) {
      const cat = cur.categories?.[entryRef.categoryKey];
      const variations = mapAppendImageRef(cat?.variations, entryRef.id, safe);
      if (!variations) return null;
      return { categories: { [entryRef.categoryKey]: { ...cat, variations } } };
    }
    if (entryRef.kind === ENTRY_REF_KIND.SHEET && isStr(entryRef.id)) {
      const sheets = mapAppendImageRef(cur.compositeSheets, entryRef.id, safe);
      if (!sheets) return null;
      return { compositeSheets: sheets };
    }
    if (entryRef.kind === ENTRY_REF_KIND.CANON && isStr(entryRef.kindKey) && isStr(entryRef.id)) {
      const list = mapAppendImageRef(cur[entryRef.kindKey], entryRef.id, safe);
      if (!list) return null;
      return { [entryRef.kindKey]: list };
    }
    return null;
  });
}

// Preserve cur's `imageRefs` on entries the patch round-tripped from a stale
// load. Match by `id`; we consider the patch stale (and restore cur's history)
// when EITHER cur's list has more entries than the patch's OR the newest entry
// (tail) differs between cur and patch. The tail check catches the at-cap case:
// once imageRefs is at IMAGE_REFS_PER_ENTRY_MAX (12), a server-side append
// rotates the list — pushing the new filename and dropping the oldest — so
// lengths stay equal even though cur is strictly newer. Comparing tails
// detects this; a stale client PATCH (with the pre-rotation list) has a
// different last element than the freshly-appended cur. Used by both the
// variations and composite-sheets preservation paths in updateUniverse.
function preserveImageRefsById(next, prev) {
  if (!Array.isArray(next) || !Array.isArray(prev)) return next;
  const prevById = new Map(prev.filter((p) => p?.id).map((p) => [p.id, p]));
  return next.map((n) => {
    const p = n?.id ? prevById.get(n.id) : null;
    if (!p) return n;
    const prevRefs = Array.isArray(p.imageRefs) ? p.imageRefs : [];
    const nextRefs = Array.isArray(n.imageRefs) ? n.imageRefs : [];
    if (prevRefs.length === 0) return n;
    // Restore when cur has strictly more refs (patch dropped some) OR cur has
    // a different newest entry than the patch (server-side rotation at cap).
    // Equal-length + same tail means the patch is current and survives.
    const isStale =
      prevRefs.length > nextRefs.length ||
      (prevRefs.length > 0 && prevRefs[prevRefs.length - 1] !== nextRefs[nextRefs.length - 1]);
    return isStale ? { ...n, imageRefs: prevRefs } : n;
  });
}

// Append `filename` (deduped + capped to IMAGE_REFS_PER_ENTRY_MAX) to the
// imageRefs[] of the entry in `list` matched by `id`. Returns the new list,
// or `null` when the id isn't present so the caller can short-circuit.
function mapAppendImageRef(list, id, filename) {
  if (!Array.isArray(list) || !list.some((e) => e?.id === id)) return null;
  return list.map((e) => {
    if (e?.id !== id) return e;
    const refs = Array.isArray(e.imageRefs) ? e.imageRefs : [];
    if (refs.includes(filename)) return e;
    const next = [...refs, filename];
    return { ...e, imageRefs: next.length > IMAGE_REFS_PER_ENTRY_MAX ? next.slice(-IMAGE_REFS_PER_ENTRY_MAX) : next };
  });
}

// Join an influence list (embrace or avoid) into the comma-separated string
// shape the renderer's `composeStyledPrompt` consumes. Tokens have already
// been deduped + capped by `sanitizeInfluenceList` at write time, so this is
// just a thin join — exported so downstream consumers (universeCanon,
// pipeline/visualStages) read a single helper instead of each open-coding
// `(arr || []).join(', ')`.
export function joinInfluenceList(structured = []) {
  if (!Array.isArray(structured)) return '';
  return structured.filter((t) => typeof t === 'string' && t.trim()).join(', ');
}

// Collapse newlines + control chars in user-supplied free text before
// embedding in a prompt. Defense-in-depth against a logline / styleNotes /
// variation label containing "\n# Output contract\n…" that could redirect the
// LLM's output structure. `trimTo` (the universe sanitizer) only trims
// leading/trailing whitespace, so embedded newlines flow through untouched
// without this pass.
export const stripPromptControlChars = (s) =>
  typeof s === 'string' ? s.replace(/[\r\n\t\f\v\u0085\u2028\u2029]+/g, ' ').trim() : '';

const identityText = (s) => s;

/**
 * Render the "established universe context" prompt section shared by the
 * Universe Builder LLM actions (auto-sort, promote-variation,
 * generate-category-variations). Returns the full block including leading
 * `\n# <header>\n` and trailing newline, ready to interpolate; returns `''`
 * when no fields populate so callers can drop the block entirely.
 *
 * Accepts a sanitized universe object or a shaped `{ logline, premise,
 * styleNotes }` literal (the expand-variations path passes the literal).
 *
 * @param {object|null|undefined} universe — sanitized universe or a shaped
 *   `{ logline, premise, styleNotes }` literal; `null`/`undefined` returns ''.
 * @param {object} [options]
 * @param {boolean} [options.includePremise=false] — emit a `PREMISE:` line.
 * @param {boolean} [options.includeEmbrace=true] — emit an
 *   `EMBRACE INFLUENCES:` line from `universe.influences.embrace`. Off for
 *   callers that render their own influences section.
 * @param {boolean} [options.escape=false] — collapse newlines/control chars
 *   in user-supplied text. Auto-sort opts in; promote/expand stayed off
 *   historically and we preserve that to avoid behavior drift.
 * @param {string} [options.headerSuffix=''] — appended after `Universe
 *   context — ` to bias the LLM.
 */
export function buildUniverseStyleContext(universe, options = {}) {
  if (!universe) return '';
  const {
    includePremise = false,
    includeEmbrace = true,
    escape = false,
    headerSuffix = '',
  } = options;
  const safeText = escape ? stripPromptControlChars : identityText;
  const lines = [];
  if (universe.logline) lines.push(`LOGLINE: ${safeText(universe.logline)}`);
  if (includePremise && universe.premise) lines.push(`PREMISE: ${safeText(universe.premise)}`);
  if (universe.styleNotes) lines.push(`STYLE NOTES: ${safeText(universe.styleNotes)}`);
  if (includeEmbrace) {
    const embraceTokens = joinInfluenceList(universe.influences?.embrace);
    if (embraceTokens) lines.push(`EMBRACE INFLUENCES: ${safeText(embraceTokens)}`);
  }
  if (lines.length === 0) return '';
  const header = headerSuffix ? `Universe context — ${headerSuffix}` : 'Universe context';
  return `\n# ${header}\n${lines.join('\n\n')}\n`;
}

// Order matches the Universe Builder tab order (Cast → Places → Objects) so
// the compiled-prompts list is stable across renders.
const CANON_TRUNKS = Object.freeze([
  { key: 'characters', category: 'canon:characters' },
  { key: 'places',     category: 'canon:places' },
  { key: 'objects',    category: 'canon:objects' },
]);

// Synthesize a render prompt from a canon entry. `entry.prompt` wins when
// hand-authored; otherwise stitch the kind's descriptive fields. Output is
// fed through `composeStyledPrompt(...)` so the universe's embrace tokens
// still prefix every canon render.
export function synthesizeCanonPrompt(kind, entry) {
  if (!entry) return '';
  if (typeof entry.prompt === 'string' && entry.prompt.trim()) return entry.prompt.trim();
  // Identifier seed: `name` is the shared anchor for all kinds. For
  // `places`, the bible sanitizer allows entries whose ONLY identifier is
  // a slugline (e.g. "EXT. FOUNDRY CITY — DAY") with no separate name — fall
  // back to slugline so those entries don't synthesize to an empty seed and
  // get silently skipped at render time.
  const name = typeof entry.name === 'string' ? entry.name.trim() : '';
  const sluglineId = (kind === 'places' && typeof entry.slugline === 'string')
    ? entry.slugline.trim()
    : '';
  const identifier = name || sluglineId;
  const body = flattenCanonDescriptorFragments(richCanonDescriptorFragments(kind, entry));
  if (identifier && body) return `${identifier} — ${body}`;
  return identifier || body;
}

/**
 * Compile the universe template into an ordered list of full image-gen
 * prompts. Each entry combines the universe's style prompt with one
 * variation from a chosen category, one composite sheet, or one canon entry.
 *
 *   promptMode: 'variations' | 'sheets' | 'canon' | 'all'
 *
 *   selection: { landscapes: 'all' | string[], characters: ... }
 *     - 'all' → use every variation
 *     - array of labels → only those labels (case-insensitive match)
 *     - missing key → skip the category entirely
 *
 *   canonSelection: { characters?: 'all' | string[], places?: ..., objects?: ... }
 *     - 'all' → render every entry in that canon trunk
 *     - array of names → only those names (case-insensitive match against
 *       `name` and, for places, `slugline`)
 *     - missing key → skip the trunk entirely
 *
 *   batchPerVariation: how many renders per variation (1..20)
 */
export function compilePrompts(universe, options = {}) {
  if (!universe) return [];
  const promptMode = ['variations', 'sheets', 'canon', 'all'].includes(options.promptMode)
    ? options.promptMode
    : 'variations';
  const selection = options.selection && typeof options.selection === 'object'
    ? options.selection
    : Object.fromEntries(getWorldCategoryKeys(universe.categories).map((c) => [c, 'all']));
  const normalizedSelection = {};
  for (const [key, value] of Object.entries(selection)) {
    const normalized = normalizeCategoryKey(key);
    if (normalized) normalizedSelection[normalized] = value;
  }
  const batchPerVariation = Math.max(1, Math.min(20, Number(options.batchPerVariation) || 1));

  // The universe's stored influences are the baseline; per-batch overrides
  // append on top so the user can layer an extra-style chip, a style preset,
  // or an extra negative without editing the persistent influences. Token
  // lists are comma-joined to match composeStyledPrompt's input expectation.
  const baselineEmbrace = joinInfluenceList(universe.influences?.embrace);
  const baselineAvoid = joinInfluenceList(universe.influences?.avoid);
  const embraceParts = [baselineEmbrace, options.stylePresetPrompt, options.extraStyle]
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean);
  const avoidParts = [baselineAvoid, options.stylePresetNegative, options.extraNegative]
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean);
  const stylePreset = {
    prompt: embraceParts.join(', '),
    negativePrompt: avoidParts.join(', '),
  };
  const compiled = [];

  if (promptMode === 'variations' || promptMode === 'all') {
    for (const category of getWorldCategoryKeys(normalizedSelection)) {
      const sel = normalizedSelection[category];
      if (!sel) continue;
      const variations = universe.categories?.[category]?.variations || [];
      const filtered = sel === 'all'
        ? variations
        : variations.filter((v) => Array.isArray(sel) && sel.some((s) => s.toLowerCase() === v.label.toLowerCase()));
      for (const variation of filtered) {
        const { prompt, negativePrompt } = composeStyledPrompt(variation.prompt, '', stylePreset);
        for (let i = 0; i < batchPerVariation; i += 1) {
          compiled.push({
            category,
            label: variation.label,
            prompt,
            negativePrompt,
            batchIndex: i,
            // `entryRef` lets the collection hook stamp the rendered filename
            // back onto this exact variation regardless of subsequent label
            // edits or bucket moves. Older universes can be missing `id` until
            // the next write through sanitizeTemplate — fall through silently
            // when that happens; the variation just won't accrue a render
            // history until it next gets persisted.
            ...(variation.id ? { entryRef: { kind: ENTRY_REF_KIND.VARIATION, categoryKey: category, id: variation.id } } : {}),
          });
        }
      }
    }
  }

  if (promptMode === 'sheets' || promptMode === 'all') {
    const sheetSelection = options.sheetSelection || 'all';
    const sheets = universe.compositeSheets || [];
    const filteredSheets = sheetSelection === 'all'
      ? sheets
      : sheets.filter((s) => Array.isArray(sheetSelection) && sheetSelection.some((label) => label.toLowerCase() === s.label.toLowerCase()));
    for (const sheet of filteredSheets) {
      const { prompt, negativePrompt } = composeStyledPrompt(sheet.prompt, '', stylePreset);
      const category = sheet.kind === 'world_pitch_poster'
        ? 'world_pitch_posters'
        : 'composite_sheets';
      for (let i = 0; i < batchPerVariation; i += 1) {
        compiled.push({
          category,
          label: sheet.label,
          prompt,
          negativePrompt,
          batchIndex: i,
          ...(sheet.id ? { entryRef: { kind: ENTRY_REF_KIND.SHEET, id: sheet.id } } : {}),
        });
      }
    }
  }

  if (promptMode === 'canon' || promptMode === 'all') {
    const canonSelection = options.canonSelection && typeof options.canonSelection === 'object'
      ? options.canonSelection
      : null;
    if (canonSelection) {
      for (const trunk of CANON_TRUNKS) {
        const sel = canonSelection[trunk.key];
        if (!sel) continue;
        const entries = Array.isArray(universe[trunk.key]) ? universe[trunk.key] : [];
        const filtered = sel === 'all'
          ? entries
          : entries.filter((e) => Array.isArray(sel) && sel.some((s) => {
              const needle = s.toLowerCase();
              if (typeof e.name === 'string' && e.name.toLowerCase() === needle) return true;
              // Slugline is places-only (see canonSelection docstring above
              // and BIBLE_FIELD_WHITELIST). Avoid matching a stray slugline
              // field on a character/object payload — that field isn't part of
              // the canon contract for those kinds.
              if (trunk.key === 'places'
                  && typeof e.slugline === 'string'
                  && e.slugline.toLowerCase() === needle) return true;
              return false;
            }));
        for (const entry of filtered) {
          const seed = synthesizeCanonPrompt(trunk.key, entry);
          // An entry with no name and no descriptive content yields nothing —
          // skip rather than enqueue a style-prompt-only render that would
          // produce a generic image with no identity anchor.
          if (!seed) continue;
          const { prompt, negativePrompt } = composeStyledPrompt(seed, '', stylePreset);
          for (let i = 0; i < batchPerVariation; i += 1) {
            compiled.push({
              category: trunk.category,
              label: entry.name || entry.slugline || trunk.key,
              prompt,
              negativePrompt,
              batchIndex: i,
              ...(entry.id ? { entryRef: { kind: ENTRY_REF_KIND.CANON, kindKey: trunk.key, id: entry.id } } : {}),
            });
          }
        }
      }
    }
  }

  return compiled;
}
