/** Optional preview clock/playback messages. Legacy open and seek stay unchanged. */
import { z } from 'zod';

export const AUTHORED_PREVIEW_PLAYBACK_TARGET = '__portosAuthoredPreviewPlayback';
export const AUTHORED_PREVIEW_HANDSHAKE_MS = 1500;

const identity = {
  requestId: z.string().uuid(), sessionId: z.string().uuid(),
};
const anchor = {
  ...identity, epoch: z.number().int().nonnegative(), sequence: z.number().int().nonnegative(),
  t: z.number().min(0).max(86400), workerTime: z.number().finite(),
};
export const generatedPreviewPlaybackSchema = z.discriminatedUnion('action', [
  z.object({ ...identity, action: z.literal('clock'), probeId: z.number().int().nonnegative(), clientTime: z.number().finite() }).strict(),
  z.object({ ...identity, action: z.literal('prepare'), epoch: z.number().int().nonnegative(), sequence: z.number().int().nonnegative(), generation: z.number().int().nonnegative(), t: z.number().min(0).max(86400) }).strict(),
  z.object({ ...anchor, action: z.literal('play') }).strict(),
  z.object({ ...anchor, action: z.literal('sync') }).strict(),
  z.object({ ...identity, action: z.literal('pause'), epoch: z.number().int().nonnegative(), generation: z.number().int().nonnegative(), t: z.number().min(0).max(86400) }).strict(),
]);


// Authored producers opt into strict method replies. Canonical adapters retain
// their existing responses; these schemas are only applied after authored calls.
const authoredEpoch = { epoch: z.number().int().nonnegative() };
const authoredOperation = { ...authoredEpoch, sequence: z.number().int().nonnegative() };
export const authoredPreviewPlaybackReplies = {
  clock: z.number().finite().nonnegative(),
  prepare: z.object({ ...authoredOperation, status: z.literal('prepared'), t: z.number().finite().min(0).max(86400) }).strict(),
  play: z.object({ ...authoredOperation, status: z.enum(['playing', 'resync-required', 'superseded', 'stale']) }).strict(),
  sync: z.object({ ...authoredOperation, status: z.enum(['accepted', 'resync-required', 'stale']), driftSec: z.number().finite().optional() }).strict(),
  pause: z.object({ ...authoredEpoch, status: z.literal('paused') }).strict(),
};
