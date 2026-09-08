/**
 * Writers Room — editable character profile bible.
 *
 * Per-work canonical roster stored at data/writers-room/works/<workId>/
 * characters.json. CRUD + file I/O + dedup rules all live in the shared
 * `createBibleStore` factory; this module just supplies the per-kind config.
 */

import { BIBLE_KIND, normalizeBibleName } from '../../lib/storyBible.js';
import { CHARACTER_FRAMEWORK_FIELDS } from '../../lib/characterFramework.js';
import { createBibleStore } from '../bibleStore.js';

/**
 * Everything a writer may author on a Writers Room character, in one exported
 * list so a test can assert it against the route schema. The two MUST agree:
 * a field the Zod schema accepts and this list omits is validated and then
 * thrown away by `createBibleStore` (that is how `relationshipLinks`,
 * `wardrobes` and `voiceId` were silently dropped before #6417).
 */
export const CHARACTER_EDITABLE_FIELDS = Object.freeze([
  'aliases', 'role', 'physicalDescription', 'personality', 'background', 'notes',
  'voiceCanon', 'identityPack', 'wardrobes', 'voiceId',
  ...CHARACTER_FRAMEWORK_FIELDS,
  // The optional five-stage evolution lens (#6445). Story-scoped BY
  // CONSTRUCTION: this store is per work, so authoring a lens here can never
  // reach the universe-wide cast identity the lens is layered over.
  'evolution',
]);

export const {
  list: listCharacters,
  get: getCharacter,
  create: createCharacter,
  update: updateCharacter,
  remove: deleteCharacter,
  mergeExtracted: mergeExtractedCharacters,
} = createBibleStore({
  kind: BIBLE_KIND.CHARACTER,
  idPrefix: 'wr-char-',
  dedupKey: (entry) => normalizeBibleName(entry?.name),
  primaryFields: ['name'],
  // Parity with the Universe cast editor (#6417): the writers-room bible
  // shares `sanitizeCharacter`, so the narrative framework already round-trips
  // on disk — it just wasn't reachable through this store. `wardrobes`,
  // `voiceId` and `relationshipLinks` were in the same position: accepted by
  // the route schema, then silently dropped here. Everything the create/update
  // Zod schema accepts must appear in this list or the write is validated and
  // thrown away.
  editableFields: CHARACTER_EDITABLE_FIELDS,
  requireOnCreate: (patch) => (String(patch?.name || '').trim() ? null : 'Character name required'),
  conflictMessage: ({ name }) => `A character named "${name}" already exists`,
  notFoundLabel: 'Character',
  invalidIdMessage: 'Invalid character id',
});
