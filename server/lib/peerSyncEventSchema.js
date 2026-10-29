/**
 * Wire contract for realtime peer sync frames (`peer:sync:event`). Frames are
 * peer-controlled input: strict shape, bounded strings, a capped record, and an
 * explicit `v` so an older receiver ignores a frame shape it does not know.
 */
import { z } from 'zod';
import { isPlainObject } from './objects.js';
import { parseTsMs } from './lwwTimestamp.js';

export const PEER_SYNC_EVENT_VERSION = 1;
export const PEER_SYNC_MAX_RECORD_BYTES = 64 * 1024;
export const PEER_SYNC_EVENT_CATEGORIES = Object.freeze(['videoHistory', 'imageHistory']);
// `holding`: the sender now holds (or no longer holds) the bytes of the file
// named by `id` (services/mediaHolders.js). A receiver predating it drops the
// frame as malformed, which is harmless: the inventory pull carries the same fact.
export const PEER_SYNC_EVENT_OPS = Object.freeze(['upsert', 'delete', 'holding']);

// Serialized UTF-8 size; an unserializable value counts as oversize.
function peerSyncRecordBytes(record) {
  try {
    return Buffer.byteLength(JSON.stringify(record) ?? '', 'utf8');
  } catch {
    return Infinity;
  }
}

const idString = z.string().min(1).max(256);

// Also validates a delete ack's tombstone (services/mediaRemoteDelete.js).
export const peerSyncTombstoneSchema = z.object({
  key: idString,
  deletedAt: z.string().max(64).refine((v) => parseTsMs(v) !== null, 'deletedAt must be a timestamp'),
}).strict();

const recordSchema = z.custom(isPlainObject, { message: 'record must be an object' })
  .refine((r) => peerSyncRecordBytes(r) <= PEER_SYNC_MAX_RECORD_BYTES, `record exceeds ${PEER_SYNC_MAX_RECORD_BYTES} bytes`);

export const peerSyncEventSchema = z.object({
  v: z.literal(PEER_SYNC_EVENT_VERSION),
  category: z.enum(PEER_SYNC_EVENT_CATEGORIES),
  op: z.enum(PEER_SYNC_EVENT_OPS),
  id: idString,
  record: recordSchema.optional(),
  tombstone: peerSyncTombstoneSchema.optional(),
  holding: z.object({ held: z.boolean() }).strict().optional(),
  originInstanceId: z.string().min(1).max(128),
}).strict().superRefine((event, ctx) => {
  if (event.op !== 'holding' && event.holding) ctx.addIssue({ code: 'custom', path: ['holding'], message: 'only a holding frame carries holding' });
  if (event.op === 'holding') {
    if (!event.holding) ctx.addIssue({ code: 'custom', path: ['holding'], message: 'holding needs { held }' });
    if (event.record || event.tombstone) ctx.addIssue({ code: 'custom', path: ['op'], message: 'holding carries no record or tombstone' });
  } else if (event.op === 'upsert') {
    if (!event.record || event.record.id !== event.id) ctx.addIssue({ code: 'custom', path: ['record'], message: 'upsert needs a record whose id matches' });
    if (event.tombstone) ctx.addIssue({ code: 'custom', path: ['tombstone'], message: 'upsert carries no tombstone' });
  } else {
    if (!event.tombstone || event.tombstone.key !== event.id) ctx.addIssue({ code: 'custom', path: ['tombstone'], message: 'delete needs a tombstone whose key matches' });
    if (event.record) ctx.addIssue({ code: 'custom', path: ['record'], message: 'delete carries no record' });
  }
});
