/** Author catalog records in the PostgreSQL backend. */
import { createLwwRecordDbBackend } from '../../lib/lwwRecordStore.js';
import { applyAuthorPatch, buildAuthorRecord, mergeAuthorRecord } from './logic.js';

export const {
  list: listAuthors,
  listIds: listAuthorIds,
  get: getAuthor,
  create: createAuthor,
  update: updateAuthor,
  remove: deleteAuthor,
  mergeFromSync: mergeAuthorsFromSync,
  pruneTombstoned: pruneTombstonedAuthors,
} = createLwwRecordDbBackend({
  kind: 'author',
  table: 'authors',
  idPrefix: 'auth-',
  labelColumn: 'name',
  logLabel: 'author persona',
  emoji: '✍️',
  build: buildAuthorRecord,
  applyPatch: applyAuthorPatch,
  merge: mergeAuthorRecord,
});
