/**
 * Canonical story-bible shapes (Character / Place / Object) shared by the
 * Writers Room (per-work bibles) and the Pipeline (per-series bibles).
 *
 * Owns the shape + sanitization + merge-extracted-entries algorithm AND the
 * `createBibleStore(...)` factory the writers-room domain files build on for
 * their CRUD + file I/O. Route exposure stays with the caller.
 */

import { randomUUID } from 'crypto';
import { normalizeSlugline } from './scenePrompt.js';
import { PATHS, resolveImageRef } from './fileUtils.js';
import { isPlainObject } from './objects.js';
import { shortCanonPrimaryField } from './canonPrompt.js';

// Re-export so callers (writers-room domain files) can import a single
// canonical normalizer when they need to match places by slugline.
export { normalizeSlugline };

export const BIBLE_LIMITS = Object.freeze({
  NAME_MAX: 200,
  ROLE_MAX: 200,
  ALIAS_MAX: 100,
  ALIASES_PER_ENTRY_MAX: 12,
  PHYSICAL_DESCRIPTION_MAX: 2000,
  PERSONALITY_MAX: 2000,
  BACKGROUND_MAX: 2000,
  NOTES_MAX: 4000,
  IMAGE_REF_MAX: 500,
  IMAGE_REFS_PER_ENTRY_MAX: 12,
  // Extended character identity (novelist + graphic-novelist needs). All
  // optional; sanitizer trims missing/blank to empty string. These flow into
  // the bible-extraction prompt + the universe-character-expand LLM call.
  PRONOUNS_MAX: 60,
  AGE_MAX: 80,
  CORE_THEME_MAX: 500,
  SPEECH_ACCENT_MAX: 500,
  // Written speech-pattern: cadence, sentence-structure, lexical tics, vocal
  // habits — *not* the regional accent (that lives in SPEECH_ACCENT_MAX).
  // Roomier than accent because writers tend to describe rhythm + vocabulary
  // + idiom in one paragraph.
  SPEECH_PATTERN_MAX: 1000,
  VISUAL_NOTES_MAX: 1000,
  SILHOUETTE_NOTES_MAX: 2000,
  POSTURE_NOTES_MAX: 1000,
  SPECIAL_TRAITS_MAX: 2000,
  VISUAL_IDENTITY_MAX: 1000,
  MOTIVATIONS_MAX: 2000,
  LIKES_MAX: 1500,
  DISLIKES_MAX: 1500,
  MANNERISMS_MAX: 1500,
  RELATIONSHIPS_MAX: 2000,
  // Structured character-to-character relationship links (#1287). The legacy
  // prose `relationships` field above stays; `relationshipLinks[]` is additive.
  // `description` is per-link prose; `opposition` captures a binary-tension
  // axis (hunter/prey, winner/loser…) the reader watches to see reverse.
  RELATIONSHIP_TARGET_ID_MAX: 64,
  RELATIONSHIP_TYPE_MAX: 60,
  RELATIONSHIP_DESCRIPTION_MAX: 1000,
  RELATIONSHIP_OPPOSITION_AXIS_MAX: 60,
  RELATIONSHIP_OPPOSITION_ROLE_MAX: 120,
  RELATIONSHIP_OPPOSITION_NOTE_MAX: 600,
  RELATIONSHIP_LINKS_PER_CHARACTER_MAX: 40,
  SKILLS_MAX: 2000,
  // Flexible stats list — open key/value so non-humans aren't forced into
  // human anatomy ("Number of eyes: 8", "Form: spectral vapor", etc).
  STAT_LABEL_MAX: 80,
  STAT_VALUE_MAX: 200,
  STATS_PER_CHARACTER_MAX: 30,
  // Color palette: named hex swatches with role hints ("amber #f59e0b — skin").
  COLOR_NAME_MAX: 80,
  COLOR_HEX_MAX: 10,
  COLOR_ROLE_MAX: 120,
  COLORS_PER_PALETTE_MAX: 12,
  // Props (graphic-novelist reference): per-prop name + purpose + materials.
  PROP_NAME_MAX: 120,
  PROP_PURPOSE_MAX: 400,
  PROP_MATERIALS_MAX: 200,
  PROP_NOTES_MAX: 600,
  PROPS_PER_CHARACTER_MAX: 12,
  // Expressions + hand gestures: named visual cues for reference-sheet panels.
  EXPRESSION_NAME_MAX: 80,
  EXPRESSION_DESC_MAX: 400,
  EXPRESSIONS_PER_CHARACTER_MAX: 16,
  GESTURE_NAME_MAX: 80,
  GESTURE_DESC_MAX: 300,
  GESTURES_PER_CHARACTER_MAX: 12,
  // Wardrobes per character — A2 in the AnyFilm gap analysis. Each entry
  // is an outfit/styling variant; first one is the visual default.
  WARDROBE_NAME_MAX: 120,
  WARDROBE_DESCRIPTION_MAX: 800,
  WARDROBES_PER_CHARACTER_MAX: 10,
  EVIDENCE_ITEM_MAX: 500,
  EVIDENCE_PER_ENTRY_MAX: 20,
  // Places
  SLUGLINE_MAX: 200,
  PALETTE_MAX: 200,
  ERA_MAX: 200,
  WEATHER_MAX: 200,
  RECURRING_DETAILS_MAX: 1000,
  PLACE_DESCRIPTION_MAX: 2000,
  // Objects
  OBJECT_DESCRIPTION_MAX: 2000,
  SIGNIFICANCE_MAX: 1000,
  // Structured object↔character attachment links (#1288). The legacy prose
  // `significance` field above stays; `attachments[]` is additive. Each link
  // ties an object to ONE character and captures the emotion/significance/origin
  // of that bond plus a `role` archetype. `characterId` caps match the canon id
  // format; the prose fields are roomy because writers describe backstory at
  // length, but tighter than NOTES so a runaway extraction stays bounded.
  ATTACHMENT_CHARACTER_ID_MAX: 64,
  ATTACHMENT_EMOTION_MAX: 120,
  ATTACHMENT_SIGNIFICANCE_MAX: 1000,
  ATTACHMENT_ORIGIN_MAX: 1000,
  ATTACHMENTS_PER_OBJECT_MAX: 40,
  // Per-bible cap (universal — protects against runaway extraction)
  ENTRIES_PER_BIBLE_MAX: 200,
  PROMPT_MAX: 2000,
  TAG_MAX: 60,
  TAGS_PER_ENTRY_MAX: 12,
  SOURCE_SERIES_ID_MAX: 64,
  // Catalog backlink: when an embedded bible entry is promoted to the
  // creative-ingredients catalog (server/services/catalogDB.js), this carries
  // the catalog row id so edits stay synchronized. Cap matches the catalog's
  // own id format ('cat-<prefix>-<uuid>') — generous so future id schemes fit.
  INGREDIENT_ID_MAX: 64,
  // Voice id namespace: `engine:voiceName` (e.g. `kokoro:af_heart`,
  // `piper:en_GB-northern_english_male`). Caps generously since 3rd-party
  // providers (ElevenLabs) use uuid-shaped voice ids.
  VOICE_ID_MAX: 200,
  // Reveal-gated canon (#2178): `surfaceDescriptor` is the pre-reveal
  // stand-in — what the world looks like BEFORE the spoiler is due ("the
  // locked east wing" vs "the wing where the heir is imprisoned"). Roomy
  // like a place description so a full surface-level paragraph fits.
  SURFACE_DESCRIPTOR_MAX: 2000,
  // Upper bound for the issue number a canon fact is revealed in. A generous
  // cap that comfortably exceeds any real series length while still rejecting
  // a hallucinated/overflowed integer.
  REVEAL_ISSUE_MAX: 100000,
});

// Canonical provenance vocabulary. `BIBLE_SOURCE.SERIES_EXTRACT` is the
// default for new bible-extracted entries; `UNIVERSE_EXPAND` is stamped on
// canon backfilled from a v1 universe's categories; `MANUAL` is user-authored.
// Legacy values ('user' / 'ai' / 'imported') are accepted on read so existing
// data round-trips; nothing in the codebase coerces them.
export const BIBLE_SOURCE = Object.freeze({
  UNIVERSE_EXPAND: 'universe-expand',
  SERIES_EXTRACT: 'series-extract',
  MANUAL: 'manual',
});
const SOURCES = new Set([
  ...Object.values(BIBLE_SOURCE),
  'user', 'ai', 'imported',
]);

export const BIBLE_KIND = Object.freeze({
  CHARACTER: 'character',
  PLACE: 'place',
  OBJECT: 'object',
});

// Structured relationship-link taxonomy (#1287). `type` is the dynamic
// between two characters; `custom` lets the writer name one the list misses
// (the free-text `description` carries the specifics). `opposition.axis`
// tags a binary-force tension (hunter/prey, winner/loser…) the reader tracks
// to see whether the roles ever reverse. Both default to `custom` on an
// unrecognized value rather than dropping the link, so a legacy/peer payload
// with a future type still round-trips (its prose description is preserved).
export const RELATIONSHIP_LINK_TYPES = Object.freeze([
  'ally', 'antagonist', 'rival', 'mentor', 'love-interest', 'family', 'custom',
]);
export const RELATIONSHIP_OPPOSITION_AXES = Object.freeze([
  'winner/loser', 'smart/dumb', 'hunter/prey', 'predator/prey', 'custom',
]);
const RELATIONSHIP_LINK_TYPE_SET = new Set(RELATIONSHIP_LINK_TYPES);
const RELATIONSHIP_OPPOSITION_AXIS_SET = new Set(RELATIONSHIP_OPPOSITION_AXES);

// Object↔character attachment archetypes (#1288). `role` tags WHAT the object
// is to the character narratively; `custom` lets the writer name one the list
// misses (the prose `significance`/`origin` carry the specifics). An
// unrecognized value coerces to `custom` rather than dropping the link, so a
// legacy/peer payload carrying a future role still round-trips with its prose.
export const ATTACHMENT_ROLES = Object.freeze([
  'talisman', 'macguffin', 'memento', 'tool', 'symbol', 'custom',
]);
const ATTACHMENT_ROLE_SET = new Set(ATTACHMENT_ROLES);

// Enums for the location-classification fields on Place canon entries.
// Mirrors AnyFilm's INT/EXT + time-of-day taxonomy so generated panels and
// scene starts inherit lighting/composition cues for free.
export const PLACE_INT_EXT = Object.freeze(['INT', 'EXT']);
export const PLACE_TIME_OF_DAY = Object.freeze(['dawn', 'day', 'dusk', 'night']);
const PLACE_INT_EXT_SET = new Set(PLACE_INT_EXT);
const PLACE_TIME_OF_DAY_SET = new Set(PLACE_TIME_OF_DAY);

const trimEnum = (raw, allowed) => {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const upper = trimmed.toUpperCase();
  if (allowed.has(upper)) return upper;
  const lower = trimmed.toLowerCase();
  if (allowed.has(lower)) return lower;
  return null;
};

// Canonical pluralization: pipeline series.<field>, evaluator analysis kind,
// extractor LLM envelope key — all the same string, consolidated here.
export const BIBLE_FIELD = Object.freeze({
  [BIBLE_KIND.CHARACTER]: 'characters',
  [BIBLE_KIND.PLACE]: 'places',
  [BIBLE_KIND.OBJECT]: 'objects',
});

// Ordered list of the persisted record's bible-array keys — used by
// store-walkers (e.g. imageRef purge across all kinds) so a future kind
// added here flows through without touching every walker.
export const BIBLE_KEYS = Object.freeze(Object.values(BIBLE_FIELD));

// Frozen list of kind values — for route/Zod kind validation, lock-toggle
// dispatch, and any caller that needs to enumerate kinds.
export const BIBLE_KINDS = Object.freeze(Object.values(BIBLE_KIND));

// Fields the bible-extraction prompt cares about. Routed both into the
// `existing<X>Json` prompt variable (bibleExtractor) and into the script
// stage's bibles context (evaluator). Excludes ids/timestamps/source/notes.
export const PROMPT_FIELDS = Object.freeze({
  [BIBLE_KIND.CHARACTER]: ['name', 'aliases', 'role', 'pronouns', 'age', 'coreTheme', 'speechAccent', 'speechPattern', 'visualNotes', 'physicalDescription', 'personality', 'background', 'silhouetteNotes', 'postureNotes', 'specialTraits', 'visualIdentity', 'motivations', 'likes', 'dislikes', 'mannerisms', 'relationships', 'skills', 'stats', 'colorPalette', 'props', 'expressions', 'handGestures', 'voiceId', 'wardrobes', 'prompt', 'tags'],
  [BIBLE_KIND.PLACE]: ['name', 'slugline', 'description', 'palette', 'era', 'weather', 'intExt', 'timeOfDay', 'recurringDetails', 'prompt', 'tags'],
  [BIBLE_KIND.OBJECT]: ['name', 'aliases', 'description', 'significance', 'prompt', 'tags'],
});

export function pickPromptFields(kind, entry) {
  const fields = PROMPT_FIELDS[kind];
  if (!fields || !entry) return {};
  const out = {};
  for (const f of fields) out[f] = entry[f];
  return out;
}

// Pipeline retains the legacy `'set-'` id prefix for places so every
// pre-rename `set-<uuid>` id on disk still round-trips through the
// sanitizer without a per-record id-rewrite migration. The bible-domain
// SETTING→PLACE rename is terminology only — ids are opaque after
// creation, and changing the prefix would force a second migration over
// every persisted canon entry for zero functional gain. Named here so a
// future reader doesn't mistake `place: 'set-'` for a typo introduced by
// the rename and "fix" it (which would silently break id round-tripping).
const LEGACY_PLACE_ID_PREFIX = 'set-';

// Default id prefix per kind. Pipeline accepts these defaults; writers-room
// passes its own `wr-char-` / `wr-place-` / `wr-object-` prefixes via the
// sanitizer options.
const DEFAULT_ID_PREFIX = Object.freeze({
  character: 'chr-',
  place: LEGACY_PLACE_ID_PREFIX,
  object: 'obj-',
});

// Tiny string helpers — exported so adjacent server modules (pipeline
// series.js, issues.js, etc.) stop redefining the same one-liners.
export const isStr = (v) => typeof v === 'string';
export const trimTo = (v, max) => (isStr(v) ? v.trim().slice(0, max) : '');

// Boundary-aware cap for PROSE fields (loglines, synopses, ending hooks). A hard
// `slice(0, max)` clips mid-word ("...tracing the brand and"), which downstream
// verify passes flag as "truncated mid-sentence" — and because a resolver then
// regenerates an over-cap value that gets re-clipped the same way, the
// verify→resolve loop never converges. When the text fits, it's returned
// untouched. When it must be clipped, back off to the last sentence terminator
// (. ! ?) within the budget; if there's no sentence break in the last ~40% of
// the budget (one run-on sentence), fall back to the last whitespace boundary so
// the result still ends on a whole word. Never returns more than `max` chars.
export function trimToClause(v, max) {
  if (!isStr(v)) return '';
  const s = v.trim();
  if (s.length <= max) return s;
  const window = s.slice(0, max);
  // Prefer the last sentence terminator, but only if it's not so early that we'd
  // drop most of the content (keep at least ~60% of the budget).
  const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
  if (sentence >= Math.floor(max * 0.6)) return window.slice(0, sentence + 1).trim();
  // No usable sentence break — clip on the last whole word instead of mid-word.
  const space = window.lastIndexOf(' ');
  return (space > 0 ? window.slice(0, space) : window).trim();
}

// Walk a raw array through a per-item sanitizer, dropping rejected entries
// (falsy return from `sanitizer`) and capping the output at `cap`. Three
// near-identical loops elsewhere in this file (cleanStringArray, the wardrobe
// list, the per-kind bible list) collapsed onto this single primitive so a
// future cap/skip rule change lands in one place.
const sanitizeListWith = (raw, sanitizer, cap) => {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const v of raw) {
    const s = sanitizer(v);
    if (!s) continue;
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
};

const cleanStringArray = (raw, itemMax, listMax) =>
  sanitizeListWith(raw, (v) => trimTo(v, itemMax), listMax);

export const isBlank = (v) => {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (isStr(v)) return v.trim() === '';
  return false;
};

export const normalizeBibleName = (name) => String(name || '').trim().toLowerCase();

/**
 * Case-insensitive lookup by `name` OR `aliases[]` (using
 * `normalizeBibleName`). Returns the first match or undefined; tolerates a
 * non-array list, blank needle, and null entries. Places use sluglines
 * for their primary identity; use `normalizeSlugline` + a Map lookup for
 * those instead — this helper is name-keyed.
 */
export function findBibleEntryByName(list, name) {
  if (!Array.isArray(list)) return undefined;
  const needle = normalizeBibleName(name);
  if (!needle) return undefined;
  return list.find((e) => normalizeBibleName(e?.name) === needle
    || (Array.isArray(e?.aliases) && e.aliases.some((a) => normalizeBibleName(a) === needle)));
}

// Single source of truth for fields that LIVE on a canon entry but are
// NOT freely user-editable through the normal LLM/client flow. Each entry
// names *why* a guard exists; the consumers below read from this list so
// adding a new operational field is one edit, not three.
//
// - `id/createdAt/updatedAt`: freshly minted by the per-kind sanitizer.
// - `locked`: a hallucinated `true` would block user edits without a Lock
//   UI click — purely a user-driven toggle.
// - `sourceSeriesId`: provenance owned by series imports.
// - `imageRefs` / `primaryImageRef`: user-uploaded gallery references —
//   the user is the writer here, but the LLM should not hallucinate
//   filenames into the gallery.
// - `referenceSheetImageRef`: SERVER-stamped operational pointer. The
//   render-completion mutator is the sole writer. Distinct from the
//   `imageRefs[]` gallery — lives in `data/image-refs/`.
//
// `SERVER_OWNED_CHARACTER_FIELDS` is a strict subset: ONLY the pointers
// that the *server* writes via render-completion mutators (never the
// client, never the LLM). `updateUniverse` preserves these across
// literal-object PATCHes so a stale client body can't clobber a newer
// server stamp (multi-tab / parallel render race). Mutator-form callers
// are trusted to update these (they read `cur` themselves).
export const CANON_CONTROL_FIELDS = Object.freeze([
  'id', 'createdAt', 'updatedAt',
  'locked', 'sourceSeriesId',
  'imageRefs', 'primaryImageRef',
  // Sheet pointers — see SHEET_VARIANTS in universeCharacterSheet.js for the
  // catalog of styles; legacy 'standard' stays in `referenceSheetImageRef`,
  // every other variant lives in `referenceSheets[<id>]`.
  'referenceSheetImageRef', 'referenceSheets',
]);

export const SERVER_OWNED_CHARACTER_FIELDS = Object.freeze([
  'referenceSheetImageRef', 'referenceSheets',
]);

export function stripCanonControlFields(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const rest = { ...entry };
  for (const f of CANON_CONTROL_FIELDS) delete rest[f];
  return rest;
}

export const nowIso = () => new Date().toISOString();

// Any non-empty string `raw` round-trips verbatim — the `idPrefix` arg is
// ONLY used to mint a fresh id when `raw` is absent/blank. Callers that
// need to enforce a per-shape prefix (e.g. drop a client-supplied
// `pending-*` placeholder so a fresh `<kind>-<uuid>` gets minted) must
// strip the offending id before calling.
function ensureId(raw, idPrefix) {
  if (isStr(raw) && raw) return raw;
  return `${idPrefix}${randomUUID()}`;
}

function ensureSource(raw) {
  // Default 'user' preserves the writers-room badge UI; universe-canon callers
  // pass `BIBLE_SOURCE.*` explicitly.
  return SOURCES.has(raw) ? raw : 'user';
}

function ensureFirstAppearance(raw) {
  return isStr(raw) && raw.trim() ? raw.trim().slice(0, 200) : null;
}

// Primary reference image (A3/A4/A5). User pins one of the canon entry's
// existing `imageRefs[]` as the canonical visual anchor. Stale pointers
// (primary names a filename that was later removed from imageRefs) collapse
// to null so the UI doesn't render a broken star indicator. Returns the
// validated filename or null — never undefined, so the shape stays explicit.
function derivePrimaryImageRef(raw, imageRefs) {
  if (!isStr(raw) || !raw.trim()) return null;
  const trimmed = raw.trim().slice(0, BIBLE_LIMITS.IMAGE_REF_MAX);
  return imageRefs.includes(trimmed) ? trimmed : null;
}

// Generated character reference sheet pointer. Server-owned (set by the
// render-completion handler), basename-only-validated here (synchronous,
// keeps the sanitizer pure so it stays cheap on every universe read).
// Stale-file collapse happens at GET time via `pruneStaleReferenceSheets`
// below — a deleted file lazily nulls on the next universe load, but the
// sanitizer doesn't pay an FS stat on every character it sanitizes.
function deriveReferenceSheetImageRef(raw) {
  if (!isStr(raw) || !raw.trim()) return null;
  const trimmed = raw.trim().slice(0, BIBLE_LIMITS.IMAGE_REF_MAX);
  if (trimmed === '.' || trimmed === '..') return null;
  if (trimmed.includes('/') || trimmed.includes('\\')) return null;
  if (trimmed.startsWith('.')) return null;
  return trimmed;
}

// The legacy 'standard' variant lives in `character.referenceSheetImageRef`;
// every other variant lives in `character.referenceSheets[<id>]`. Exported so
// every reader/writer of either slot uses the same constant — the alternative
// is a magic string repeated in ~14 places.
export const LEGACY_SHEET_VARIANT_ID = 'standard';

// Variant-id rules for `referenceSheets` map keys: short kebab-case identifier,
// no path separators, no dot-prefix. Cap of 48 chars matches the route schema.
// The legacy id is rejected because it must stay in the legacy field, not in
// the map (otherwise sanitize / prune / purge would have to pick which slot wins).
const VARIANT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
function isValidVariantId(id) {
  return typeof id === 'string' && VARIANT_ID_RE.test(id) && id !== LEGACY_SHEET_VARIANT_ID;
}

/** Read the persisted reference-sheet filename for a variant. Returns the
 *  string filename or null. The single read-side helper every consumer
 *  (client + server) should use so storage-shape changes stay local. */
export function readSheetPointer(character, variant) {
  if (!character) return null;
  if (variant === LEGACY_SHEET_VARIANT_ID) return character.referenceSheetImageRef || null;
  const sheets = character.referenceSheets;
  if (!isPlainObject(sheets)) return null;
  return sheets[variant] || null;
}

/** Enumerate every reference-sheet pointer a character holds — yields one
 *  `{ variant, filename }` per non-empty slot. The single iteration-side
 *  helper for prune / purge / exporter / asset-collector. */
export function listSheetPointers(character) {
  if (!character) return [];
  const out = [];
  if (character.referenceSheetImageRef) {
    out.push({ variant: LEGACY_SHEET_VARIANT_ID, filename: character.referenceSheetImageRef });
  }
  if (isPlainObject(character.referenceSheets)) {
    for (const [variant, filename] of Object.entries(character.referenceSheets)) {
      if (filename) out.push({ variant, filename });
    }
  }
  return out;
}

/** Merge `prev`'s server-stamped sheet pointers into `patchChar`, keeping
 *  cur's value for every slot whose underlying file still exists on disk.
 *  Run by the `updateUniverse` literal-patch preservation guard so a stale
 *  client snapshot can't clobber a render-completion stamp that landed
 *  between GET and PATCH. Per-key for the map: each `referenceSheets[k]`
 *  is considered independently so a freshly-stamped 'blueprint' survives
 *  even when the patch carries an older `referenceSheets` (or omits it).
 *
 *  `resolveExists(filename) → boolean` is injected so this helper stays
 *  pure with respect to the FS — callers wire `resolveImageRef(..., { mustExist: true })`
 *  in. Returns a new character object; callers should treat it as
 *  immutable-by-convention. */
export function mergePreservedSheetPointers(prev, patchChar, resolveExists) {
  if (!prev || !patchChar) return patchChar;
  const out = { ...patchChar };

  if (prev.referenceSheetImageRef && resolveExists(prev.referenceSheetImageRef)) {
    out.referenceSheetImageRef = prev.referenceSheetImageRef;
  }

  const prevMap = isPlainObject(prev.referenceSheets) ? prev.referenceSheets : null;
  if (prevMap) {
    const patchMap = isPlainObject(patchChar.referenceSheets) ? patchChar.referenceSheets : {};
    // Preserved keys win over the patch — same one-way precedence as the
    // legacy field. Unresolvable cur values fall through so a deleted-then-
    // PATCHed slot can clear.
    const merged = { ...patchMap };
    for (const [variant, filename] of Object.entries(prevMap)) {
      if (filename && resolveExists(filename)) merged[variant] = filename;
    }
    out.referenceSheets = merged;
  }

  return out;
}

/** Apply (or clear, when `filename` is null) a variant's pointer on a
 *  character, returning a NEW character object — OR the same reference when
 *  the slot already holds the target value, so callers downstream of an
 *  `updateUniverse` mutator (and React subscribers on the client mirror)
 *  can short-circuit no-op writes/renders. Writes the legacy variant to
 *  `referenceSheetImageRef`; every other variant lands in / leaves from
 *  `referenceSheets[variant]`. */
export function applySheetPointerToCharacter(character, variant, filename) {
  if (!character) return character;
  if (variant === LEGACY_SHEET_VARIANT_ID) {
    const next = filename || null;
    if ((character.referenceSheetImageRef || null) === next) return character;
    return { ...character, referenceSheetImageRef: next };
  }
  const existing = isPlainObject(character.referenceSheets) ? character.referenceSheets : {};
  if (filename) {
    if (existing[variant] === filename) return character;
    return { ...character, referenceSheets: { ...existing, [variant]: filename } };
  }
  if (!(variant in existing)) return character;
  const { [variant]: _dropped, ...rest } = existing;
  return { ...character, referenceSheets: rest };
}

/**
 * Sanitize the `referenceSheets` map. Drops invalid variant ids, basename-
 * validates every filename, returns a fresh frozen object with only valid
 * entries. An LLM-extracted payload that somehow includes this field (it
 * shouldn't — it's in CANON_CONTROL_FIELDS — but defense in depth) cannot
 * smuggle a path traversal or an unknown sentinel into the persisted state.
 *
 * Always returns an object (possibly empty). The renderer treats absent
 * keys as "no sheet rendered yet" and absent vs. empty map identically.
 */
function deriveReferenceSheets(raw) {
  if (!isPlainObject(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isValidVariantId(key)) continue;
    const filename = deriveReferenceSheetImageRef(value);
    if (!filename) continue;
    out[key] = filename;
  }
  return out;
}

/**
 * Walk a character list and null out any reference-sheet pointer whose
 * underlying file no longer exists in PATHS.imageRefs. Returns a NEW list
 * (cheap shallow copy per character) so callers can persist the cleaned
 * state. Pure with respect to the sanitizer — no FS I/O during sanitize,
 * just here at the "GET universe / verify before render" boundary.
 *
 * CONVENTION: call from BOTH the GET universe route AND `updateUniverse`'s
 * write path. GET alone is not sufficient — without the write-time call,
 * stale values stay on disk and a later PATCH that omits `characters`
 * (e.g. rename) resurfaces the stale filename in the response.
 *
 * Memoizes `resolveImageRef` per call so a 50-character × 5-variant cast
 * doesn't fan out into 250 redundant sync `statSync`s — every distinct
 * filename costs one stat, not one stat per slot it appears in.
 */
export function pruneStaleReferenceSheets(characters) {
  if (!Array.isArray(characters)) return characters;
  const resolvedCache = new Map();
  const fileExists = (name) => {
    if (resolvedCache.has(name)) return resolvedCache.get(name);
    const ok = !!resolveImageRef(name, { mustExist: true });
    resolvedCache.set(name, ok);
    return ok;
  };
  let changed = false;
  const out = characters.map((c) => {
    if (!c) return c;
    let next = c;
    for (const { variant, filename } of listSheetPointers(c)) {
      if (fileExists(filename)) continue;
      next = applySheetPointerToCharacter(next, variant, null);
      changed = true;
    }
    return next;
  });
  return changed ? out : characters;
}

// CONVENTION: every per-row sanitizer below stamps a stable `id` via
// `ensureId`. The character editor (CharacterDetailEditor.jsx) binds local
// draft state to each `ListRow` via its React key — without a server-stamped
// id, the key falls back to row index and a delete-then-edit sequence carries
// the wrong drafts buffer onto the wrong row. New list shapes added here
// MUST include `id: ensureId(raw.id, '<prefix>-')`.

// Wardrobe sanitizer (A2). One entry per outfit/styling variant; the
// description is image-gen-ready prose ("worn linen suit, gold pocket watch,
// scuffed wingtips"). Reference images per wardrobe land in a follow-up.
function sanitizeWardrobe(raw, { preserveTimestamps = true } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const name = trimTo(raw.name, BIBLE_LIMITS.WARDROBE_NAME_MAX);
  if (!name) return null;
  return {
    id: ensureId(raw.id, 'wd-'),
    name,
    description: trimTo(raw.description, BIBLE_LIMITS.WARDROBE_DESCRIPTION_MAX),
    createdAt: preserveTimestamps && isStr(raw.createdAt) ? raw.createdAt : nowIso(),
    updatedAt: preserveTimestamps && isStr(raw.updatedAt) ? raw.updatedAt : nowIso(),
  };
}

function sanitizeWardrobeList(raw, opts = {}) {
  return sanitizeListWith(
    raw,
    (w) => sanitizeWardrobe(w, opts),
    BIBLE_LIMITS.WARDROBES_PER_CHARACTER_MAX,
  );
}

// Flexible stat entry — open label/value so non-humans aren't shoehorned into
// "height/weight/eyes" assumptions. Both fields are strings; the LLM expand
// flow may emit "Unknown" / "N/A" rather than blank, which is fine.
function sanitizeStat(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const label = trimTo(raw.label, BIBLE_LIMITS.STAT_LABEL_MAX);
  if (!label) return null;
  // Stable id so the editor's per-row local state (drafts buffer in
  // ListRow.jsx) doesn't carry over when an earlier row is deleted — without
  // it, React falls back to an index key and reuses the wrong row instance.
  return { id: ensureId(raw.id, 'stat-'), label, value: trimTo(raw.value, BIBLE_LIMITS.STAT_VALUE_MAX) };
}

// Color palette swatch. `hex` is optional — pure-name palettes still flow
// through; the prompt builder skips the "#xxxxxx" fragment when blank. We
// don't validate hex strictness here; the LLM may emit "amber" / "off-white".
function sanitizePaletteColor(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = trimTo(raw.name, BIBLE_LIMITS.COLOR_NAME_MAX);
  if (!name) return null;
  return {
    id: ensureId(raw.id, 'color-'),
    name,
    hex: trimTo(raw.hex, BIBLE_LIMITS.COLOR_HEX_MAX),
    role: trimTo(raw.role, BIBLE_LIMITS.COLOR_ROLE_MAX),
  };
}

// Prop entry — gets a UUID id like wardrobes for stable React keys. Name is
// required; everything else is free-form prose for the artist.
function sanitizeProp(raw, { preserveTimestamps = true } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const name = trimTo(raw.name, BIBLE_LIMITS.PROP_NAME_MAX);
  if (!name) return null;
  return {
    id: ensureId(raw.id, 'prop-'),
    name,
    purpose: trimTo(raw.purpose, BIBLE_LIMITS.PROP_PURPOSE_MAX),
    materials: trimTo(raw.materials, BIBLE_LIMITS.PROP_MATERIALS_MAX),
    notes: trimTo(raw.notes, BIBLE_LIMITS.PROP_NOTES_MAX),
    // Per-prop reference image is optional. Stored as a trimmed string only —
    // there's no derive-against-imageRefs[] check here because a prop image is
    // free-standing (the user can upload directly to the prop card; it doesn't
    // need to be a member of the character's gallery imageRefs[]). Stale
    // filenames are tolerated and produce a 404 in the UI rather than a
    // sanitizer collapse. Treat this string as untrusted at render time.
    imageRef: isStr(raw.imageRef) && raw.imageRef.trim() ? raw.imageRef.trim().slice(0, BIBLE_LIMITS.IMAGE_REF_MAX) : null,
    createdAt: preserveTimestamps && isStr(raw.createdAt) ? raw.createdAt : nowIso(),
    updatedAt: preserveTimestamps && isStr(raw.updatedAt) ? raw.updatedAt : nowIso(),
  };
}

// Expression entry — name + 1-line prose description. The reference-sheet
// builder uses up to 7; remaining entries are still available to per-page
// shot prompts that key on a named expression.
function sanitizeExpression(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = trimTo(raw.name, BIBLE_LIMITS.EXPRESSION_NAME_MAX);
  if (!name) return null;
  return { id: ensureId(raw.id, 'expr-'), name, description: trimTo(raw.description, BIBLE_LIMITS.EXPRESSION_DESC_MAX) };
}

// Hand-gesture entry — name + 1-line prose. Mirrors expression shape so the
// editor UI can reuse the same row component.
function sanitizeHandGesture(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = trimTo(raw.name, BIBLE_LIMITS.GESTURE_NAME_MAX);
  if (!name) return null;
  return { id: ensureId(raw.id, 'gesture-'), name, description: trimTo(raw.description, BIBLE_LIMITS.GESTURE_DESC_MAX) };
}

// Structured relationship link (#1287). Requires a `targetCharacterId` — a
// link with nothing to point at is meaningless, so a blank target drops the
// row (matches the name-required pattern in the other list sanitizers). `type`
// and `opposition.axis` normalize an unrecognized value to `custom` rather
// than dropping it, so a peer/legacy payload carrying a future enum value
// still round-trips with its prose intact. `opposition` collapses to absent
// unless an axis is present, and `locked` persists explicit true/false only.
function sanitizeOpposition(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const axisRaw = trimTo(raw.axis, BIBLE_LIMITS.RELATIONSHIP_OPPOSITION_AXIS_MAX);
  if (!axisRaw) return null;
  const axis = RELATIONSHIP_OPPOSITION_AXIS_SET.has(axisRaw) ? axisRaw : 'custom';
  return {
    axis,
    thisRole: trimTo(raw.thisRole, BIBLE_LIMITS.RELATIONSHIP_OPPOSITION_ROLE_MAX),
    targetRole: trimTo(raw.targetRole, BIBLE_LIMITS.RELATIONSHIP_OPPOSITION_ROLE_MAX),
    note: trimTo(raw.note, BIBLE_LIMITS.RELATIONSHIP_OPPOSITION_NOTE_MAX),
  };
}

function sanitizeRelationshipLink(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const targetCharacterId = trimTo(raw.targetCharacterId, BIBLE_LIMITS.RELATIONSHIP_TARGET_ID_MAX);
  if (!targetCharacterId) return null;
  const typeRaw = trimTo(raw.type, BIBLE_LIMITS.RELATIONSHIP_TYPE_MAX);
  const type = RELATIONSHIP_LINK_TYPE_SET.has(typeRaw) ? typeRaw : 'custom';
  const out = {
    id: ensureId(raw.id, 'rel-'),
    targetCharacterId,
    type,
    description: trimTo(raw.description, BIBLE_LIMITS.RELATIONSHIP_DESCRIPTION_MAX),
  };
  const opposition = sanitizeOpposition(raw.opposition);
  if (opposition) out.opposition = opposition;
  if (raw.locked === true) out.locked = true;
  else if (raw.locked === false) out.locked = false;
  return out;
}

// Structured object↔character attachment (#1288). Requires a `characterId` — an
// attachment with nothing to bind to is meaningless, so a blank target drops the
// row (matches the targetCharacterId-required pattern in sanitizeRelationshipLink).
// `role` normalizes an unrecognized value to `custom` rather than dropping it, so
// a peer/legacy payload carrying a future role still round-trips with its prose
// (emotion/significance/origin) intact. `locked` persists explicit true/false only.
function sanitizeAttachment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const characterId = trimTo(raw.characterId, BIBLE_LIMITS.ATTACHMENT_CHARACTER_ID_MAX);
  if (!characterId) return null;
  const roleRaw = trimTo(raw.role, 60);
  const role = ATTACHMENT_ROLE_SET.has(roleRaw) ? roleRaw : 'custom';
  const out = {
    id: ensureId(raw.id, 'att-'),
    characterId,
    emotion: trimTo(raw.emotion, BIBLE_LIMITS.ATTACHMENT_EMOTION_MAX),
    significance: trimTo(raw.significance, BIBLE_LIMITS.ATTACHMENT_SIGNIFICANCE_MAX),
    origin: trimTo(raw.origin, BIBLE_LIMITS.ATTACHMENT_ORIGIN_MAX),
    role,
  };
  if (raw.locked === true) out.locked = true;
  else if (raw.locked === false) out.locked = false;
  return out;
}

// Normalize a reveal-issue gate to a positive integer or null. Accepts a
// finite number or a numeric string (LLM/JSON both occur); a 0/negative/
// non-integer/over-cap value collapses to null (no gate). Null = the entry is
// always visible — the backward-compatible default for every existing canon
// entry that predates reveal gating (#2178).
function ensureRevealIssue(raw) {
  const n = typeof raw === 'number' ? raw : (isStr(raw) && raw.trim() !== '' ? Number(raw) : NaN);
  if (!Number.isInteger(n) || n < 1 || n > BIBLE_LIMITS.REVEAL_ISSUE_MAX) return null;
  return n;
}

// Shared canon extras applied to every kind. Persists explicit `locked: true`
// AND `locked: false` so a Universe-Builder caller can flip the bit and have
// the change survive round-trips. Missing `locked` still collapses to absent
// — writers-room callers that never set the flag stay on the legacy shape.
function applyCanonExtras(raw) {
  const out = {
    prompt: trimTo(raw.prompt, BIBLE_LIMITS.PROMPT_MAX),
    tags: cleanStringArray(raw.tags, BIBLE_LIMITS.TAG_MAX, BIBLE_LIMITS.TAGS_PER_ENTRY_MAX),
    source: ensureSource(raw.source),
    sourceSeriesId: trimTo(raw.sourceSeriesId, BIBLE_LIMITS.SOURCE_SERIES_ID_MAX) || null,
    // Catalog backlink — populated when this entry is promoted to or sourced
    // from the creative ingredients catalog. `null` keeps the field present on
    // every entry so the round-trip never strips it on a not-yet-promoted
    // record. See migrateBibleToCatalog.js for the backfill path.
    ingredientId: trimTo(raw.ingredientId, BIBLE_LIMITS.INGREDIENT_ID_MAX) || null,
    // Reveal-gated canon / spoiler scoping (#2178). All three collapse to
    // null/absent so every pre-existing entry stays "always visible" (full
    // backward compat; peers store the fields verbatim). `revealIssue` is the
    // issue number at/after which the fact may enter a drafting prompt;
    // `surfaceDescriptor` is the pre-reveal stand-in substituted into context
    // before then. `spoiler` is a soft flag (gate without a specific issue) —
    // an entry the writer wants excluded from drafting context regardless of
    // issue number (autonovel's "MYSTERY.md is not for drafting" pattern).
    revealIssue: ensureRevealIssue(raw.revealIssue),
    surfaceDescriptor: trimTo(raw.surfaceDescriptor, BIBLE_LIMITS.SURFACE_DESCRIPTOR_MAX) || null,
  };
  if (raw.locked === true) out.locked = true;
  else if (raw.locked === false) out.locked = false;
  if (raw.spoiler === true) out.spoiler = true;
  else if (raw.spoiler === false) out.spoiler = false;
  return out;
}

// Pipeline + writers-room shapes both use `physicalDescription`. Migration 019
// rewrites the legacy `description` alias forward, but the read-side fallback
// stays in place so a load-before-migration doesn't silently drop the text on
// next save (only `physicalDescription` is written back, so any record that
// survives this read normalizes on its next persist).
export function sanitizeCharacter(raw, { idPrefix = DEFAULT_ID_PREFIX.character, preserveTimestamps = true } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const name = trimTo(raw.name, BIBLE_LIMITS.NAME_MAX);
  if (!name) return null;
  const physicalDescription = trimTo(
    raw.physicalDescription || raw.description || '',
    BIBLE_LIMITS.PHYSICAL_DESCRIPTION_MAX,
  );
  const created = preserveTimestamps && isStr(raw.createdAt) ? raw.createdAt : nowIso();
  const imageRefs = cleanStringArray(raw.imageRefs, BIBLE_LIMITS.IMAGE_REF_MAX, BIBLE_LIMITS.IMAGE_REFS_PER_ENTRY_MAX);
  return {
    id: ensureId(raw.id, idPrefix),
    name,
    aliases: cleanStringArray(raw.aliases, BIBLE_LIMITS.ALIAS_MAX, BIBLE_LIMITS.ALIASES_PER_ENTRY_MAX),
    role: trimTo(raw.role, BIBLE_LIMITS.ROLE_MAX),
    // Identity (novelist-grade depth). All optional; downstream consumers
    // (LLM extractor, render-prompt builder, reference-sheet renderer) check
    // for blank and skip the corresponding fragment.
    pronouns: trimTo(raw.pronouns, BIBLE_LIMITS.PRONOUNS_MAX),
    age: trimTo(raw.age, BIBLE_LIMITS.AGE_MAX),
    coreTheme: trimTo(raw.coreTheme, BIBLE_LIMITS.CORE_THEME_MAX),
    speechAccent: trimTo(raw.speechAccent, BIBLE_LIMITS.SPEECH_ACCENT_MAX),
    // Written speech-pattern (cadence, sentence-structure, lexical tics) —
    // distinct from `voiceId` (TTS engine pointer) and `speechAccent`
    // (regional/cultural accent). Used by script + script-adjacent prompts so
    // dialogue carries the character's prose voice, not just their accent.
    speechPattern: trimTo(raw.speechPattern, BIBLE_LIMITS.SPEECH_PATTERN_MAX),
    visualNotes: trimTo(raw.visualNotes, BIBLE_LIMITS.VISUAL_NOTES_MAX),
    physicalDescription,
    personality: trimTo(raw.personality, BIBLE_LIMITS.PERSONALITY_MAX),
    background: trimTo(raw.background, BIBLE_LIMITS.BACKGROUND_MAX),
    // Visual identity (graphic-novelist-grade). These feed the
    // reference-sheet renderer and per-page shot prompts.
    silhouetteNotes: trimTo(raw.silhouetteNotes, BIBLE_LIMITS.SILHOUETTE_NOTES_MAX),
    postureNotes: trimTo(raw.postureNotes, BIBLE_LIMITS.POSTURE_NOTES_MAX),
    specialTraits: trimTo(raw.specialTraits, BIBLE_LIMITS.SPECIAL_TRAITS_MAX),
    visualIdentity: trimTo(raw.visualIdentity, BIBLE_LIMITS.VISUAL_IDENTITY_MAX),
    // Narrative depth — drives dialogue + arc planning.
    motivations: trimTo(raw.motivations, BIBLE_LIMITS.MOTIVATIONS_MAX),
    likes: trimTo(raw.likes, BIBLE_LIMITS.LIKES_MAX),
    dislikes: trimTo(raw.dislikes, BIBLE_LIMITS.DISLIKES_MAX),
    mannerisms: trimTo(raw.mannerisms, BIBLE_LIMITS.MANNERISMS_MAX),
    relationships: trimTo(raw.relationships, BIBLE_LIMITS.RELATIONSHIPS_MAX),
    // Structured character-to-character links + opposing-force tags (#1287).
    // Additive to the legacy prose `relationships` field above. Empty array
    // stays the legacy shape — every existing character keeps round-tripping.
    relationshipLinks: sanitizeListWith(
      raw.relationshipLinks,
      sanitizeRelationshipLink,
      BIBLE_LIMITS.RELATIONSHIP_LINKS_PER_CHARACTER_MAX,
    ),
    skills: trimTo(raw.skills, BIBLE_LIMITS.SKILLS_MAX),
    notes: trimTo(raw.notes, BIBLE_LIMITS.NOTES_MAX),
    // Flexible stats list. Open key/value so ghosts/spiders/clouds aren't
    // forced into human anatomy categories.
    stats: sanitizeListWith(raw.stats, sanitizeStat, BIBLE_LIMITS.STATS_PER_CHARACTER_MAX),
    // Named color palette for the artist reference sheet + per-page render.
    colorPalette: sanitizeListWith(raw.colorPalette, sanitizePaletteColor, BIBLE_LIMITS.COLORS_PER_PALETTE_MAX),
    // Props the character carries / interacts with. Persists across panels;
    // the reference sheet renders these as prop-detail cards.
    props: sanitizeListWith(raw.props, (p) => sanitizeProp(p, { preserveTimestamps }), BIBLE_LIMITS.PROPS_PER_CHARACTER_MAX),
    // Expression + gesture menus drive the per-panel reference sheet zones
    // and can be cited from page-render prompts ("expression: 'curious'").
    expressions: sanitizeListWith(raw.expressions, sanitizeExpression, BIBLE_LIMITS.EXPRESSIONS_PER_CHARACTER_MAX),
    handGestures: sanitizeListWith(raw.handGestures, sanitizeHandGesture, BIBLE_LIMITS.GESTURES_PER_CHARACTER_MAX),
    // Voice binding for VO synthesis (kokoro/piper local OSS, ElevenLabs
    // when configured). null = use the project default at synth time.
    voiceId: trimTo(raw.voiceId, BIBLE_LIMITS.VOICE_ID_MAX) || null,
    imageRefs,
    // Pinned visual anchor (A3). One of imageRefs marked canonical so
    // downstream renders + the UI know which to lean on.
    primaryImageRef: derivePrimaryImageRef(raw.primaryImageRef, imageRefs),
    // Generated character reference sheet filename (lives in data/image-refs/,
    // not in imageRefs[] — the sheet is operational metadata, not a candidate
    // for arbitrary panel reference). Basename-validated so an LLM-extracted
    // payload that snuck past stripCanonControlFields can't persist a path
    // the UI would 404 on or that would escape PATHS.imageRefs at render time.
    referenceSheetImageRef: deriveReferenceSheetImageRef(raw.referenceSheetImageRef),
    // Variant-keyed pointers for non-legacy sheet styles (`blueprint`, etc.).
    // Per-variant filenames live here; the legacy 'standard' variant keeps
    // using `referenceSheetImageRef` above so existing data needs no
    // migration. Sanitizer drops invalid keys and basename-validates every
    // value with the same rules as the legacy field.
    referenceSheets: deriveReferenceSheets(raw.referenceSheets),
    // Wardrobes (A2): outfit/styling variants applied on top of
    // physicalDescription. Empty array stays the legacy shape — every
    // existing character keeps rendering through physicalDescription alone.
    wardrobes: sanitizeWardrobeList(raw.wardrobes, { preserveTimestamps }),
    firstAppearance: ensureFirstAppearance(raw.firstAppearance),
    evidence: cleanStringArray(raw.evidence, BIBLE_LIMITS.EVIDENCE_ITEM_MAX, BIBLE_LIMITS.EVIDENCE_PER_ENTRY_MAX),
    missingFromProse: cleanStringArray(raw.missingFromProse, BIBLE_LIMITS.EVIDENCE_ITEM_MAX, BIBLE_LIMITS.EVIDENCE_PER_ENTRY_MAX),
    ...applyCanonExtras(raw),
    createdAt: created,
    updatedAt: preserveTimestamps && isStr(raw.updatedAt) ? raw.updatedAt : nowIso(),
  };
}

export function sanitizePlace(raw, { idPrefix = DEFAULT_ID_PREFIX.place, preserveTimestamps = true } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const name = trimTo(raw.name, BIBLE_LIMITS.NAME_MAX);
  const slugline = trimTo(raw.slugline, BIBLE_LIMITS.SLUGLINE_MAX);
  // A place needs at least one identifier (name OR slugline). Without
  // either there's nothing for a scene matcher to key on.
  if (!name && !slugline) return null;
  const created = preserveTimestamps && isStr(raw.createdAt) ? raw.createdAt : nowIso();
  const imageRefs = cleanStringArray(raw.imageRefs, BIBLE_LIMITS.IMAGE_REF_MAX, BIBLE_LIMITS.IMAGE_REFS_PER_ENTRY_MAX);
  return {
    id: ensureId(raw.id, idPrefix),
    name,
    slugline,
    description: trimTo(raw.description, BIBLE_LIMITS.PLACE_DESCRIPTION_MAX),
    palette: trimTo(raw.palette, BIBLE_LIMITS.PALETTE_MAX),
    era: trimTo(raw.era, BIBLE_LIMITS.ERA_MAX),
    weather: trimTo(raw.weather, BIBLE_LIMITS.WEATHER_MAX),
    // INT/EXT + time-of-day enums (Cluster A). null when unset — scene-prompt
    // composer skips the metadata fragment in that case so legacy places
    // keep rendering with description-only prompts.
    intExt: trimEnum(raw.intExt, PLACE_INT_EXT_SET),
    timeOfDay: trimEnum(raw.timeOfDay, PLACE_TIME_OF_DAY_SET),
    recurringDetails: trimTo(raw.recurringDetails, BIBLE_LIMITS.RECURRING_DETAILS_MAX),
    notes: trimTo(raw.notes, BIBLE_LIMITS.NOTES_MAX),
    imageRefs,
    // A4: clean-plate / canonical location render pinned for downstream.
    primaryImageRef: derivePrimaryImageRef(raw.primaryImageRef, imageRefs),
    firstAppearance: ensureFirstAppearance(raw.firstAppearance),
    evidence: cleanStringArray(raw.evidence, BIBLE_LIMITS.EVIDENCE_ITEM_MAX, BIBLE_LIMITS.EVIDENCE_PER_ENTRY_MAX),
    missingFromProse: cleanStringArray(raw.missingFromProse, BIBLE_LIMITS.EVIDENCE_ITEM_MAX, BIBLE_LIMITS.EVIDENCE_PER_ENTRY_MAX),
    ...applyCanonExtras(raw),
    createdAt: created,
    updatedAt: preserveTimestamps && isStr(raw.updatedAt) ? raw.updatedAt : nowIso(),
  };
}

export function sanitizeObject(raw, { idPrefix = DEFAULT_ID_PREFIX.object, preserveTimestamps = true } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const name = trimTo(raw.name, BIBLE_LIMITS.NAME_MAX);
  if (!name) return null;
  const created = preserveTimestamps && isStr(raw.createdAt) ? raw.createdAt : nowIso();
  const imageRefs = cleanStringArray(raw.imageRefs, BIBLE_LIMITS.IMAGE_REF_MAX, BIBLE_LIMITS.IMAGE_REFS_PER_ENTRY_MAX);
  return {
    id: ensureId(raw.id, idPrefix),
    name,
    aliases: cleanStringArray(raw.aliases, BIBLE_LIMITS.ALIAS_MAX, BIBLE_LIMITS.ALIASES_PER_ENTRY_MAX),
    description: trimTo(raw.description, BIBLE_LIMITS.OBJECT_DESCRIPTION_MAX),
    significance: trimTo(raw.significance, BIBLE_LIMITS.SIGNIFICANCE_MAX),
    // Structured object↔character attachment links (#1288). Additive to the
    // legacy prose `significance` field above. Empty array stays the legacy
    // shape — every existing object keeps round-tripping unchanged.
    attachments: sanitizeListWith(
      raw.attachments,
      sanitizeAttachment,
      BIBLE_LIMITS.ATTACHMENTS_PER_OBJECT_MAX,
    ),
    notes: trimTo(raw.notes, BIBLE_LIMITS.NOTES_MAX),
    imageRefs,
    // A5: canonical prop / hero-object reference render.
    primaryImageRef: derivePrimaryImageRef(raw.primaryImageRef, imageRefs),
    firstAppearance: ensureFirstAppearance(raw.firstAppearance),
    evidence: cleanStringArray(raw.evidence, BIBLE_LIMITS.EVIDENCE_ITEM_MAX, BIBLE_LIMITS.EVIDENCE_PER_ENTRY_MAX),
    missingFromProse: cleanStringArray(raw.missingFromProse, BIBLE_LIMITS.EVIDENCE_ITEM_MAX, BIBLE_LIMITS.EVIDENCE_PER_ENTRY_MAX),
    ...applyCanonExtras(raw),
    createdAt: created,
    updatedAt: preserveTimestamps && isStr(raw.updatedAt) ? raw.updatedAt : nowIso(),
  };
}

/**
 * Apply the per-kind sanitizer to a raw array, dropping rejected entries
 * and capping at ENTRIES_PER_BIBLE_MAX. Used by the pipeline series-state
 * loader and (eventually) by the writers-room file loaders so both sides
 * agree on what an on-disk bible looks like.
 */
export function sanitizeBibleList(rawList, kind, opts = {}) {
  const sanitizer = SANITIZERS[kind];
  if (!sanitizer) return [];
  return sanitizeListWith(
    rawList,
    (raw) => sanitizer(raw, opts),
    BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX,
  );
}

export const SANITIZERS = Object.freeze({
  character: sanitizeCharacter,
  place: sanitizePlace,
  object: sanitizeObject,
});

// ---------------------------------------------------------------------------
// Reveal-gated canon / spoiler scoping (#2178)
// ---------------------------------------------------------------------------
//
// Canon context is injected into every issue's drafting prompt, so a character
// secret or late-story fact could leak into the prose long before it's due.
// A canon entry can carry a reveal gate:
//   - `revealIssue` (int)  — the entry's fact is hidden from any issue numbered
//     BEFORE this. At/after it, the entry is fully visible.
//   - `spoiler: true`      — a hard gate with no specific issue: excluded from
//     ALL drafting context (autonovel's "MYSTERY.md is not for drafting").
//   - `surfaceDescriptor`  — the pre-reveal stand-in. When present on a gated
//     entry, the entry is KEPT in context but reduced to a spoiler-free surface
//     view (identity + surfaceDescriptor only). When absent, the gated entry is
//     dropped from context entirely.
//
// Absent gate fields = always visible — every pre-#2178 entry round-trips
// unchanged. The JUDGE (#2167) and editorial checks receive the FULL canon:
// this filter is ONLY for the writer-facing drafting/revision context.

// The field a surface view replaces with `surfaceDescriptor` is the kind's
// SHORT primary descriptor — sourced from canonPrompt's SHORT_SPEC via
// `shortCanonPrimaryField` so there's no parallel per-kind map to drift.

// True when an entry carries ANY reveal gate (a hard `spoiler` flag or a valid
// numeric `revealIssue`) — the shared predicate behind `canonHasRevealGated`,
// `revealGatedCanonRows`, and the client badge. Issue-agnostic: use
// `isCanonEntryGatedForIssue` when you need "gated FOR this issue".
export function isEntryRevealGated(entry) {
  return !!entry && (entry.spoiler === true || ensureRevealIssue(entry.revealIssue) != null);
}

/**
 * True when a canon entry is reveal-gated for the given issue number:
 * a hard `spoiler` flag, OR a `revealIssue` the issue hasn't reached yet.
 * A non-finite/absent `issueNumber` is treated as "unknown position" and only
 * the hard `spoiler` flag gates (a numeric reveal gate can't be evaluated
 * without knowing which issue we're drafting).
 */
export function isCanonEntryGatedForIssue(entry, issueNumber) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.spoiler === true) return true;
  const reveal = ensureRevealIssue(entry.revealIssue);
  if (reveal == null) return false;
  const n = typeof issueNumber === 'number' ? issueNumber : Number(issueNumber);
  if (!Number.isFinite(n)) return false;
  return n < reveal;
}

/**
 * Reduce a gated entry to its spoiler-free surface view: identity fields plus
 * the `surfaceDescriptor` substituted into the kind's primary descriptor
 * field. Every other narrative/prose field is dropped so no spoiler-bearing
 * text (background, significance, motivations, …) leaks through. Returns null
 * when the entry has no `surfaceDescriptor` — the caller drops it from context.
 */
function surfaceCanonEntry(kind, entry) {
  const surface = trimTo(entry?.surfaceDescriptor, BIBLE_LIMITS.SURFACE_DESCRIPTOR_MAX);
  if (!surface) return null;
  const descField = shortCanonPrimaryField(kind);
  const out = {
    id: entry.id,
    name: entry.name || '',
    aliases: Array.isArray(entry.aliases) ? entry.aliases : [],
    // Preserve the identity/continuity keys a matcher or roster needs, but
    // nothing that carries the secret.
    ...(kind === 'character' && entry.role ? { role: entry.role } : {}),
    ...(kind === 'place' && entry.slugline ? { slugline: entry.slugline } : {}),
    // Flag so any downstream renderer / debugging can tell this is a masked view.
    surfaced: true,
  };
  if (descField) out[descField] = surface;
  return out;
}

/**
 * Filter one kind's canon list for a drafting/revision prompt at `issueNumber`.
 * Ungated entries pass through untouched; gated entries with a
 * `surfaceDescriptor` are reduced to their surface view; gated entries without
 * one are dropped. Pure — returns a new array, never mutates the input.
 */
export function filterCanonListForIssue(list, kind, issueNumber) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    if (!isCanonEntryGatedForIssue(entry, issueNumber)) {
      out.push(entry);
      continue;
    }
    const surfaced = surfaceCanonEntry(kind, entry);
    if (surfaced) out.push(surfaced);
    // else: no surface stand-in → hidden from drafting context entirely.
  }
  return out;
}

/**
 * Filter a whole `{ characters, places, objects }` canon bundle for a drafting
 * prompt at `issueNumber`. Returns a NEW bundle with each list reveal-filtered;
 * a nullish canon returns empty lists. Used by `buildStageContext` and the
 * revision-loop cast builder — NOT by the editorial checks (they get full canon).
 */
export function filterCanonForIssue(canon, issueNumber) {
  return {
    characters: filterCanonListForIssue(canon?.characters, 'character', issueNumber),
    places: filterCanonListForIssue(canon?.places, 'place', issueNumber),
    objects: filterCanonListForIssue(canon?.objects, 'object', issueNumber),
  };
}

/**
 * True when ANY entry across a `{ characters, places, objects }` canon bundle
 * carries a reveal gate (a `revealIssue` or a `spoiler` flag). The
 * `continuity.premature-reveal` editorial check gates on this so it never fires
 * on a series that authored no reveal-gated canon.
 */
export function canonHasRevealGated(canon) {
  for (const key of BIBLE_KEYS) {
    const list = canon?.[key];
    if (Array.isArray(list) && list.some(isEntryRevealGated)) return true;
  }
  return false;
}

// The spoiler-bearing narrative fields per kind whose content the
// premature-reveal prompt names as "the gated fact" (what a leak looks like).
// Keyed by BIBLE_KIND so a future kind added to the enum surfaces here.
const SECRET_FIELDS_BY_KIND = Object.freeze({
  [BIBLE_KIND.CHARACTER]: ['physicalDescription', 'personality', 'background', 'motivations', 'specialTraits'],
  [BIBLE_KIND.PLACE]: ['description', 'recurringDetails'],
  [BIBLE_KIND.OBJECT]: ['description', 'significance'],
});

/**
 * Enumerate every reveal-gated canon entry across a bundle as a compact row
 * `{ kind, name, revealIssue, spoiler, surfaceDescriptor, fact }` for the
 * `continuity.premature-reveal` prompt. `fact` is the spoiler content the prose
 * must NOT reveal early — the kind's primary descriptor plus the deeper
 * narrative field so the model knows what "leaked" looks like. Pure.
 */
export function revealGatedCanonRows(canon) {
  const rows = [];
  // Iterate kinds via BIBLE_KIND → BIBLE_FIELD (kind → plural key) so the
  // kind↔key mapping stays derived from the module's single source of truth.
  for (const kind of BIBLE_KINDS) {
    const list = canon?.[BIBLE_FIELD[kind]];
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      if (!isEntryRevealGated(e)) continue;
      const fact = SECRET_FIELDS_BY_KIND[kind]
        .map((f) => trimTo(e[f], 600))
        .filter(Boolean)
        .join(' — ');
      rows.push({
        kind,
        name: trimTo(e.name, BIBLE_LIMITS.NAME_MAX) || '(unnamed)',
        revealIssue: ensureRevealIssue(e.revealIssue),
        spoiler: e.spoiler === true,
        surfaceDescriptor: trimTo(e.surfaceDescriptor, BIBLE_LIMITS.SURFACE_DESCRIPTOR_MAX) || null,
        fact,
      });
    }
  }
  return rows;
}

// Per-kind merge config:
//   userEditable — fields filled only when blank on the existing entry
//   keyFields — which fields contribute to the dedup lookup map, paired
//     with the normalizer to use for each (sluglines need em-dash/hyphen
//     collapsing; names just need lowercase+trim)
// Blank key fields are also backfilled from incoming and trigger re-index
// so a later entry in the same batch resolves to the canonical record.
const MERGE_CONFIG = Object.freeze({
  character: {
    userEditable: [
      'role', 'physicalDescription', 'personality', 'background', 'wardrobes',
      // Extended character fields — fill only when blank on the existing entry
      // (LLM extractor's "no-clobber" contract). The reference-sheet
      // operational fields (`referenceSheetImageRef`, `primaryImageRef`,
      // `imageRefs`) intentionally aren't here — those are owned by the
      // render flow, not the prose extractor.
      'pronouns', 'age', 'coreTheme', 'speechAccent', 'speechPattern', 'visualNotes',
      'silhouetteNotes', 'postureNotes', 'specialTraits', 'visualIdentity',
      'motivations', 'likes', 'dislikes', 'mannerisms', 'relationships', 'skills',
      'stats', 'colorPalette', 'props', 'expressions', 'handGestures',
    ],
    keyFields: [
      { field: 'name', normalize: normalizeBibleName },
      { field: 'aliases', normalize: normalizeBibleName },
    ],
  },
  place: {
    userEditable: ['description', 'palette', 'era', 'weather', 'intExt', 'timeOfDay', 'recurringDetails'],
    keyFields: [
      { field: 'slugline', normalize: normalizeSlugline },
      { field: 'name', normalize: normalizeSlugline },
    ],
  },
  object: {
    userEditable: ['description', 'significance'],
    keyFields: [
      { field: 'name', normalize: normalizeBibleName },
      { field: 'aliases', normalize: normalizeBibleName },
    ],
  },
});

function indexEntry(map, entry, keyFields) {
  for (const { field, normalize } of keyFields) {
    const val = entry[field];
    if (Array.isArray(val)) {
      for (const v of val) {
        const k = normalize(v);
        if (k) map.set(k, entry);
      }
    } else {
      const k = normalize(val);
      if (k) map.set(k, entry);
    }
  }
}

function lookupExisting(map, incoming, keyFields) {
  for (const { field, normalize } of keyFields) {
    const val = incoming[field];
    if (!val) continue;
    if (Array.isArray(val)) {
      for (const v of val) {
        const found = map.get(normalize(v));
        if (found) return found;
      }
    } else {
      const found = map.get(normalize(val));
      if (found) return found;
    }
  }
  return null;
}

// Sort key per kind. Places can legitimately have an empty `name` while
// `slugline` is the primary identifier (scene-matcher keys on it), so a
// pure name-sort drifts all slugline-only entries to the top of the list
// AND diverges from `writersRoom/places.js#listPlaces` which uses
// `slugline || name`. Characters / objects always have a name; key on it.
export const sortKey = (kind) => (entry) => {
  if (kind === BIBLE_KIND.PLACE) return (entry.slugline || entry.name || '').toLowerCase();
  return (entry.name || '').toLowerCase();
};

/**
 * Merge AI-extracted entries into a bible array. Mutates and returns
 * `existing`, sorted by the kind-specific key (`slugline || name` for
 * places, `name` for characters/objects — matches the per-kind list
 * helpers so callers don't observe an ordering flip after a merge).
 * Per-kind rules in `MERGE_CONFIG`:
 *   - match by case-insensitive name/alias/slugline
 *   - user-editable fields fill only when blank on the existing entry
 *   - prose-derived fields (firstAppearance/evidence/missingFromProse)
 *     refresh verbatim including explicit nulls
 *   - blank key fields backfill from incoming + re-index
 *
 * Lock semantics: when an existing matched entry has `locked === true`,
 * field backfills + prose-field rewrites are skipped — only `evidence[]`
 * appends (deduped) so the crossover trail still accumulates. `autoLock`
 * stamps new inserts as locked + carries `sourceSeriesId` so a series-driven
 * extraction cannot be silently rewritten by a later AI pass.
 *
 * Default source stays 'ai' (legacy) so writers-room badge UI is unaffected;
 * universe-canon callers pass `BIBLE_SOURCE.*` explicitly.
 */
export function mergeExtractedBible(existing, incoming, kind, {
  idPrefix = DEFAULT_ID_PREFIX[kind],
  source = 'ai',
  autoLock = false,
  sourceSeriesId = null,
} = {}) {
  if (!Array.isArray(existing)) existing = [];
  const keyOf = sortKey(kind);
  if (!Array.isArray(incoming)) {
    return [...existing].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  }
  const cfg = MERGE_CONFIG[kind];
  if (!cfg) throw new Error(`mergeExtractedBible: unknown kind "${kind}"`);
  const sanitizer = SANITIZERS[kind];
  const map = new Map();
  for (const e of existing) indexEntry(map, e, cfg.keyFields);

  const appendEvidence = (current, additions) => {
    const out = Array.isArray(current) ? [...current] : [];
    const seen = new Set(out.map(normalizeBibleName));
    const trimmed = cleanStringArray(additions, BIBLE_LIMITS.EVIDENCE_ITEM_MAX, BIBLE_LIMITS.EVIDENCE_PER_ENTRY_MAX);
    for (const item of trimmed) {
      const key = normalizeBibleName(item);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
      if (out.length >= BIBLE_LIMITS.EVIDENCE_PER_ENTRY_MAX) break;
    }
    return out;
  };

  for (const rawIncoming of incoming) {
    if (!rawIncoming || typeof rawIncoming !== 'object') continue;
    // Sanitize the incoming entry through the same shape the existing
    // entries went through. Drops malformed rows and gives downstream code
    // a consistent shape to merge into.
    const sane = sanitizer(rawIncoming, { idPrefix, preserveTimestamps: false });
    if (!sane) continue;
    const found = lookupExisting(map, sane, cfg.keyFields);
    if (found) {
      if (found.locked === true) {
        if ('evidence' in rawIncoming) {
          found.evidence = appendEvidence(found.evidence, sane.evidence);
        }
        found.updatedAt = nowIso();
        continue;
      }
      for (const field of cfg.userEditable) {
        if (isBlank(found[field]) && !isBlank(sane[field])) {
          found[field] = sane[field];
        }
      }
      // Backfill any blank key field (slugline, name, aliases) and re-index
      // so a later entry in the same batch keyed by the just-filled value
      // resolves to this canonical record instead of inserting a duplicate.
      let reindex = false;
      for (const { field } of cfg.keyFields) {
        if (isBlank(found[field]) && !isBlank(sane[field])) {
          found[field] = sane[field];
          reindex = true;
        }
      }
      if (reindex) indexEntry(map, found, cfg.keyFields);
      // Prose-derived fields refresh verbatim — but only when the extractor
      // actually emitted them. A partial LLM response that omits these keys
      // entirely would otherwise clear prior data, since the sanitizer
      // normalizes missing keys to null/[]. Explicit null/[] in rawIncoming
      // still wins (the "refresh verbatim including explicit nulls" rule).
      if ('firstAppearance' in rawIncoming) found.firstAppearance = sane.firstAppearance;
      if ('evidence' in rawIncoming) found.evidence = sane.evidence;
      if ('missingFromProse' in rawIncoming) found.missingFromProse = sane.missingFromProse;
      found.updatedAt = nowIso();
    } else {
      // Refuse new inserts past the per-bible cap so a runaway extraction
      // can't grow `existing` past what `sanitizeBibleList` would re-load.
      // Without this, the merged entries would silently truncate on next
      // read.
      if (existing.length >= BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX) continue;
      const inserted = { ...sane, source };
      if (sourceSeriesId) inserted.sourceSeriesId = sourceSeriesId;
      if (autoLock) inserted.locked = true;
      existing.push(inserted);
      indexEntry(map, inserted, cfg.keyFields);
    }
  }

  return existing.sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
}


// createBibleStore — the per-work CRUD + merge storage factory — moved to
// server/services/bibleStore.js (issue #1154) so this lib stays a pure
// catalog of sanitizers/transformers with no data/ file I/O. Re-exported
// here so existing `import { createBibleStore } from '.../lib/storyBible.js'`
// call sites keep working.
export { createBibleStore } from '../services/bibleStore.js';
