/** Album catalog records in the dev/test file backend. */
import { join } from 'node:path';
import { PATHS } from '../../lib/fileUtils.js';
import { createLwwRecordFileBackend } from '../../lib/lwwRecordStore.js';
import { readMusicFile, writeMusicFile } from '../musicMembershipMutation.js';
import { applyAlbumPatch, buildAlbumRecord, mergeAlbumRecord, sanitizeAlbum } from './logic.js';

export const {
  list: listAlbums,
  listIds: listAlbumIds,
  get: getAlbum,
  create: createAlbum,
  update: updateAlbum,
  remove: deleteAlbum,
  mergeFromSync: mergeAlbumsFromSync,
  pruneTombstoned: pruneTombstonedAlbums,
} = createLwwRecordFileBackend({
  kind: 'album',
  filePath: join(PATHS.data, 'albums.json'),
  idPrefix: 'album-',
  labelColumn: 'title',
  emoji: '💿',
  build: buildAlbumRecord,
  applyPatch: applyAlbumPatch,
  merge: mergeAlbumRecord,
  sanitize: sanitizeAlbum,
  readAll: (load) => readMusicFile('albums', load),
  writeAll: (records, save) => writeMusicFile('albums', records, save),
});
