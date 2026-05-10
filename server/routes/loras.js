/**
 * LoRA management routes.
 *
 * REST surface for the new `/media/loras` manager UI. The legacy delete
 * endpoint at `DELETE /api/image-video/models/lora/:filename` is kept for
 * backward compat (the Models page still calls it); the new manager uses
 * these endpoints exclusively so it can also surface Civitai metadata.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errorHandler.js';
import {
  deleteLora,
  getLora,
  installFromCivitai,
  listLoras,
  patchLoraSidecar,
} from '../services/loras.js';
import { getSuggestions } from '../services/civitaiSuggestions.js';
import { getSettings, saveSettings } from '../services/settings.js';

const router = Router();

router.get('/', asyncHandler(async (_req, res) => {
  res.json(await listLoras());
}));

// Civitai LoRA suggestions per runner family (mflux / flux2 / z-image / ernie).
// Cached server-side for 1h. `?force=1` busts the cache for a manual refresh.
// Default 4 cards per family — that's enough to show breadth without
// overwhelming the panel; users can paste a URL for anything specific.
router.get('/suggestions', asyncHandler(async (req, res) => {
  const force = req.query.force === '1' || req.query.force === 'true';
  const limit = Math.max(1, Math.min(24, Number(req.query.limit) || 4));
  res.json(await getSuggestions({ force, limit }));
}));

// Civitai auth status — returns just whether a key is configured (the key
// itself never leaves the server). The 2-segment path keeps it from
// colliding with the `/:filename` LoRA endpoints below. `source` lets the
// UI explain why a key is in effect (env var vs. saved-in-settings) so the
// user understands whether deleting via the API is meaningful.
router.get('/auth/civitai', asyncHandler(async (_req, res) => {
  const settings = await getSettings();
  const fromSettings = !!(settings?.civitai?.apiKey || '').trim();
  const fromEnv = !!(process.env.CIVITAI_API_KEY || '').trim();
  res.json({
    hasKey: fromSettings || fromEnv,
    source: fromSettings ? 'settings' : (fromEnv ? 'env' : 'none'),
  });
}));

const authPostSchema = z.object({ apiKey: z.string().min(1).max(256) });
router.post('/auth/civitai', asyncHandler(async (req, res) => {
  const { apiKey } = authPostSchema.parse(req.body);
  // Manual deep-merge so future civitai sub-fields don't get clobbered by
  // updateSettings' shallow-merge contract.
  const current = await getSettings();
  await saveSettings({ ...current, civitai: { ...(current.civitai || {}), apiKey: apiKey.trim() } });
  res.json({ hasKey: true, source: 'settings' });
}));

router.delete('/auth/civitai', asyncHandler(async (_req, res) => {
  const current = await getSettings();
  const next = { ...current };
  // typeof === 'object' is true for arrays — guard explicitly so a
  // legacy/malformed `civitai: ['x']` value doesn't get spread into
  // `{ '0': 'x', apiKey: undefined }`.
  if (next.civitai && typeof next.civitai === 'object' && !Array.isArray(next.civitai)) {
    const { apiKey: _omit, ...rest } = next.civitai;
    next.civitai = rest;
  }
  await saveSettings(next);
  // The env var (if set) still wins after a delete — surface that so the
  // UI can explain "you cleared the saved key but CIVITAI_API_KEY is still
  // active in the shell environment."
  const envActive = !!(process.env.CIVITAI_API_KEY || '').trim();
  res.json({ hasKey: envActive, source: envActive ? 'env' : 'none' });
}));

const installSchema = z.object({
  url: z.string().min(1).max(1024),
  // Optional one-shot key override — useful if the user wants to test a
  // restricted LoRA without persisting their key in Settings yet.
  apiKey: z.string().min(1).max(256).optional(),
});

router.post('/install', asyncHandler(async (req, res) => {
  const data = installSchema.parse(req.body);
  const sidecar = await installFromCivitai(data);
  res.status(201).json(sidecar);
}));

router.get('/:filename', asyncHandler(async (req, res) => {
  const lora = await getLora(req.params.filename);
  res.json(lora);
}));

const patchSchema = z.object({
  // Only user-editable fields. Civitai-derived blocks (`civitai`, `file`,
  // `runnerFamily`, `triggerWords`) are not patchable through this surface
  // — the user would have to delete + reinstall to refresh those.
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  recommendedScale: z.number().min(0).max(2).optional(),
  notes: z.string().max(2000).optional(),
});

router.patch('/:filename', asyncHandler(async (req, res) => {
  const patch = patchSchema.parse(req.body);
  const next = await patchLoraSidecar(req.params.filename, patch);
  res.json(next);
}));

router.delete('/:filename', asyncHandler(async (req, res) => {
  res.json(await deleteLora(req.params.filename));
}));

export default router;
