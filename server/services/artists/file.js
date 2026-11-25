/** Artist catalog records in the dev/test file backend. */
import { join } from 'node:path';
import { PATHS } from '../../lib/fileUtils.js';
import { createLwwRecordFileBackend } from '../../lib/lwwRecordStore.js';
import { applyArtistPatch, buildArtistRecord, mergeArtistRecord, sanitizeArtist } from './logic.js';

export const {
  list: listArtists,
  listIds: listArtistIds,
  get: getArtist,
  create: createArtist,
  update: updateArtist,
  remove: deleteArtist,
  mergeFromSync: mergeArtistsFromSync,
  pruneTombstoned: pruneTombstonedArtists,
} = createLwwRecordFileBackend({
  kind: 'artist',
  filePath: join(PATHS.data, 'artists.json'),
  idPrefix: 'artist-',
  labelColumn: 'name',
  logLabel: 'music artist',
  emoji: '🎤',
  build: buildArtistRecord,
  applyPatch: applyArtistPatch,
  merge: mergeArtistRecord,
  sanitize: sanitizeArtist,
});
