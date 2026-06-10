import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest, citySnapshotsQuerySchema } from '../lib/validation.js';
import {
  captureSnapshot,
  getSnapshots,
  getSnapshotConfig,
} from '../services/citysnapshots.js';
import { getNextSnapshotTime } from '../services/citySnapshotScheduler.js';
import { getCityIntrospection } from '../services/cityIntrospection.js';

const router = Router();

// GET /api/city/snapshots — the recorded city-state series, oldest-first.
// A future timeline scrubber loads this and drives the 3D scene from a frame.
router.get('/snapshots', asyncHandler(async (req, res) => {
  const { since, limit } = validateRequest(citySnapshotsQuerySchema, req.query);
  res.json(await getSnapshots({ since, limit }));
}));

// POST /api/city/snapshots/capture — capture a frame on demand (manual /
// testing trigger; the scheduler drives the periodic captures).
router.post('/snapshots/capture', asyncHandler(async (req, res) => {
  res.json(await captureSnapshot());
}));

// GET /api/city/introspection — DB tables + data/ domain sizes for the Data
// Harbor district. Cached server-side (stale-while-revalidate); `db: null`
// means the database is unreachable, distinct from a reachable-but-empty one.
router.get('/introspection', asyncHandler(async (req, res) => {
  res.json(await getCityIntrospection());
}));

// GET /api/city/snapshots/config — effective capture config + next run time.
router.get('/snapshots/config', asyncHandler(async (req, res) => {
  const config = await getSnapshotConfig();
  res.json({ ...config, nextRun: getNextSnapshotTime() });
}));

export default router;
