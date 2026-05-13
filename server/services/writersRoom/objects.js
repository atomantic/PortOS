/**
 * Writers Room — editable recurring-objects bible.
 *
 * Per-work canonical roster stored at data/writers-room/works/<workId>/
 * objects.json. CRUD + file I/O + dedup rules all live in the shared
 * `createBibleStore` factory; this module just supplies the per-kind config.
 */

import { createBibleStore, BIBLE_KIND, normalizeBibleName } from '../../lib/storyBible.js';

export const {
  list: listObjects,
  get: getObject,
  create: createObject,
  update: updateObject,
  remove: deleteObject,
  mergeExtracted: mergeExtractedObjects,
} = createBibleStore({
  kind: BIBLE_KIND.OBJECT,
  idPrefix: 'wr-object-',
  dedupKey: (entry) => normalizeBibleName(entry?.name),
  primaryFields: ['name'],
  editableFields: ['aliases', 'description', 'significance', 'notes'],
  requireOnCreate: (patch) => (String(patch?.name || '').trim() ? null : 'Object name required'),
  conflictMessage: ({ name }) => `An object named "${name}" already exists`,
  notFoundLabel: 'Object',
  invalidIdMessage: 'Invalid object id',
});
