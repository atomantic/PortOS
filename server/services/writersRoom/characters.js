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
  editableFields: [
    'aliases', 'role', 'physicalDescription', 'personality', 'background', 'notes',
    'voiceCanon', 'identityPack', 'wardrobes', 'voiceId',
    ...CHARACTER_FRAMEWORK_FIELDS,
  ],
  requireOnCreate: (patch) => (String(patch?.name || '').trim() ? null : 'Character name required'),
  conflictMessage: ({ name }) => `A character named "${name}" already exists`,
  notFoundLabel: 'Character',
  invalidIdMessage: 'Invalid character id',
});
