/** Mount catalog routers and expose aggregate stats and peer sync. */

import { Router } from 'express';
import * as catalogDB from '../services/catalog/catalogDB.js';
import * as catalogSync from '../services/catalog/catalogSync.js';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { catalogSyncQuerySchema } from '../lib/catalog/catalogValidation.js';
import { parsePagination } from '../lib/queryValidation.js';
import { STORY_CANON_SCHEMA_VERSIONS } from '../lib/schemaVersions/storyCanon.js';
import catalogIdentityRouter from './catalogIdentity.js';
import catalogPrimitivesRouter from './catalogPrimitives.js';
import catalogIngestRouter from './catalogIngest.js';
import catalogIngredientsRouter from './catalogIngredients.js';
import catalogMediaRouter from './catalogMedia.js';
import catalogScenesRouter from './catalogScenes.js';
import catalogStoriesRouter from './catalogStories.js';
import catalogTypesRouter from './catalogTypes.js';

const router = Router();

router.get('/stats', asyncHandler(async (req, res) => {
  res.json(await catalogDB.getCatalogStats());
}));

router.get('/sync', asyncHandler(async (req, res) => {
  // Peers pull this (PEER_API_SURFACE): honor the per-peer `catalog` category.
  const { authorizePeerPull } = await import('../services/sharing/peerPullAuthorization.js');
  await authorizePeerPull(req, { syncCategory: 'catalog', route: 'catalog sync' });
  // The four `sync_sequence` columns are independent — accept either
  // `?since=N` (uniform; only meaningful on the first pull where everyone's
  // at 0) or `?since[scraps]=A&since[ingredients]=B&...` for subsequent
  // pulls.
  //
  // Express 5 defaults `query parser` to `simple` (Node's querystring),
  // which leaves `since[scraps]=10` as a flat key `'since[scraps]': '10'`
  // instead of nesting it. We reconstruct the per-kind object ourselves so
  // the documented bracket protocol survives regardless of parser config —
  // otherwise peers would silently keep pulling page 1 and loop on hasMore.
  const { since: sinceRaw, limit: limitRaw } = validateRequest(catalogSyncQuerySchema, req.query);
  let since;
  if (sinceRaw && typeof sinceRaw === 'object' && !Array.isArray(sinceRaw)) {
    since = sinceRaw;
  } else {
    const bracket = {};
    for (const [k, v] of Object.entries(req.query)) {
      const m = /^since\[([a-z]+)\]$/.exec(k);
      if (!m) continue;
      // Node's `simple` parser collapses repeated keys into an array; take
      // the last value (HTTP convention) instead of dropping the cursor on
      // the floor and resetting to '0'.
      const value = Array.isArray(v) ? v[v.length - 1] : v;
      if (typeof value === 'string') bracket[m[1]] = value;
    }
    if (Object.keys(bracket).length > 0) {
      since = bracket;
    } else {
      // Reject arrays (`?since=1&since=2`) — coerce to '0' rather than letting
      // them silently re-pull the whole sync log.
      since = (typeof sinceRaw === 'string' && /^\d+$/.test(sinceRaw)) ? sinceRaw : '0';
    }
  }
  const { limit } = parsePagination({ limit: limitRaw }, { defaultLimit: 100, maxLimit: 1000 });
  const changes = await catalogSync.getChangesSince(since, limit);
  res.json({
    ...changes,
    portosMeta: { schemaVersions: { catalog: STORY_CANON_SCHEMA_VERSIONS.catalog } },
  });
}));

router.use('/identity', catalogIdentityRouter);
router.use('/ingredients/:id', catalogPrimitivesRouter);
router.use(catalogIngestRouter);
router.use(catalogIngredientsRouter);
router.use(catalogMediaRouter);
router.use(catalogScenesRouter);
router.use(catalogStoriesRouter);
router.use(catalogTypesRouter);

export default router;
