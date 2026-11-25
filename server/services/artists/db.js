/** Artist catalog records in the PostgreSQL backend. */
import { createLwwRecordDbBackend } from '../../lib/lwwRecordStore.js';
import { applyArtistPatch, buildArtistRecord, mergeArtistRecord } from './logic.js';

export const {
  list: listArtists,
  listIds: listArtistIds,
  get: getArtist,
  create: createArtist,
  update: updateArtist,
  remove: deleteArtist,
  mergeFromSync: mergeArtistsFromSync,
  pruneTombstoned: pruneTombstonedArtists,
} = createLwwRecordDbBackend({
  kind: 'artist',
  table: 'artists',
  idPrefix: 'artist-',
  labelColumn: 'name',
  logLabel: 'music artist',
  emoji: '🎤',
  build: buildArtistRecord,
  applyPatch: applyArtistPatch,
  merge: mergeArtistRecord,
});
