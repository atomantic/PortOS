/**
 * Command Palette Routes
 *
 *   GET  /api/palette/manifest        → { nav, actions }
 *   POST /api/palette/action/:id      → dispatches a palette-safe voice tool
 *
 * Navigation + actions share their source with the voice agent (navManifest +
 * voice/tools.js). Adding a palette action: whitelist its id below with a
 * label + section; description/parameters hydrate from the voice tool
 * registry automatically.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { NAV_COMMANDS } from '../lib/navManifest.js';
import { dispatchTool, getToolMetadata } from '../services/voice/tools.js';

const router = Router();

// Palette-safe subset of voice tools. Excluded: ui_* (need a live voice DOM
// context), dictation toggles (voice-widget state), daily_log_open (pushes a
// sideEffect HTTP callers can't consume). pm2_restart is flagged destructive
// so the client can confirm.
const PALETTE_ACTIONS = [
  { id: 'brain_capture',           label: 'Capture to Brain',        section: 'Brain' },
  { id: 'brain_search',            label: 'Search Brain',            section: 'Brain' },
  { id: 'brain_list_recent',       label: 'Recent Brain entries',    section: 'Brain' },
  { id: 'goal_list',               label: 'List goals',              section: 'Goals' },
  { id: 'goal_update_progress',    label: 'Update goal progress',    section: 'Goals' },
  { id: 'goal_log_note',           label: 'Log note on goal',        section: 'Goals' },
  { id: 'meatspace_log_drink',     label: 'Log a drink',             section: 'Health' },
  { id: 'meatspace_log_nicotine',  label: 'Log nicotine',            section: 'Health' },
  { id: 'meatspace_log_weight',    label: 'Log weight',              section: 'Health' },
  { id: 'meatspace_summary_today', label: "Today's health summary",  section: 'Health' },
  { id: 'feeds_digest',            label: 'Feed digest',             section: 'Feeds' },
  { id: 'pm2_status',              label: 'PM2 status',              section: 'System' },
  { id: 'pm2_restart',             label: 'Restart a PM2 process',   section: 'System', destructive: true },
  { id: 'daily_log_read',          label: "Read today's log",        section: 'Brain' },
  { id: 'daily_log_append',        label: 'Append to daily log',     section: 'Brain' },
  { id: 'time_now',                label: 'Current time',            section: 'System' },
];

const PALETTE_ACTION_IDS = new Set(PALETTE_ACTIONS.map((a) => a.id));

// Computed once at module load — the nav manifest and voice tool registry
// are both module-scoped and do not change at runtime.
const MANIFEST = Object.freeze({
  nav: NAV_COMMANDS,
  actions: PALETTE_ACTIONS.map((a) => {
    const meta = getToolMetadata(a.id);
    return {
      ...a,
      description: meta?.description || '',
      parameters: meta?.parameters || { type: 'object', properties: {} },
    };
  }),
});

router.get('/manifest', asyncHandler(async (_req, res) => {
  res.set('Cache-Control', 'private, max-age=300');
  res.json(MANIFEST);
}));

const actionBodySchema = z.object({
  args: z.record(z.any()).optional().default({}),
});

router.post('/action/:id', asyncHandler(async (req, res) => {
  const id = String(req.params.id || '');
  if (!PALETTE_ACTION_IDS.has(id)) {
    throw new ServerError(`Unknown palette action "${id}"`, { status: 404 });
  }
  const { args } = validateRequest(actionBodySchema, req.body ?? {});
  const result = await dispatchTool(id, args, { sideEffects: [] });
  res.json({ ok: result?.ok !== false, result });
}));

export default router;
