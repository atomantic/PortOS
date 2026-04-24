/**
 * Command Palette Routes
 *
 * Feeds the client-side Cmd+K palette and exposes a narrow set of voice-agent
 * tools via HTTP so the palette can invoke them without re-implementing the
 * logic. This is the DRY backbone: navigation + actions have one source of
 * truth (navManifest.js + voice/tools.js), and the palette + voice agent are
 * two consumers of the same registry.
 *
 *   GET  /api/palette/manifest        → { nav: [...], actions: [...] }
 *   POST /api/palette/action/:id      → dispatches a palette-safe tool
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { NAV_COMMANDS } from '../lib/navManifest.js';
import { dispatchTool, getToolSpecs } from '../services/voice/tools.js';

const router = Router();

// Palette-safe subset of voice tools. Excluded: ui_* (they drive the DOM from
// within the voice agent's live context; from the palette we'd have no target
// surface), dictation toggles (mode state that belongs to the voice widget),
// and daily_log_open (pushes a sideEffect the HTTP caller can't consume).
// pm2_restart is included but marked destructive so the client confirms.
const PALETTE_ACTIONS = [
  { id: 'brain_capture',         label: 'Capture to Brain',      section: 'Brain',        hint: 'Capture a thought' },
  { id: 'brain_search',          label: 'Search Brain',          section: 'Brain' },
  { id: 'brain_list_recent',     label: 'Recent Brain entries',  section: 'Brain' },
  { id: 'goal_list',             label: 'List goals',            section: 'Goals' },
  { id: 'goal_update_progress',  label: 'Update goal progress',  section: 'Goals' },
  { id: 'goal_log_note',         label: 'Log note on goal',      section: 'Goals' },
  { id: 'meatspace_log_drink',   label: 'Log a drink',           section: 'Health' },
  { id: 'meatspace_log_nicotine',label: 'Log nicotine',          section: 'Health' },
  { id: 'meatspace_log_weight',  label: 'Log weight',            section: 'Health' },
  { id: 'meatspace_summary_today', label: "Today's health summary", section: 'Health' },
  { id: 'feeds_digest',          label: 'Feed digest',           section: 'Feeds' },
  { id: 'pm2_status',            label: 'PM2 status',            section: 'System' },
  { id: 'pm2_restart',           label: 'Restart a PM2 process', section: 'System', destructive: true },
  { id: 'daily_log_read',        label: "Read today's log",      section: 'Brain' },
  { id: 'daily_log_append',      label: 'Append to daily log',   section: 'Brain' },
  { id: 'time_now',              label: 'Current time',          section: 'System' },
];

const PALETTE_ACTION_IDS = new Set(PALETTE_ACTIONS.map((a) => a.id));

// Enrich action metadata with live schema from the voice tool registry. The
// palette fuzzy-matches on the description the LLM sees; lifting it from the
// same source keeps palette and voice hints in sync.
const buildActionManifest = () => {
  const specs = getToolSpecs();
  const byName = Object.fromEntries(specs.map((s) => [s.function.name, s.function]));
  return PALETTE_ACTIONS.map((a) => {
    const fn = byName[a.id];
    return {
      ...a,
      description: fn?.description || '',
      parameters: fn?.parameters || { type: 'object', properties: {} },
    };
  });
};

router.get('/manifest', asyncHandler(async (_req, res) => {
  res.json({
    nav: NAV_COMMANDS,
    actions: buildActionManifest(),
  });
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
  // Palette calls are fire-and-forget for side effects — we don't have a
  // live voice context, so UI-driving sideEffects (navigate/dictation) that
  // some tools push would be lost. The whitelist above already excludes the
  // tools that rely on them; passing a throwaway buffer here is defensive.
  const ctx = { sideEffects: [] };
  const result = await dispatchTool(id, args, ctx);
  res.json({ ok: result?.ok !== false, result });
}));

export default router;
