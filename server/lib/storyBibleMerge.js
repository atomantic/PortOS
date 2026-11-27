/** Merge extracted canon and preserve newer canon fields when older federation peers write. */

import { BIBLE_LIMITS } from './bibleLimits.js';
import { isEmptyScalar, isPlainObject } from './objects.js';
import { normalizeSlugline } from './scenePrompt.js';
import { cleanStringArray } from './storyBibleFields.js';
import { DEFAULT_ID_PREFIX, SANITIZERS, normalizeBibleName, nowIso } from './storyBibleSanitizers.js';
import { BIBLE_KIND } from './universeCanon.js';

// Additive bible-entry fields an older peer's sanitizer cannot represent, keyed
// by the `universes` wire version that introduced each one. A sender AT or
// ABOVE that version omitting the field means the author cleared it; a sender
// BELOW it omitted the field only because its code has no slot for it.
const ADDITIVE_CHARACTER_FIELD_VERSIONS = Object.freeze({
  // v6 — structured character-to-character links (#1287).
  relationshipLinks: 6,
  // v10 — portable production canon (#5378).
  voiceCanon: 10,
  identityPack: 10,
  // v11 — optional structured psychology profile (#6414).
  psychology: 11,
  // v13 — durable per-variant render intent (#11669).
  referenceSheetRequests: 13,
  // v14 — alternate ages/looks beside the canonical form.
  forms: 14,
});
const ADDITIVE_OBJECT_FIELD_VERSIONS = Object.freeze({
  // v7 — structured object↔character attachments (#1288).
  attachments: 7,
  forms: 14,
  // v21 — real-world size, the scale cue renders lack.
  size: 21,
});
const ADDITIVE_PLACE_FIELD_VERSIONS = Object.freeze({
  forms: 14,
  size: 21,
});

// v18 — a form's `height`. A behind sender keeps the form but its sanitizer
// drops the key, so each remote form missing one takes the local form's.
const FORM_HEIGHT_VERSION = 18;
function withLocalFormHeights(remoteForms, localForms) {
  if (!Array.isArray(remoteForms) || !Array.isArray(localForms)) return null;
  const heights = new Map(localForms.filter((f) => f?.id && f.height).map((f) => [f.id, f.height]));
  if (!remoteForms.some((f) => !f?.height && heights.has(f?.id))) return null;
  return remoteForms.map((f) => (!f?.height && heights.has(f?.id) ? { ...f, height: heights.get(f.id) } : f));
}

// "The sender carried nothing here." Covers both absent-when-empty fields
// (voiceCanon, psychology) and always-present list fields a behind sender's
// sanitizer defaults to `[]` (relationshipLinks, attachments).
export function isLegacyAbsentValue(value) {
  return value === undefined || value === null || value === false || value === ''
    || (Array.isArray(value) && value.length === 0)
    || (isPlainObject(value) && Object.keys(value).length === 0);
}

/**
 * Restore, onto each remote entry, the local entry's value for every additive
 * field the sender's version could not represent. Each field is restored ONLY
 * from a sender behind the version that introduced it — a version-aware
 * sender's omission is an intentional clear and must pass through unchanged.
 * Entries pair by id; a remote entry with no local counterpart is untouched.
 */
function preserveLegacyEntryFields(remoteEntries, localEntries, fieldVersions, senderUniversesVersion) {
  const sender = Number(senderUniversesVersion) || 0;
  const unrepresentable = Object.entries(fieldVersions)
    .filter(([, since]) => sender < since)
    .map(([field]) => field);
  const formHeights = sender < FORM_HEIGHT_VERSION;
  if ((unrepresentable.length === 0 && !formHeights)
    || !Array.isArray(remoteEntries)
    || !Array.isArray(localEntries)) return remoteEntries;
  const localById = new Map(
    localEntries.filter((entry) => entry?.id).map((entry) => [entry.id, entry]),
  );
  return remoteEntries.map((entry) => {
    const localEntry = localById.get(entry?.id);
    if (!localEntry) return entry;
    const restored = {};
    for (const field of unrepresentable) {
      if (isLegacyAbsentValue(entry?.[field]) && !isLegacyAbsentValue(localEntry[field])) {
        restored[field] = localEntry[field];
      }
    }
    const forms = formHeights && !restored.forms ? withLocalFormHeights(entry?.forms, localEntry.forms) : null;
    if (forms) restored.forms = forms;
    return Object.keys(restored).length ? { ...entry, ...restored } : entry;
  });
}

/** Preserve additive character fields when an older peer wins LWW. */
export function preserveLegacyCharacterFields(remoteCharacters, localCharacters, senderUniversesVersion) {
  return preserveLegacyEntryFields(
    remoteCharacters, localCharacters, ADDITIVE_CHARACTER_FIELD_VERSIONS, senderUniversesVersion,
  );
}

/** Preserve additive place fields when an older peer wins LWW. */
export function preserveLegacyPlaceFields(remotePlaces, localPlaces, senderUniversesVersion) {
  return preserveLegacyEntryFields(
    remotePlaces, localPlaces, ADDITIVE_PLACE_FIELD_VERSIONS, senderUniversesVersion,
  );
}

/** Preserve additive object fields when an older peer wins LWW. */
export function preserveLegacyObjectFields(remoteObjects, localObjects, senderUniversesVersion) {
  return preserveLegacyEntryFields(
    remoteObjects, localObjects, ADDITIVE_OBJECT_FIELD_VERSIONS, senderUniversesVersion,
  );
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
      // Character framework (CWQE Phase 10, #2175) — fill only when blank.
      'ghost', 'wound', 'lie', 'want', 'need', 'arcType', 'secrets',
      // Optional psychology profile (#6414). Whole-object granularity, like
      // `wardrobes`: the extractor may author one on a character that has none,
      // and never touches a profile the writer has already started.
      'psychology',
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

/**
 * The fields the prose extractor's merge will fill only when blank, per kind.
 *
 * Exported so `universeBibleCompleteness.js` can be held to it: the extractor's
 * no-clobber set and the expand prompts' field set are two answers to the same
 * question ("what may an LLM fill in on an existing entry?"), and a field added
 * to one but not the other is invisible to the completeness scan forever.
 * `universeBibleCompleteness.test.js` asserts the two match modulo a named delta.
 */
export const bibleUserEditableFields = (kind) => MERGE_CONFIG[kind]?.userEditable || [];

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
        if (isEmptyScalar(found[field]) && !isEmptyScalar(sane[field])) {
          found[field] = sane[field];
        }
      }
      // Backfill any blank key field (slugline, name, aliases) and re-index
      // so a later entry in the same batch keyed by the just-filled value
      // resolves to this canonical record instead of inserting a duplicate.
      let reindex = false;
      for (const { field } of cfg.keyFields) {
        if (isEmptyScalar(found[field]) && !isEmptyScalar(sane[field])) {
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
