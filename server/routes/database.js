import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import {
  validateRequest,
  databaseSwitchSchema,
  databaseBackendSchema,
  databaseExportSchema,
  databaseMaintenancePreflightSchema
} from '../lib/validation.js';
import * as dbAdmin from '../services/dbAdmin.js';

const router = Router();

// GET /api/database/maintenance/status — local journal, no pool/shell probes.
// The ordinary instance auth gate applies; this is not a public health route.
router.get('/maintenance/status', asyncHandler(async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(dbAdmin.getMaintenanceStatus());
}));

// Advisory validation only: acceptance must repeat this under the admission fence.
router.post('/maintenance/preflight', asyncHandler(async (req, res) => {
  const direction = validateRequest(databaseMaintenancePreflightSchema, req.body);
  res.set('Cache-Control', 'no-store');
  res.json(await dbAdmin.preflightDatabaseMaintenance(direction));
}));

// GET /api/database/status — current mode, connectivity, row counts, resource stats
router.get('/status', asyncHandler(async (_req, res) => {
  res.json(await dbAdmin.getStatus());
}));

// POST /api/database/switch — switch mode and optionally migrate
router.post('/switch', asyncHandler(async (req, res) => {
  const options = validateRequest(databaseSwitchSchema, req.body);
  res.json(await dbAdmin.switchDatabase(options, req.app.get('io')));
}));

// POST /api/database/sync — copy data from active to non-active backend
router.post('/sync', asyncHandler(async (req, res) => {
  res.json(await dbAdmin.syncDatabase(req.app.get('io')));
}));

// POST /api/database/start — start a specific backend
router.post('/start', asyncHandler(async (req, res) => {
  const { backend } = validateRequest(databaseBackendSchema, req.body);
  res.json(await dbAdmin.startDatabase(backend));
}));

// POST /api/database/stop — stop a specific backend
router.post('/stop', asyncHandler(async (req, res) => {
  const { backend } = validateRequest(databaseBackendSchema, req.body);
  res.json(await dbAdmin.stopDatabase(backend));
}));

// POST /api/database/destroy — destroy the non-active backend's data
router.post('/destroy', asyncHandler(async (req, res) => {
  const { backend } = validateRequest(databaseBackendSchema, req.body);
  res.json(await dbAdmin.destroyDatabase(backend));
}));

// POST /api/database/setup-native — install and configure native PostgreSQL
router.post('/setup-native', asyncHandler(async (req, res) => {
  res.json(await dbAdmin.setupNativeDatabase(req.app.get('io')));
}));

// POST /api/database/export — export a specific or active backend to a SQL dump
router.post('/export', asyncHandler(async (req, res) => {
  const { backend } = validateRequest(databaseExportSchema, req.body || {});
  res.json(await dbAdmin.exportDatabase(backend));
}));

// POST /api/database/fix — fix stale pid files
router.post('/fix', asyncHandler(async (_req, res) => {
  res.json(await dbAdmin.fixDatabase());
}));

export default router;
