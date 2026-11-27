// Zod request schemas for the video history read routes.

import { z } from 'zod';

// The ONE contract every `/history/:id*` route resolves its record id through
// (#5713) — GET, DELETE, visibility and prompt all name the same stored row, so
// they share one schema instead of three (loose / strict / none).
//
// It stays looser than a UUID check on purpose: that suits ids this install
// MINTS, but entries also arrive from a caller-supplied download id and from
// federated peers, so a `.guid()` gate here would 400 rows that are
// legitimately in the list. The charset bound is the floor — every legitimate
// id is `[A-Za-z0-9._-]+`, and a value carrying a path segment or a `..` can no
// longer parse, so `safeUnder()` in historyOps is defense in depth rather than
// the only thing standing between a hostile id and an unlink loop.
export const historyRecordIdSchema = z.string().trim().min(1).max(200)
  .regex(/^[A-Za-z0-9._-]+$/, 'invalid history id');

export const historyReadQuerySchema = z.object({ geometry: z.enum(['true', 'false']).optional() });
