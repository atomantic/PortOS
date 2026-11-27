/**
 * Zod schemas for snapshot-based data sync and tombstone sweeps.
 */

import { z } from 'zod';
import { TOMBSTONE_GRACE_MS } from './tombstones.js';

// MUST stay in sync with dataSync.getSupportedCategories() — a category
// registered in the service but absent here 400s before its snapshot/apply
// handler can run (the latent bug #730 hit for `storyBuilder`). Exported so
// dataSync.test.js can assert that parity against the REAL service export in
// both directions, instead of re-typing this list (#5705).
export const syncCategoryParamSchema = z.enum(['goals', 'character', 'digitalTwin', 'meatspace', 'universe', 'pipeline', 'mediaCollections', 'videoHistory', 'storyBuilder', 'usage']);

// Manual sweeps can shorten the grace period. The service still enforces the peer ack horizon.
export const tombstoneSweepBodySchema = z.object({
  graceMs: z.number().int().min(0).max(TOMBSTONE_GRACE_MS).optional(),
}).strict();

// Accept metadata fields from newer peers so the service can diagnose their schema versions.
export const syncApplyBodySchema = z.object({
  data: z.unknown(),
  portosMeta: z.object({
    portosVersion: z.string().trim().min(1).max(40).optional(),
    schemaVersions: z.record(z.string().min(1).max(60), z.number().int().min(0).max(1_000_000)).optional(),
  }).passthrough().optional(),
});
