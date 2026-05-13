/**
 * Writers Room — editable character profile bible.
 *
 * Per-work canonical roster stored at data/writers-room/works/<workId>/
 * characters.json. CRUD + file I/O + dedup rules all live in the shared
 * `createBibleStore` factory; this module just supplies the per-kind config.
 */

import { createBibleStore, BIBLE_KIND, normalizeBibleName } from '../../lib/storyBible.js';

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
  editableFields: ['aliases', 'role', 'physicalDescription', 'personality', 'background', 'notes'],
  requireOnCreate: (patch) => (String(patch?.name || '').trim() ? null : 'Character name required'),
  conflictMessage: ({ name }) => `A character named "${name}" already exists`,
  notFoundLabel: 'Character',
  invalidIdMessage: 'Invalid character id',
});
