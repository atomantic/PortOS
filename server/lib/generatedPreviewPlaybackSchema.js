/** Optional preview clock/playback messages. Legacy open and seek stay unchanged. */
import { z } from 'zod';

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

