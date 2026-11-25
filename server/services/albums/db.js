/** Album catalog records in the PostgreSQL backend. */
import { createLwwRecordDbBackend } from '../../lib/lwwRecordStore.js';
import { applyAlbumPatch, buildAlbumRecord, mergeAlbumRecord } from './logic.js';

export const {
  list: listAlbums,
  listIds: listAlbumIds,
  get: getAlbum,
  create: createAlbum,
  update: updateAlbum,
  remove: deleteAlbum,
  mergeFromSync: mergeAlbumsFromSync,
  pruneTombstoned: pruneTombstonedAlbums,
} = createLwwRecordDbBackend({
  kind: 'album',
  table: 'albums',
  idPrefix: 'album-',
  labelColumn: 'title',
  emoji: '💿',
  build: buildAlbumRecord,
  applyPatch: applyAlbumPatch,
  merge: mergeAlbumRecord,
  acceptsTransactionClient: true,
});
