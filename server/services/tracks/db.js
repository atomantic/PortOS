/** Track catalog records in the PostgreSQL backend. */
import { createLwwRecordDbBackend } from '../../lib/lwwRecordStore.js';
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
} = createLwwRecordDbBackend({
  kind: 'track',
  clearOnLocalWrite: ['bundledByPeerId'],
  table: 'tracks',
  idPrefix: 'track-',
  labelColumn: 'title',
  orderBy: 'created_at',
  emoji: '🎵',
  build: buildTrackRecord,
  applyPatch: applyTrackPatch,
  merge: mergeTrackRecord,
  sanitize: sanitizeTrack,
  acceptsTransactionClient: true,
  // Backfill additive fields such as renders when reading legacy rows.
  sanitizeOnRead: true,
  // Lock tracks during membership reconciliation. Album lists remain unlocked.
  lockListInTransaction: true,
});
