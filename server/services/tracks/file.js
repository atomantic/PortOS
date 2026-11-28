/** Track catalog records in the dev/test file backend. */
import { join } from 'node:path';
import { PATHS } from '../../lib/fileUtils.js';
import { createLwwRecordFileBackend } from '../../lib/lwwRecordStore.js';
import { readMusicFile, writeMusicFile } from '../musicMembershipMutation.js';
import { applyTrackPatch, buildTrackRecord, mergeTrackRecord, sanitizeTrack } from './logic.js';

export const {
  list: listTracks,
  listIds: listTrackIds,
  get: getTrack,
  create: createTrack,
  update: updateTrack,
  remove: deleteTrack,
  mergeFromSync: mergeTracksFromSync,
  pruneTombstoned: pruneTombstonedTracks,
} = createLwwRecordFileBackend({
  kind: 'track',
  clearOnLocalWrite: ['bundledByPeerId'],
  filePath: join(PATHS.data, 'tracks.json'),
  idPrefix: 'track-',
  labelColumn: 'title',
  orderBy: 'createdAt',
  emoji: '🎵',
  build: buildTrackRecord,
  applyPatch: applyTrackPatch,
  merge: mergeTrackRecord,
  sanitize: sanitizeTrack,
  readAll: (load) => readMusicFile('tracks', load),
  writeAll: (records, save) => writeMusicFile('tracks', records, save),
});
