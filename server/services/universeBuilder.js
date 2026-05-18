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

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, atomicWrite, readJSONFile, ensureDir } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { composeStyledPrompt } from '../lib/composeStyledPrompt.js';
import { richCanonDescriptorFragments } from '../lib/canonPrompt.js';
import {
  sanitizeBibleList, BIBLE_KIND, BIBLE_FIELD, BIBLE_LIMITS, BIBLE_SOURCE,
  normalizeBibleName, isStr, trimTo,
} from '../lib/storyBible.js';
import { sanitizeOrigin } from '../lib/sharingOrigin.js';
import { emitRecordUpdated, emitRecordDeleted } from './sharing/recordEvents.js';
import { renameCollectionForUniverse, unlinkCollectionsForUniverse } from './mediaCollections.js';

// Bumped when a sanitizer-time backfill changes how on-disk universes are
// shaped, so future migrations can gate on the prior version.
//   v3 — drop prose stylePrompt/negativePrompt fields; legacy values are
//        split on commas and merged into influences.embrace / influences.avoid
//        so there is a single token-list editing surface.
//   v4 — categories carry a `kind` field tagging them to one of the 3 canon
//        trunks (characters/settings/objects/other); the default `characters`
//        category is retired and any variations get folded into canon
//        characters[]. See "Categories vs canon — decision" in PLAN.md.
export const CURRENT_SCHEMA_VERSION = 4;

// Lazy state-path resolution so test harnesses that swap PATHS.data
// per-test (mkdtempSync + Proxy mock) see the right temp root. Computing
// the path at module-load freezes whatever value PATHS.data held when
// universeBuilder.js was first imported, which is `undefined` under the
// proxy-mock pattern series.js's tests already use.
const statePath = () => join(PATHS.data, 'universe-builder.json');

// Serializes every mutating call (create / update / delete / recordRun)
// against the shared universe-builder.json so concurrent writes — even to
// different universe ids — can't read a stale snapshot and clobber a sibling.
const queueUniverseWrite = createFileWriteQueue();

export const ERR_NOT_FOUND = 'NOT_FOUND';
export const ERR_VALIDATION = 'VALIDATION_ERROR';
export const ERR_DUPLICATE = 'DUPLICATE';
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
export const CATEGORY_KINDS = Object.freeze(['characters', 'settings', 'objects', 'other']);
export const DEFAULT_CATEGORY_KIND = 'other';


// Built-in default categories carry a known kind so they land under the right
// trunk in the UI without user intervention. Custom keys not in this map fall
// to DEFAULT_CATEGORY_KIND ('other') unless the input carries an explicit
// valid `kind`.
export const WORLD_CATEGORY_DEFAULT_KINDS = Object.freeze({
  landscapes: 'settings',
  environments: 'settings',
  structures: 'settings',
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
  landscapes:   { kind: BIBLE_KIND.SETTING,   tags: ['landscape'] },
  environments: { kind: BIBLE_KIND.SETTING,   tags: ['environment'] },
  structures:   { kind: BIBLE_KIND.OBJECT,    tags: ['structure'] },
  vehicles:     { kind: BIBLE_KIND.OBJECT,    tags: ['vehicle'] },
});
const resolveCanonForCategory = (categoryKey) =>
  CATEGORY_TO_CANON[categoryKey] || { kind: BIBLE_KIND.OBJECT, tags: [categoryKey] };

const DEFAULT_STATE = { universes: [], runs: [] };

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

const sanitizeVariation = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const label = trimTo(raw.label, VARIATION_LABEL_MAX);
  const prompt = trimTo(raw.prompt, PROMPT_FRAGMENT_MAX);
  if (!label || !prompt) return null;
  // Per-item lock — when true, expand merges preserve this entry instead of
  // letting the LLM regenerate it. Only `true` is recorded; missing/false
  // collapses to undefined so the on-disk shape stays minimal.
  const out = { label, prompt };
  if (raw.locked === true) out.locked = true;
  return out;
};

const sanitizeCompositeSheet = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const label = trimTo(raw.label, VARIATION_LABEL_MAX);
  const prompt = trimTo(raw.prompt, COMPOSITE_PROMPT_MAX);
  if (!label || !prompt) return null;
  const kind = COMPOSITE_SHEET_KINDS.includes(raw.kind) ? raw.kind : 'reference_sheet';
  const out = { kind, label, prompt };
  if (raw.locked === true) out.locked = true;
  return out;
};

const sanitizeCategory = (raw, key) => {
  // Per-category structure: { kind, variations: [{ label, prompt }] }. Cap so a
  // runaway LLM can't blow up the universe template; matches the route schema.
  // `kind` tags the bucket to one of the 3 canon trunks (characters/settings/
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
    settings: canon.settings,
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
// settings/objects for the v3→v4 transition.
function backfillCanonFromCategories(raw, existingCanon) {
  // v4 hot path — already backfilled. Sanitize through the kind sanitizers
  // once and return; no category scan needed.
  if (raw.schemaVersion >= CURRENT_SCHEMA_VERSION) {
    return {
      characters: sanitizeBibleList(existingCanon.characters, BIBLE_KIND.CHARACTER),
      settings: sanitizeBibleList(existingCanon.settings, BIBLE_KIND.SETTING),
      objects: sanitizeBibleList(existingCanon.objects, BIBLE_KIND.OBJECT),
      schemaVersion: raw.schemaVersion,
    };
  }

  const next = {
    characters: Array.isArray(existingCanon.characters) ? [...existingCanon.characters] : [],
    settings: Array.isArray(existingCanon.settings) ? [...existingCanon.settings] : [],
    objects: Array.isArray(existingCanon.objects) ? [...existingCanon.objects] : [],
  };
  const nameSeen = {
    characters: new Set(next.characters.map((e) => normalizeBibleName(e?.name))),
    settings: new Set(next.settings.map((e) => normalizeBibleName(e?.name))),
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
      // Setting sanitizer requires a name OR slugline; planting the label as
      // both preserves the variation identity for scene-matchers.
      if (kind === BIBLE_KIND.SETTING) entry.slugline = label;
      next[targetField].push(entry);
      nameSeen[targetField].add(nameKey);
    }
  }

  return {
    characters: sanitizeBibleList(next.characters, BIBLE_KIND.CHARACTER),
    settings: sanitizeBibleList(next.settings, BIBLE_KIND.SETTING),
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
  //      custom) into settings/objects. New v4 universes skip this so Phase
  //      B's separation of canon (named entities) and categories (exploratory
  //      variations) stays clean.
  const foldedCanon = foldRetiredCharactersBucket(raw, {
    characters: raw.characters,
    settings: raw.settings,
    objects: raw.objects,
  });
  const canonBackfill = backfillCanonFromCategories(raw, foldedCanon);
  const { characters, settings, objects, schemaVersion } = canonBackfill;
  const llm = raw.llm && typeof raw.llm === 'object'
    ? {
      provider: trimTo(raw.llm.provider, 80) || null,
      model: trimTo(raw.llm.model, 200) || null,
    }
    : { provider: null, model: null };
  const createdAt = isStr(raw.createdAt) ? raw.createdAt : new Date().toISOString();
  const updatedAt = isStr(raw.updatedAt) ? raw.updatedAt : createdAt;
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
    locked,
    characters,
    settings,
    objects,
    schemaVersion,
    llm,
    // Share-bucket provenance — present on imported records, absent on locally-authored ones.
    origin: sanitizeOrigin(raw.origin),
    createdAt,
    updatedAt,
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
  const raw = await readJSONFile(statePath(), DEFAULT_STATE, { logError: false });
  const rawById = new Map(Array.isArray(raw.universes) ? raw.universes.filter((u) => u?.id).map((u) => [u.id, u]) : []);
  const universes = Array.isArray(raw.universes) ? raw.universes.map(sanitizeTemplate).filter(Boolean) : [];
  const runs = Array.isArray(raw.runs) ? raw.runs.map(sanitizeRun).filter(Boolean) : [];
  // The in-memory result is always at CURRENT_SCHEMA_VERSION (sanitizeTemplate
  // re-stamps it on every read). Don't persist the migration here — that write
  // would race against any concurrent queued mutator's writeState and could
  // overwrite a freshly-patched record with the pre-patch migration baseline.
  // The next queued mutator persists the migrated shape naturally.
  if (!canonBackfillLogged) {
    const migrated = universes.filter((u) => (rawById.get(u.id)?.schemaVersion || 0) < CURRENT_SCHEMA_VERSION);
    if (migrated.length > 0) {
      console.log(`🌍 Universe Builder canon backfill — migrated ${migrated.length} universe(s) in-memory to schemaVersion=${CURRENT_SCHEMA_VERSION}; persists on next write`);
      canonBackfillLogged = true;
    }
  }
  return { universes, runs };
}

async function writeState(state) {
  await atomicWrite(statePath(), state);
}

export async function listUniverses() {
  const { universes } = await readState();
  // Newest first — matches user expectation for a "your universes" list.
  return [...universes].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export async function getUniverse(id) {
  const { universes } = await readState();
  const w = universes.find((x) => x.id === id);
  if (!w) throw makeErr(`Universe not found: ${id}`, ERR_NOT_FOUND);
  return w;
}

export async function createUniverse(input = {}) {
  const name = trimTo(input.name, NAME_MAX_LENGTH);
  if (!name) throw makeErr(`Universe name is required (1..${NAME_MAX_LENGTH} chars)`, ERR_VALIDATION);
  return queueUniverseWrite(async () => {
    const state = await readState();
    const now = new Date().toISOString();
    const next = sanitizeTemplate({
      id: randomUUID(),
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
      locked: input.locked || {},
      // Canon registries — let callers seed a universe at creation time
      // (writers-room promote, share-bucket import). sanitizeTemplate runs
      // each through sanitizeBibleList, so per-entry shape is enforced.
      characters: input.characters || [],
      settings: input.settings || [],
      objects: input.objects || [],
      // Stamp the current schema so backfillCanonFromCategories takes its
      // hot-path skip on first read. Without this, the legacy categories→
      // canon backfill fires on every brand-new universe and re-pollutes
      // `characters/settings/objects` with every category variation —
      // counter to Phase B's separation of canon (named entities) from
      // categories (exploratory variations). New universes are always at
      // CURRENT_SCHEMA_VERSION; the backfill exists only for legacy reads.
      schemaVersion: CURRENT_SCHEMA_VERSION,
      llm: input.llm || {},
      createdAt: now,
      updatedAt: now,
    });
    state.universes.push(next);
    await writeState(state);
    return next;
  });
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
  return queueUniverseWrite(async () => {
    const state = await readState();
    if (state.universes.some((u) => u.id === input.id)) {
      throw makeErr(`Universe id already exists: ${input.id}`, ERR_DUPLICATE);
    }
    const next = sanitizeTemplate({ ...input, name });
    if (!next) throw makeErr('Invalid universe payload', ERR_VALIDATION);
    state.universes.push(next);
    await writeState(state);
    return next;
  });
}

export async function updateUniverse(id, patch = {}) {
  // The queued section covers only the universe-builder read/modify/write
  // cycle. The cross-file media-collection rename runs *after* the queue
  // releases so a slow/stuck collection write can't block unrelated universe
  // mutators (the universe row is already persisted by then).
  const { merged, nameChanged } = await queueUniverseWrite(async () => {
    const state = await readState();
    const idx = state.universes.findIndex((w) => w.id === id);
    if (idx < 0) throw makeErr(`Universe not found: ${id}`, ERR_NOT_FOUND);
    const cur = state.universes[idx];

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
      // Canon entity arrays — patched wholesale (the sanitizer reruns
      // sanitizeBibleList so per-entry shape is enforced on every save).
      'characters', 'settings', 'objects',
      // Share-bucket origin metadata (importer sets it; user clears via wholesale null).
      'origin',
    ];
    const scalarPatch = Object.fromEntries(
      PATCHABLE_SCALARS.filter((k) => k in patch).map((k) => [k, patch[k]]),
    );

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
    state.universes[idx] = mergedRecord;
    await writeState(state);
    return { merged: mergedRecord, nameChanged: mergedRecord.name !== cur.name };
  });
  // Cascade rename onto the linked media collection — log but don't fail
  // the save: a stale collection name is recoverable, a failed save isn't.
  // Runs OUTSIDE the queue so the media-collections write tail can't stall
  // subsequent universe mutators.
  if (nameChanged) {
    await renameCollectionForUniverse(merged.id, merged.name).catch((err) => {
      console.error(`❌ universe-collection rename cascade failed for ${merged.id}: ${err?.message || err}`);
    });
  }
  emitRecordUpdated('universe', merged.id);
  return merged;
}

export async function deleteUniverse(id) {
  // Queue covers only the universe-builder write; cross-file unlink runs
  // after the queue releases so a slow media-collections write can't block
  // subsequent universe mutators.
  await queueUniverseWrite(async () => {
    const state = await readState();
    const before = state.universes.length;
    state.universes = state.universes.filter((w) => w.id !== id);
    if (state.universes.length === before) throw makeErr(`Universe not found: ${id}`, ERR_NOT_FOUND);
    // Drop runs referencing the deleted universe — they're useless without it.
    state.runs = state.runs.filter((r) => r.universeId !== id);
    await writeState(state);
  });
  // Release the rename-lock on any linked media collections — without this,
  // the orphan collection's `universeId` stays stamped and the lock in
  // updateCollection blocks renames forever even though the universe is gone.
  // Best-effort: a failure here mustn't fail the delete (the universe is
  // already gone from state). Runs OUTSIDE the universe-builder queue.
  await unlinkCollectionsForUniverse(id).catch((err) => {
    console.error(`❌ unlink media collections for deleted universe ${id} failed: ${err?.message || err}`);
  });
  emitRecordDeleted('universe', id);
  return { id };
}

export async function recordRun(run) {
  const sanitized = sanitizeRun(run);
  if (!sanitized) throw makeErr('Invalid run payload', ERR_VALIDATION);
  return queueUniverseWrite(async () => {
    const state = await readState();
    state.runs.push(sanitized);
    // Keep last 200 runs to bound state growth.
    if (state.runs.length > 200) state.runs = state.runs.slice(-200);
    await writeState(state);
    return sanitized;
  });
}

export async function listRuns(universeId = null) {
  const { runs } = await readState();
  const filtered = universeId ? runs.filter((r) => r.universeId === universeId) : runs;
  return [...filtered].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
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
  { key: 'settings',   category: 'canon:settings' },
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
  // `settings`, the bible sanitizer allows entries whose ONLY identifier is
  // a slugline (e.g. "EXT. FOUNDRY CITY — DAY") with no separate name — fall
  // back to slugline so those entries don't synthesize to an empty seed and
  // get silently skipped at render time.
  const name = typeof entry.name === 'string' ? entry.name.trim() : '';
  const sluglineId = (kind === 'settings' && typeof entry.slugline === 'string')
    ? entry.slugline.trim()
    : '';
  const identifier = name || sluglineId;
  const body = richCanonDescriptorFragments(kind, entry)
    .map((f) => (f.prefix ? `${f.prefix}: ${f.value}` : f.value))
    .join('. ');
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
 *   canonSelection: { characters?: 'all' | string[], settings?: ..., objects?: ... }
 *     - 'all' → render every entry in that canon trunk
 *     - array of names → only those names (case-insensitive match against
 *       `name` and, for settings, `slugline`)
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
              // Slugline is settings-only (see canonSelection docstring above
              // and BIBLE_FIELD_WHITELIST). Avoid matching a stray slugline
              // field on a character/object payload — that field isn't part of
              // the canon contract for those kinds.
              if (trunk.key === 'settings'
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
            });
          }
        }
      }
    }
  }

  return compiled;
}
