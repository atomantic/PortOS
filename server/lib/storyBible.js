/** Public story-bible API for canonical shapes, merges, and reveal gating. */

export { BIBLE_LIMITS } from './bibleLimits.js';
export { BIBLE_FIELD, BIBLE_KEYS, BIBLE_KIND, BIBLE_KINDS } from './universeCanon.js';
export { normalizeSlugline } from './scenePrompt.js';
export { LEGACY_SHEET_VARIANT_ID, readSheetPointer, listSheetPointers, applySheetPointerToCharacter } from './sheetPointers.js';
export { ATTACHMENT_ROLES, IDENTITY_ASSET_ROLES, IDENTITY_PACK_REQUIRED_ROLES } from './storyBibleRoles.js';
export {
  CHARACTER_ARC_TYPES,
  PSYCHOLOGY_ASSESSMENTS,
  PSYCHOLOGY_DRIVE_AXES,
  RELATIONSHIP_LINK_TYPES,
  RELATIONSHIP_OPPOSITION_AXES,
} from './characterFramework.js';
export { characterIdentityPackReadiness } from './storyBibleIdentityPack.js';
export { mergePreservedSheetPointers, pruneStaleReferenceSheets } from './storyBibleReferenceSheets.js';
export {
  canonHasRevealGated,
  filterCanonForIssue,
  filterCanonListForIssue,
  isCanonEntryGatedForIssue,
  isEntryRevealGated,
  revealGatedCanonRows,
} from './storyBibleReveal.js';
export {
  BIBLE_SOURCE,
  CANON_CONTROL_FIELDS,
  FORM_ID_PATTERN,
  PLACE_INT_EXT,
  PLACE_TIME_OF_DAY,
  PROMPT_FIELDS,
  SANITIZERS,
  SERVER_OWNED_CHARACTER_FIELDS,
  VOICE_CANON_SOURCE_POLICIES,
  findBibleEntryByName,
  isSeriesScopedCanonEntry,
  normalizeBibleName,
  nowIso,
  pickPromptFields,
  sanitizeBibleField,
  sanitizeBibleList,
  sanitizeCharacter,
  sanitizeObject,
  sanitizePlace,
  stripCanonControlFields,
} from './storyBibleSanitizers.js';
export {
  bibleUserEditableFields,
  isLegacyAbsentValue,
  mergeExtractedBible,
  preserveLegacyCharacterFields,
  preserveLegacyObjectFields,
  preserveLegacyPlaceFields,
  sortKey,
} from './storyBibleMerge.js';
