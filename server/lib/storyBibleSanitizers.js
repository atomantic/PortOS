/** Normalize the canonical character, place, and object shapes used by Writers Room and Pipeline. */

import { ATTACHMENT_ROLES } from './storyBibleRoles.js';
import { BIBLE_KIND } from './universeCanon.js';
import { v4 } from './uuid.js';
import { LEGACY_SHEET_VARIANT_ID } from './sheetPointers.js';
import { isPlainObject } from './objects.js';
import { isStr, trimTo } from './textUtils.js';
import { BIBLE_LIMITS } from './bibleLimits.js';
import {
  CHARACTER_ARC_TYPES,
  CHARACTER_SLIDER_AXES,
  PSYCHOLOGY_ASSESSMENTS,
  PSYCHOLOGY_DRIVE_AXES,
  RELATIONSHIP_LINK_TYPES,
  RELATIONSHIP_OPPOSITION_AXES,
} from './characterFramework.js';
import { sanitizeCharacterEvolution } from './characterEvolution.js';
import { cleanStringArray, sanitizeListWith } from './storyBibleFields.js';
import { sanitizeIdentityPack } from './storyBibleIdentityPack.js';
import { ensureRevealIssue } from './storyBibleReveal.js';

// Portable production posture only. Performer identity, contracts, source
// recordings, provider ids, and local artifact paths must never enter a
// Universe record or its federated payload.
export const VOICE_CANON_SOURCE_POLICIES = Object.freeze([
  'designed', 'consented-performance', 'licensed',
]);
const VOICE_CANON_SOURCE_POLICY_SET = new Set(VOICE_CANON_SOURCE_POLICIES);

// `SERIES_EXTRACT` is the default for new bible-extracted entries; `UNIVERSE_EXPAND` is stamped on
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

const RELATIONSHIP_LINK_TYPE_SET = new Set(RELATIONSHIP_LINK_TYPES);
const RELATIONSHIP_OPPOSITION_AXIS_SET = new Set(RELATIONSHIP_OPPOSITION_AXES);

const ATTACHMENT_ROLE_SET = new Set(ATTACHMENT_ROLES);

// Enums for the location-classification fields on Place canon entries.
// Mirrors AnyFilm's INT/EXT + time-of-day taxonomy so generated panels and
// scene starts inherit lighting/composition cues for free.
export const PLACE_INT_EXT = Object.freeze(['INT', 'EXT']);
export const PLACE_TIME_OF_DAY = Object.freeze(['dawn', 'day', 'dusk', 'night']);
const PLACE_INT_EXT_SET = new Set(PLACE_INT_EXT);
const PLACE_TIME_OF_DAY_SET = new Set(PLACE_TIME_OF_DAY);

const CHARACTER_ARC_TYPE_SET = new Set(CHARACTER_ARC_TYPES);

const PSYCHOLOGY_ASSESSMENT_SET = new Set(PSYCHOLOGY_ASSESSMENTS);

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

// Fields the bible-extraction prompt cares about. Routed both into the
// `existing<X>Json` prompt variable (bibleExtractor) and into the script
// stage's bibles context (evaluator). Excludes ids/timestamps/source/notes.
export const PROMPT_FIELDS = Object.freeze({
  [BIBLE_KIND.CHARACTER]: ['name', 'aliases', 'role', 'pronouns', 'age', 'coreTheme', 'speechAccent', 'speechPattern', 'visualNotes', 'physicalDescription', 'personality', 'background', 'silhouetteNotes', 'postureNotes', 'specialTraits', 'visualIdentity', 'motivations', 'ghost', 'wound', 'lie', 'want', 'need', 'psychology', 'arcType', 'sliders', 'secrets', 'likes', 'dislikes', 'mannerisms', 'relationships', 'skills', 'stats', 'colorPalette', 'props', 'expressions', 'handGestures', 'voiceId', 'wardrobes', 'prompt', 'tags'],
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
export const DEFAULT_ID_PREFIX = Object.freeze({
  character: 'chr-',
  place: LEGACY_PLACE_ID_PREFIX,
  object: 'obj-',
});

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
// `SERVER_OWNED_CHARACTER_FIELDS` is a strict subset: pointers and request
// identities that the *server* writes via render mutators (never the
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
  'referenceSheetImageRef', 'referenceSheets', 'referenceSheetRequests',
]);

export const SERVER_OWNED_CHARACTER_FIELDS = Object.freeze([
  'referenceSheetImageRef', 'referenceSheets', 'referenceSheetRequests',
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
  return `${idPrefix}${v4()}`;
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
// The universe read/write boundary prunes pointers to deleted files.
function deriveReferenceSheetImageRef(raw) {
  if (!isStr(raw) || !raw.trim()) return null;
  const trimmed = raw.trim().slice(0, BIBLE_LIMITS.IMAGE_REF_MAX);
  if (trimmed === '.' || trimmed === '..') return null;
  if (trimmed.includes('/') || trimmed.includes('\\')) return null;
  if (trimmed.startsWith('.')) return null;
  return trimmed;
}

function sanitizeVoiceCanon(raw) {
  if (!isPlainObject(raw)) return null;
  const version = Number.isInteger(raw.version) && raw.version > 0
    ? Math.min(raw.version, BIBLE_LIMITS.VOICE_CANON_VERSION_MAX)
    : 1;
  const pronunciations = sanitizeListWith(raw.pronunciations, (item) => {
    if (!isPlainObject(item)) return null;
    const term = trimTo(item.term, BIBLE_LIMITS.VOICE_CANON_PRONUNCIATION_TERM_MAX);
    const pronunciation = trimTo(item.pronunciation, BIBLE_LIMITS.VOICE_CANON_PRONUNCIATION_VALUE_MAX);
    return term && pronunciation ? { term, pronunciation } : null;
  }, BIBLE_LIMITS.VOICE_CANON_PRONUNCIATIONS_MAX);
  const sourcePolicy = trimTo(raw.sourcePolicy, 64);
  return {
    version,
    description: trimTo(raw.description, BIBLE_LIMITS.VOICE_CANON_DESCRIPTION_MAX),
    defaultDelivery: trimTo(raw.defaultDelivery, BIBLE_LIMITS.VOICE_CANON_DELIVERY_MAX),
    emotionalRange: cleanStringArray(raw.emotionalRange, BIBLE_LIMITS.VOICE_CANON_RANGE_ITEM_MAX, BIBLE_LIMITS.VOICE_CANON_RANGE_MAX),
    avoid: cleanStringArray(raw.avoid, BIBLE_LIMITS.VOICE_CANON_AVOID_ITEM_MAX, BIBLE_LIMITS.VOICE_CANON_AVOID_MAX),
    pronunciations,
    sourcePolicy: VOICE_CANON_SOURCE_POLICY_SET.has(sourcePolicy) ? sourcePolicy : null,
    approved: raw.approved === true,
  };
}

/**
 * Optional structured psychology profile (#6414). Returns null when nothing is
 * authored so a pre-#6414 character round-trips with no `psychology` key at
 * all — which is also how an explicit CLEAR works: a PATCH carrying
 * `psychology: null` (or an all-blank object) drops the field rather than
 * persisting an empty husk that would read as 'assessed'.
 *
 * `drives` is always materialized with all three axes so a partial fill has a
 * stable slot to write into; the whole object still collapses to null when
 * every leaf is blank.
 */
function sanitizeCharacterPsychology(raw) {
  if (!isPlainObject(raw)) return null;
  const rawDrives = isPlainObject(raw.drives) ? raw.drives : {};
  const drives = {};
  let anyDrive = false;
  for (const axis of PSYCHOLOGY_DRIVE_AXES) {
    const row = isPlainObject(rawDrives[axis]) ? rawDrives[axis] : {};
    const desire = trimTo(row.desire, BIBLE_LIMITS.PSYCHOLOGY_DRIVE_FIELD_MAX);
    const fear = trimTo(row.fear, BIBLE_LIMITS.PSYCHOLOGY_DRIVE_FIELD_MAX);
    if (desire || fear) anyDrive = true;
    drives[axis] = { desire, fear };
  }
  const out = {
    theoryOfControl: trimTo(raw.theoryOfControl, BIBLE_LIMITS.THEORY_OF_CONTROL_MAX),
    strategy: trimTo(raw.strategy, BIBLE_LIMITS.PSYCHOLOGY_STRATEGY_MAX),
    protectiveBenefit: trimTo(raw.protectiveBenefit, BIBLE_LIMITS.PSYCHOLOGY_PROTECTION_MAX),
    presentCost: trimTo(raw.presentCost, BIBLE_LIMITS.PSYCHOLOGY_COST_MAX),
    // Anticipated, not realized: what would test the theory and what it could
    // become. The delivered progression belongs to an authored arc.
    testingPressure: trimTo(raw.testingPressure, BIBLE_LIMITS.PSYCHOLOGY_PRESSURE_MAX),
    candidateChange: trimTo(raw.candidateChange, BIBLE_LIMITS.PSYCHOLOGY_CHANGE_MAX),
    assessment: trimEnum(raw.assessment, PSYCHOLOGY_ASSESSMENT_SET),
    assessmentNote: trimTo(raw.assessmentNote, BIBLE_LIMITS.PSYCHOLOGY_NOTE_MAX),
    drives,
  };
  const anyText = out.theoryOfControl || out.strategy || out.protectiveBenefit
    || out.presentCost || out.testingPressure || out.candidateChange
    || out.assessmentNote;
  return anyText || anyDrive || out.assessment ? out : null;
}

// Variant-id rules for `referenceSheets` map keys: short kebab-case identifier,
// no path separators, no dot-prefix. Cap of 48 chars matches the route schema.
// The legacy id is rejected because it must stay in the legacy field, not in
// the map (otherwise sanitize / prune / purge would have to pick which slot wins).
const VARIANT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
function isValidVariantId(id) {
  return typeof id === 'string' && VARIANT_ID_RE.test(id) && id !== LEGACY_SHEET_VARIANT_ID;
}

/**
 * Sanitize the `referenceSheets` map. Drops invalid variant ids, basename-
 * validates every filename, returns a fresh object with only valid
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

// Normalize a Three-Sliders value (proactivity/likability/competence) to an
// integer in [SLIDER_MIN, SLIDER_MAX] or null (unset). Accepts a finite number
// or numeric string (LLM/JSON both occur); out-of-range / non-integer collapses
// to null so an absent or hallucinated value doesn't masquerade as a real rating
// (CWQE Phase 10, #2175). Null = the slider was never authored — distinct from a
// deliberate low rating.
function ensureSlider(raw) {
  const n = typeof raw === 'number' ? raw : (isStr(raw) && raw.trim() !== '' ? Number(raw) : NaN);
  if (!Number.isInteger(n) || n < BIBLE_LIMITS.SLIDER_MIN || n > BIBLE_LIMITS.SLIDER_MAX) return null;
  return n;
}

// Build the Three-Sliders object from a raw payload. Returns an object with the
// three keys always present (each null when unset) so the shape is stable and a
// round-trip never strips it — mirrors the reveal-gating always-present pattern.
function sanitizeCharacterSliders(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return Object.fromEntries(CHARACTER_SLIDER_AXES.map((axis) => [axis, ensureSlider(src[axis])]));
}

// Alternate form of a canon entry: another age, era or look/style of the same
// subject. Ids stay short because a form's sheet role is
// `sheet:<variant>@<formId>` under the 64-char media role cap.
export const FORM_ID_PATTERN = /^[A-Za-z0-9_-]{1,24}$/;
function sanitizeForm(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const label = trimTo(raw.label, BIBLE_LIMITS.FORM_LABEL_MAX);
  if (!label) return null;
  const height = trimTo(raw.height, BIBLE_LIMITS.FORM_HEIGHT_MAX);
  return {
    id: isStr(raw.id) && FORM_ID_PATTERN.test(raw.id) ? raw.id : `form-${v4().slice(0, 8)}`,
    label,
    age: trimTo(raw.age, BIBLE_LIMITS.FORM_AGE_MAX),
    description: trimTo(raw.description, BIBLE_LIMITS.FORM_DESCRIPTION_MAX),
    // A character's height at that age: the scale cue that keeps a child child-sized in a set.
    ...(height ? { height } : {}),
  };
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
  // Absent stays absent so entries without alternate forms keep their shape.
  if (Array.isArray(raw.forms)) {
    const seen = new Set();
    out.forms = sanitizeListWith(raw.forms, sanitizeForm, BIBLE_LIMITS.FORMS_PER_ENTRY_MAX)
      .filter((form) => !seen.has(form.id) && seen.add(form.id));
  }
  return out;
}

/**
 * PURE: is this canon entry safe for a given series to bulk-unlock?
 *
 * Universe canon is shared by every series linked to that universe, so a
 * series-scoped bulk operation (the autopilot's unlock-for-run pre-pass, and
 * any future "reset what this series introduced" affordance) must not remove
 * protection from a record another series depends on. Lives here, next to the
 * sanitizer that owns and caps `sourceSeriesId`, so the rule has one
 * definition.
 *
 * **`sourceSeriesId` is PROVENANCE, not exclusivity** — it records which series
 * first minted the entry, and nothing stops a sibling series from referencing
 * that same character/place/object (`getSeriesCanon` hands every linked series
 * the whole universe canon). So "series A minted it" does NOT mean "only series
 * A uses it", and treating it that way would let A's autopilot rewrite a
 * character B's issues are built on. Proving actual exclusivity would need the
 * prose cross-reference in `canonUsage.js` — O(series × issues × matchers) and
 * still only a text-match heuristic, not a sound proof.
 *
 * So the rule is deliberately conservative, and `soleSeries` is REQUIRED:
 *
 *   - not `soleSeries` (a sibling series shares this universe) → out of scope,
 *     always. Nothing is unlocked, whoever minted it.
 *   - `soleSeries` + `sourceSeriesId` naming a DIFFERENT series → still out of
 *     scope. A stale stamp pointing at an unlinked/deleted series is not a
 *     licence to unfreeze.
 *   - `soleSeries` + minted by this series, or unstamped (universe-authored /
 *     legacy) → in scope. There is no other series left to damage.
 *
 * Note this only governs clearing the `locked` BIT. An already-unlocked canon
 * entry stays editable by any series exactly as before — this never widens
 * access, it only refuses to narrow protection.
 */
export function isSeriesScopedCanonEntry(entry, { seriesId, soleSeries = false } = {}) {
  if (!entry || typeof entry !== 'object') return false;
  if (soleSeries !== true) return false;
  const owner = typeof entry.sourceSeriesId === 'string' ? entry.sourceSeriesId : '';
  return !owner || owner === seriesId;
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
  const voiceCanon = sanitizeVoiceCanon(raw.voiceCanon);
  const identityPack = sanitizeIdentityPack(raw.identityPack, imageRefs);
  const psychology = sanitizeCharacterPsychology(raw.psychology);
  const evolution = sanitizeCharacterEvolution(raw.evolution);
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
    // Character framework (CWQE Phase 10, #2175). Ghost → Wound → Lie → Want →
    // Need chain + declared arc type + Three Sliders + secrets. All optional —
    // a blank string / null / empty array keeps the legacy shape so every
    // pre-#2175 character round-trips unchanged (absent vs empty rule). The
    // arc.*/character.consistency editorial checks read the authored Lie/Want/
    // Need/arc-type when present so they compare plan-vs-delivery instead of
    // inferring both.
    ghost: trimTo(raw.ghost, BIBLE_LIMITS.GHOST_MAX),
    wound: trimTo(raw.wound, BIBLE_LIMITS.WOUND_MAX),
    lie: trimTo(raw.lie, BIBLE_LIMITS.LIE_MAX),
    want: trimTo(raw.want, BIBLE_LIMITS.WANT_MAX),
    need: trimTo(raw.need, BIBLE_LIMITS.NEED_MAX),
    // Optional structured psychology (#6414). Layered on the chain above, not
    // a replacement for it: Ghost/Wound remain the origin history and
    // Want/Need the conscious pursuit + internal alternative. Absent (no key)
    // on every record that has not been assessed, so legacy characters stay
    // valid and visibly unfilled rather than silently inheriting a profile.
    ...(psychology ? { psychology } : {}),
    // Optional five-stage evolution lens (#6440), STORY-SCOPED (#6445). What
    // ONE story does to the baseline above: the belief it puts under test, the
    // pressure, the choice, and what that choice causes. Absent (no key) until
    // a writer authors it, so every pre-lens character round-trips unchanged.
    // Reached today by the per-work Writers Room cast bible, whose records live
    // under data/writers-room/works/<workId>/ and are therefore already scoped
    // to one manuscript — the universe cast has no editor for it, which is what
    // keeps a story's realized change from overwriting world-level identity.
    ...(evolution ? { evolution } : {}),
    // Declared arc type — null (unset) unless it's one of the three known
    // values, so a legacy record with no arc type stays absent.
    arcType: trimEnum(raw.arcType, CHARACTER_ARC_TYPE_SET),
    // Three Sliders — always-present object, each axis null when unset.
    sliders: sanitizeCharacterSliders(raw.sliders),
    // Secrets the character keeps (≥2 encouraged). Plain string list; empty
    // array is the legacy shape.
    secrets: cleanStringArray(raw.secrets, BIBLE_LIMITS.SECRET_MAX, BIBLE_LIMITS.SECRETS_PER_CHARACTER_MAX),
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
    // Optional portable production direction. Its allowlisted sanitizer keeps
    // local profile ids, recordings, provider ids, and model revisions out.
    ...(voiceCanon ? { voiceCanon } : {}),
    imageRefs,
    // Pinned visual anchor (A3). One of imageRefs marked canonical so
    // downstream renders + the UI know which to lean on.
    primaryImageRef: derivePrimaryImageRef(raw.primaryImageRef, imageRefs),
    // Curated role assignments over existing imageRefs[]. Candidates remain
    // unapproved until the editor explicitly approves them.
    ...(identityPack ? { identityPack } : {}),
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
    referenceSheetRequests: Object.fromEntries(Object.entries(isPlainObject(raw.referenceSheetRequests) ? raw.referenceSheetRequests : {})
      .filter(([variant, token]) => (variant === LEGACY_SHEET_VARIANT_ID || isValidVariantId(variant))
        && typeof token === 'string' && /^[0-9a-f-]{36}$/.test(token))),
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

// Absent stays absent so entries without a size keep their shape.
function realWorldSize(raw) {
  const size = trimTo(raw.size, BIBLE_LIMITS.SIZE_MAX);
  return size ? { size } : {};
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
    ...realWorldSize(raw),
    notes: trimTo(raw.notes, BIBLE_LIMITS.NOTES_MAX),
    imageRefs,
    // A4: clean-plate / canonical location render pinned for downstream.
    primaryImageRef: derivePrimaryImageRef(raw.primaryImageRef, imageRefs),
    firstAppearance: ensureFirstAppearance(raw.firstAppearance),
    evidence: cleanStringArray(raw.evidence, BIBLE_LIMITS.EVIDENCE_ITEM_MAX, BIBLE_LIMITS.EVIDENCE_PER_ENTRY_MAX),
    missingFromProse: cleanStringArray(raw.missingFromProse, BIBLE_LIMITS.EVIDENCE_ITEM_MAX, BIBLE_LIMITS.EVIDENCE_PER_ENTRY_MAX),
    // Greybox layout, Photoreal look and world map:
    // validated by their schemas where they are written, passed through here so a
    // later profile save or canon edit does not drop them.
    ...(raw.greybox && typeof raw.greybox === 'object' && !Array.isArray(raw.greybox) ? { greybox: raw.greybox } : {}),
    ...(raw.photoreal && typeof raw.photoreal === 'object' && !Array.isArray(raw.photoreal) ? { photoreal: raw.photoreal } : {}),
    ...(raw.world && typeof raw.world === 'object' && !Array.isArray(raw.world) ? { world: raw.world } : {}),
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
    ...realWorldSize(raw),
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

/**
 * Run ONE proposed field value through its kind's sanitizer and return the
 * cleaned value (or `undefined` when the kind is unknown).
 *
 * Every LLM-expand merge needs this before it records a field as filled: the
 * sanitizers drop rows missing required keys (a stat without `label`, a palette
 * swatch without `name`) and fold an unrecognized enum to null, so accepting a
 * raw proposal reports a field as updated that the next persist silently
 * discards.
 *
 * The stub carries `target`'s identity fields because the top-level sanitizers
 * REJECT a record without one — a character/object needs `name`, a place needs
 * `name` OR `slugline` — and a rejected stub would discard every proposal for a
 * slugline-only place. That rule is the reason this is one helper rather than
 * the same three-line stub written at each merge site.
 */
export function sanitizeBibleField(kind, target, field, value) {
  const sanitize = SANITIZERS[kind];
  if (!sanitize) return undefined;
  return sanitize(
    { name: target?.name, slugline: target?.slugline, [field]: value },
    { preserveTimestamps: false },
  )?.[field];
}
