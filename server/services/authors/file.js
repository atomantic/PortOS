/** Author catalog records in the dev/test file backend. */
import { join } from 'node:path';
import { PATHS } from '../../lib/fileUtils.js';
import { createLwwRecordFileBackend } from '../../lib/lwwRecordStore.js';
import { applyAuthorPatch, buildAuthorRecord, mergeAuthorRecord, sanitizeAuthor } from './logic.js';

export const {
  list: listAuthors,
  listIds: listAuthorIds,
  get: getAuthor,
  create: createAuthor,
  update: updateAuthor,
  remove: deleteAuthor,
  mergeFromSync: mergeAuthorsFromSync,
  pruneTombstoned: pruneTombstonedAuthors,
} = createLwwRecordFileBackend({
  kind: 'author',
  filePath: join(PATHS.data, 'authors.json'),
  idPrefix: 'auth-',
  labelColumn: 'name',
  logLabel: 'author persona',
  emoji: '✍️',
  build: buildAuthorRecord,
  applyPatch: applyAuthorPatch,
  merge: mergeAuthorRecord,
  sanitize: sanitizeAuthor,
});
