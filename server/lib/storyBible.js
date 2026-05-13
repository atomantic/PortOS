/**
 * Canonical story-bible shapes (Character / Setting / Object) shared by the
 * Writers Room (per-work bibles) and the Pipeline (per-series bibles).
 *
 * Owns the shape + sanitization + merge-extracted-entries algorithm AND the
 * `createBibleStore(...)` factory the writers-room domain files build on for
 * their CRUD + file I/O. Route exposure stays with the caller.
 */

import { randomUUID } from 'crypto';
import { join } from 'path';
import { normalizeSlugline } from './scenePrompt.js';
import { PATHS, atomicWrite, ensureDir, readJSONFile } from './fileUtils.js';
import { ServerError } from './errorHandler.js';

// Re-export so callers (writers-room domain files) can import a single
// canonical normalizer when they need to match settings by slugline.
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
  EVIDENCE_ITEM_MAX: 500,
  EVIDENCE_PER_ENTRY_MAX: 20,
  // Settings
  SLUGLINE_MAX: 200,
  PALETTE_MAX: 200,
  ERA_MAX: 200,
  WEATHER_MAX: 200,
  RECURRING_DETAILS_MAX: 1000,
  SETTING_DESCRIPTION_MAX: 2000,
  // Objects
  OBJECT_DESCRIPTION_MAX: 2000,
  SIGNIFICANCE_MAX: 1000,
  // Per-bible cap (universal — protects against runaway extraction)
  ENTRIES_PER_BIBLE_MAX: 200,
});

const SOURCES = new Set(['user', 'ai', 'imported']);

export const BIBLE_KIND = Object.freeze({
  CHARACTER: 'character',
  SETTING: 'setting',
  OBJECT: 'object',
});

// Canonical pluralization: pipeline series.<field>, evaluator analysis kind,
// extractor LLM envelope key — all the same string, consolidated here.
export const BIBLE_FIELD = Object.freeze({
  [BIBLE_KIND.CHARACTER]: 'characters',
  [BIBLE_KIND.SETTING]: 'settings',
  [BIBLE_KIND.OBJECT]: 'objects',
});

// Fields the bible-extraction prompt cares about. Routed both into the
// `existing<X>Json` prompt variable (bibleExtractor) and into the script
// stage's bibles context (evaluator). Excludes ids/timestamps/source/notes.
export const PROMPT_FIELDS = Object.freeze({
  [BIBLE_KIND.CHARACTER]: ['name', 'aliases', 'role', 'physicalDescription', 'personality', 'background'],
  [BIBLE_KIND.SETTING]: ['name', 'slugline', 'description', 'palette', 'era', 'weather', 'recurringDetails'],
  [BIBLE_KIND.OBJECT]: ['name', 'aliases', 'description', 'significance'],
});

export function pickPromptFields(kind, entry) {
  const fields = PROMPT_FIELDS[kind];
  if (!fields || !entry) return {};
  const out = {};
  for (const f of fields) out[f] = entry[f];
  return out;
}

// Default id prefix per kind. Pipeline accepts these defaults; writers-room
// passes its own `wr-char-` / `wr-setting-` / `wr-object-` prefixes via the
// sanitizer options.
const DEFAULT_ID_PREFIX = Object.freeze({
  character: 'chr-',
  setting: 'set-',
  object: 'obj-',
});

// Tiny string helpers — exported so adjacent server modules (pipeline
// series.js, issues.js, etc.) stop redefining the same one-liners.
export const isStr = (v) => typeof v === 'string';
export const trimTo = (v, max) => (isStr(v) ? v.trim().slice(0, max) : '');
const cleanStringArray = (raw, itemMax, listMax) => {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const v of raw) {
    const s = trimTo(v, itemMax);
    if (s) out.push(s);
    if (out.length >= listMax) break;
  }
  return out;
};

export const isBlank = (v) => {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (isStr(v)) return v.trim() === '';
  return false;
};

export const normalizeBibleName = (name) => String(name || '').trim().toLowerCase();

const nowIso = () => new Date().toISOString();

function ensureId(raw, idPrefix) {
  if (isStr(raw) && raw) return raw;
  return `${idPrefix}${randomUUID()}`;
}

function ensureSource(raw) {
  return SOURCES.has(raw) ? raw : 'user';
}

function ensureFirstAppearance(raw) {
  return isStr(raw) && raw.trim() ? raw.trim().slice(0, 200) : null;
}

// Accepts the writers-room shape natively; legacy pipeline `description`
// is treated as `physicalDescription` when the latter is empty so old
// series.json migrates forward on first save. TODO(item-4): drop the
// `description` fallback once pipeline characters extract natively.
export function sanitizeCharacter(raw, { idPrefix = DEFAULT_ID_PREFIX.character, preserveTimestamps = true } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const name = trimTo(raw.name, BIBLE_LIMITS.NAME_MAX);
  if (!name) return null;
  const physicalDescription = trimTo(
    raw.physicalDescription || raw.description || '',
    BIBLE_LIMITS.PHYSICAL_DESCRIPTION_MAX,
  );
  const created = preserveTimestamps && isStr(raw.createdAt) ? raw.createdAt : nowIso();
  return {
    id: ensureId(raw.id, idPrefix),
    name,
    aliases: cleanStringArray(raw.aliases, BIBLE_LIMITS.ALIAS_MAX, BIBLE_LIMITS.ALIASES_PER_ENTRY_MAX),
    role: trimTo(raw.role, BIBLE_LIMITS.ROLE_MAX),
    physicalDescription,
    personality: trimTo(raw.personality, BIBLE_LIMITS.PERSONALITY_MAX),
    background: trimTo(raw.background, BIBLE_LIMITS.BACKGROUND_MAX),
    notes: trimTo(raw.notes, BIBLE_LIMITS.NOTES_MAX),
    imageRefs: cleanStringArray(raw.imageRefs, BIBLE_LIMITS.IMAGE_REF_MAX, BIBLE_LIMITS.IMAGE_REFS_PER_ENTRY_MAX),
    firstAppearance: ensureFirstAppearance(raw.firstAppearance),
    evidence: cleanStringArray(raw.evidence, BIBLE_LIMITS.EVIDENCE_ITEM_MAX, BIBLE_LIMITS.EVIDENCE_PER_ENTRY_MAX),
    missingFromProse: cleanStringArray(raw.missingFromProse, BIBLE_LIMITS.EVIDENCE_ITEM_MAX, BIBLE_LIMITS.EVIDENCE_PER_ENTRY_MAX),
    source: ensureSource(raw.source),
    createdAt: created,
    updatedAt: preserveTimestamps && isStr(raw.updatedAt) ? raw.updatedAt : nowIso(),
  };
}

export function sanitizeSetting(raw, { idPrefix = DEFAULT_ID_PREFIX.setting, preserveTimestamps = true } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const name = trimTo(raw.name, BIBLE_LIMITS.NAME_MAX);
  const slugline = trimTo(raw.slugline, BIBLE_LIMITS.SLUGLINE_MAX);
  // A setting needs at least one identifier (name OR slugline). Without
  // either there's nothing for a scene matcher to key on.
  if (!name && !slugline) return null;
  const created = preserveTimestamps && isStr(raw.createdAt) ? raw.createdAt : nowIso();
  return {
    id: ensureId(raw.id, idPrefix),
    name,
    slugline,
    description: trimTo(raw.description, BIBLE_LIMITS.SETTING_DESCRIPTION_MAX),
    palette: trimTo(raw.palette, BIBLE_LIMITS.PALETTE_MAX),
    era: trimTo(raw.era, BIBLE_LIMITS.ERA_MAX),
    weather: trimTo(raw.weather, BIBLE_LIMITS.WEATHER_MAX),
    recurringDetails: trimTo(raw.recurringDetails, BIBLE_LIMITS.RECURRING_DETAILS_MAX),
    notes: trimTo(raw.notes, BIBLE_LIMITS.NOTES_MAX),
    firstAppearance: ensureFirstAppearance(raw.firstAppearance),
    evidence: cleanStringArray(raw.evidence, BIBLE_LIMITS.EVIDENCE_ITEM_MAX, BIBLE_LIMITS.EVIDENCE_PER_ENTRY_MAX),
    missingFromProse: cleanStringArray(raw.missingFromProse, BIBLE_LIMITS.EVIDENCE_ITEM_MAX, BIBLE_LIMITS.EVIDENCE_PER_ENTRY_MAX),
    source: ensureSource(raw.source),
    createdAt: created,
    updatedAt: preserveTimestamps && isStr(raw.updatedAt) ? raw.updatedAt : nowIso(),
  };
}

export function sanitizeObject(raw, { idPrefix = DEFAULT_ID_PREFIX.object, preserveTimestamps = true } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const name = trimTo(raw.name, BIBLE_LIMITS.NAME_MAX);
  if (!name) return null;
  const created = preserveTimestamps && isStr(raw.createdAt) ? raw.createdAt : nowIso();
  return {
    id: ensureId(raw.id, idPrefix),
    name,
    aliases: cleanStringArray(raw.aliases, BIBLE_LIMITS.ALIAS_MAX, BIBLE_LIMITS.ALIASES_PER_ENTRY_MAX),
    description: trimTo(raw.description, BIBLE_LIMITS.OBJECT_DESCRIPTION_MAX),
    significance: trimTo(raw.significance, BIBLE_LIMITS.SIGNIFICANCE_MAX),
    notes: trimTo(raw.notes, BIBLE_LIMITS.NOTES_MAX),
    firstAppearance: ensureFirstAppearance(raw.firstAppearance),
    evidence: cleanStringArray(raw.evidence, BIBLE_LIMITS.EVIDENCE_ITEM_MAX, BIBLE_LIMITS.EVIDENCE_PER_ENTRY_MAX),
    missingFromProse: cleanStringArray(raw.missingFromProse, BIBLE_LIMITS.EVIDENCE_ITEM_MAX, BIBLE_LIMITS.EVIDENCE_PER_ENTRY_MAX),
    source: ensureSource(raw.source),
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
  if (!Array.isArray(rawList)) return [];
  const sanitizer = SANITIZERS[kind];
  if (!sanitizer) return [];
  const out = [];
  for (const raw of rawList) {
    const s = sanitizer(raw, opts);
    if (!s) continue;
    out.push(s);
    if (out.length >= BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX) break;
  }
  return out;
}

const SANITIZERS = Object.freeze({
  character: sanitizeCharacter,
  setting: sanitizeSetting,
  object: sanitizeObject,
});

// Per-kind merge config:
//   userEditable — fields filled only when blank on the existing entry
//   keyFields — which fields contribute to the dedup lookup map, paired
//     with the normalizer to use for each (sluglines need em-dash/hyphen
//     collapsing; names just need lowercase+trim)
// Blank key fields are also backfilled from incoming and trigger re-index
// so a later entry in the same batch resolves to the canonical record.
const MERGE_CONFIG = Object.freeze({
  character: {
    userEditable: ['role', 'physicalDescription', 'personality', 'background'],
    keyFields: [
      { field: 'name', normalize: normalizeBibleName },
      { field: 'aliases', normalize: normalizeBibleName },
    ],
  },
  setting: {
    userEditable: ['description', 'palette', 'era', 'weather', 'recurringDetails'],
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

// Sort key per kind. Settings can legitimately have an empty `name` while
// `slugline` is the primary identifier (scene-matcher keys on it), so a
// pure name-sort drifts all slugline-only entries to the top of the list
// AND diverges from `writersRoom/settings.js#listSettings` which uses
// `slugline || name`. Characters / objects always have a name; key on it.
const sortKey = (kind) => (entry) => {
  if (kind === BIBLE_KIND.SETTING) return (entry.slugline || entry.name || '').toLowerCase();
  return (entry.name || '').toLowerCase();
};

/**
 * Merge AI-extracted entries into a bible array. Mutates and returns
 * `existing`, sorted by the kind-specific key (`slugline || name` for
 * settings, `name` for characters/objects — matches the per-kind list
 * helpers so callers don't observe an ordering flip after a merge).
 * Per-kind rules in `MERGE_CONFIG`:
 *   - match by case-insensitive name/alias/slugline
 *   - user-editable fields fill only when blank on the existing entry
 *   - prose-derived fields (firstAppearance/evidence/missingFromProse)
 *     refresh verbatim including explicit nulls
 *   - blank key fields backfill from incoming + re-index
 */
export function mergeExtractedBible(existing, incoming, kind, { idPrefix = DEFAULT_ID_PREFIX[kind] } = {}) {
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

  for (const rawIncoming of incoming) {
    if (!rawIncoming || typeof rawIncoming !== 'object') continue;
    // Sanitize the incoming entry through the same shape the existing
    // entries went through. Drops malformed rows and gives downstream code
    // a consistent shape to merge into.
    const sane = sanitizer(rawIncoming, { idPrefix, preserveTimestamps: false });
    if (!sane) continue;
    const found = lookupExisting(map, sane, cfg.keyFields);
    if (found) {
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
      const inserted = { ...sane, source: 'ai' };
      existing.push(inserted);
      indexEntry(map, inserted, cfg.keyFields);
    }
  }

  return existing.sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
}

/**
 * createBibleStore — per-work CRUD + merge factory. Collapses the three
 * writers-room domain files (characters/settings/objects) onto one
 * implementation. `remove` (not `delete`) because the latter is a JS keyword.
 */

const WORK_ID_RE = /^wr-work-[0-9a-f-]+$/i;
const ID_SUFFIX_RE = /^[0-9a-f-]+$/i;
const FILE_NAME = Object.freeze({ character: 'characters.json', setting: 'settings.json', object: 'objects.json' });
const LIST_KEY = Object.freeze({ character: 'characters', setting: 'settings', object: 'objects' });
const badReq = (message) => new ServerError(message, { status: 400, code: 'VALIDATION_ERROR' });
const notFoundErr = (what) => new ServerError(`${what} not found`, { status: 404, code: 'NOT_FOUND' });
const wrDir = (workId) => {
  if (typeof workId !== 'string' || !WORK_ID_RE.test(workId)) throw badReq('Invalid work id');
  return join(PATHS.data, 'writers-room', 'works', workId);
};

export function createBibleStore(opts) {
  const {
    kind, idPrefix, dedupKey, primaryFields,
    editableFields, requireOnCreate, validateAfterUpdate, conflictMessage,
    notFoundLabel, invalidIdMessage,
  } = opts;
  const sanitizer = SANITIZERS[kind];
  const fileName = FILE_NAME[kind];
  const listKey = LIST_KEY[kind];
  if (!sanitizer || !fileName) throw new Error(`createBibleStore: unknown kind "${kind}"`);
  const sortKeyFn = sortKey(kind);
  const filePath = (workId) => join(wrDir(workId), fileName);
  const assertId = (id) => {
    if (typeof id !== 'string' || !id.startsWith(idPrefix) || !ID_SUFFIX_RE.test(id.slice(idPrefix.length))) {
      throw badReq(invalidIdMessage);
    }
  };

  async function load(workId) {
    const fallback = { [listKey]: [], updatedAt: null };
    const parsed = await readJSONFile(filePath(workId), fallback);
    if (!parsed || !Array.isArray(parsed[listKey])) return fallback;
    return { ...parsed, [listKey]: sanitizeBibleList(parsed[listKey], kind, { idPrefix }) };
  }

  async function save(workId, state) {
    await ensureDir(wrDir(workId));
    await atomicWrite(filePath(workId), { ...state, updatedAt: nowIso() });
  }

  async function list(workId) {
    const state = await load(workId);
    return state[listKey].sort((a, b) => sortKeyFn(a).localeCompare(sortKeyFn(b)));
  }

  async function get(workId, entryId) {
    assertId(entryId);
    const state = await load(workId);
    const found = state[listKey].find((e) => e.id === entryId);
    if (!found) throw notFoundErr(notFoundLabel);
    return found;
  }

  async function create(workId, patch = {}) {
    const requireErr = requireOnCreate(patch);
    if (requireErr) throw badReq(requireErr);
    const state = await load(workId);
    const keyOfPatch = dedupKey(patch);
    if (keyOfPatch && state[listKey].some((e) => dedupKey(e) === keyOfPatch)) {
      throw badReq(conflictMessage(patch));
    }
    const draft = { id: `${idPrefix}${randomUUID()}`, source: 'user' };
    for (const field of primaryFields) {
      if (patch[field] !== undefined) draft[field] = String(patch[field] || '').trim();
    }
    for (const field of editableFields) {
      if (patch[field] !== undefined) draft[field] = patch[field];
    }
    // Settings: if both name and slugline are primary, missing name + present
    // slugline → mirror slugline → name (preserves old createSetting behavior).
    if (primaryFields.includes('name') && primaryFields.includes('slugline') && !draft.name && draft.slugline) {
      draft.name = draft.slugline;
    }
    const profile = sanitizer(draft, { idPrefix, preserveTimestamps: false });
    state[listKey].push(profile);
    await save(workId, state);
    return profile;
  }

  async function update(workId, entryId, patch = {}) {
    assertId(entryId);
    const state = await load(workId);
    const idx = state[listKey].findIndex((e) => e.id === entryId);
    if (idx < 0) throw notFoundErr(notFoundLabel);
    const next = { ...state[listKey][idx] };
    // Primary fields: single-primary kinds reject blank; multi-primary
    // settings allow blanks here and rely on validateAfterUpdate for the
    // combined-blank invariant.
    for (const field of primaryFields) {
      if (patch[field] === undefined) continue;
      const newVal = String(patch[field] || '').trim();
      if (primaryFields.length === 1 && !newVal) {
        throw badReq(`${notFoundLabel} ${field} cannot be blank`);
      }
      if (newVal) {
        const newKey = dedupKey({ ...next, [field]: newVal });
        if (newKey && state[listKey].some((e) => e.id !== entryId && dedupKey(e) === newKey)) {
          throw badReq(conflictMessage({ [field]: newVal }));
        }
      }
      next[field] = newVal;
    }
    for (const field of editableFields) {
      if (patch[field] !== undefined) next[field] = patch[field];
    }
    if (validateAfterUpdate) validateAfterUpdate(next);
    next.source = 'user';
    state[listKey][idx] = sanitizer({ ...next, updatedAt: nowIso() }, { idPrefix, preserveTimestamps: true });
    await save(workId, state);
    return state[listKey][idx];
  }

  async function remove(workId, entryId) {
    assertId(entryId);
    const state = await load(workId);
    const before = state[listKey].length;
    state[listKey] = state[listKey].filter((e) => e.id !== entryId);
    if (state[listKey].length === before) throw notFoundErr(notFoundLabel);
    await save(workId, state);
    return { ok: true };
  }

  async function mergeExtracted(workId, extracted) {
    if (!Array.isArray(extracted)) return list(workId);
    const state = await load(workId);
    state[listKey] = mergeExtractedBible(state[listKey], extracted, kind, { idPrefix });
    await save(workId, state);
    return state[listKey];
  }

  return { list, get, create, update, remove, mergeExtracted };
}
