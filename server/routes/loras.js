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
import { deepMerge, isPlainObject } from '../lib/objects.js';
import { emptyToUndefined, validateRequest } from '../lib/validation.js';
import {
  deleteLora,
  getLora,
  installFromCivitai,
  installFromHuggingface,
  listLoras,
  patchLoraSidecar,
} from '../services/loras.js';
import { getSuggestions, searchLorasInFamily } from '../services/civitaiSuggestions.js';
import { getVideoSuggestions } from '../services/videoLoraSuggestions.js';
import { findLorasByCharacter } from '../services/characterLoraResolver.js';
import { getSettings, updateSettingsWith } from '../services/settings.js';
import { RUNNER_FAMILIES, VIDEO_LORA_FAMILIES } from '../lib/runners.js';
import { openSseStream } from '../lib/sseDownload.js';

const router = Router();

router.get('/', asyncHandler(async (_req, res) => {
  res.json(await listLoras());
}));

// LoRA suggestions — Civitai image LoRAs per runner family (mflux / flux2 /
// z-image / ernie …) PLUS a curated list of HuggingFace video LoRAs. Cached
// server-side for 1h. `?force=1` busts both caches for a manual refresh.
// Default 4 cards per family — enough to show breadth without overwhelming the
// panel; users can paste a URL for anything specific.
router.get('/suggestions', asyncHandler(async (req, res) => {
  const force = req.query.force === '1' || req.query.force === 'true';
  const limit = Math.max(1, Math.min(24, Number(req.query.limit) || 4));
  const [civitai, video] = await Promise.all([
    getSuggestions({ force, limit }),
    getVideoSuggestions({ force }),
  ]);
  res.json({ ...civitai, video });
}));

// Live keyword search + cursor pagination within one runner family. Backs the
// per-category search box and "Load more" button on /media/loras. Uncached —
// results are query/cursor-specific. `query` blank = top ranking for that
// family (so "Load more" with no keyword just pages the leaderboard).
const searchQuerySchema = z.object({
  runner: z.enum(Object.values(RUNNER_FAMILIES)),
  // emptyToUndefined: a blank box (`query=`) is a valid "top ranking" request,
  // not a validation error — coerce '' → undefined before the optional check.
  query: z.preprocess(emptyToUndefined, z.string().max(120).optional()),
  cursor: z.preprocess(emptyToUndefined, z.string().max(512).optional()),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
router.get('/search', asyncHandler(async (req, res) => {
  const { runner, query, cursor, limit } = validateRequest(searchQuerySchema, req.query);
  res.json(await searchLorasInFamily({
    runnerFamily: runner,
    query: query || '',
    cursor: cursor || null,
    limit: limit || 12,
  }));
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
  const { apiKey } = validateRequest(authPostSchema, req.body);
  // Shared deepMerge so future civitai sub-fields don't get clobbered by
  // updateSettings' shallow-merge contract (see lib/objects.js). Runs inside the
  // settings write queue so a concurrent save can't clobber it with a stale base.
  await updateSettingsWith((current) => deepMerge(current, { civitai: { apiKey: apiKey.trim() } }));
  res.json({ hasKey: true, source: 'settings' });
}));

router.delete('/auth/civitai', asyncHandler(async (_req, res) => {
  await updateSettingsWith((current) => {
    const next = { ...current };
    // typeof === 'object' is true for arrays — guard explicitly so a
    // legacy/malformed `civitai: ['x']` value doesn't get spread into
    // `{ '0': 'x', apiKey: undefined }`.
    if (isPlainObject(next.civitai)) {
      const { apiKey: _omit, ...rest } = next.civitai;
      next.civitai = rest;
    }
    return next;
  });
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
  const data = validateRequest(installSchema, req.body);
  const sidecar = await installFromCivitai(data);
  res.status(201).json(sidecar);
}));

// Install a video LoRA from a HuggingFace repo (fal / Lightricks LTX LoRAs).
// `family` is an optional override; absence auto-detects from the repo.
const hfInstallSchema = z.object({
  url: z.string().min(1).max(1024),
  family: z.enum(Object.values(VIDEO_LORA_FAMILIES)).optional(),
  // One-shot token override; absence falls back to the stored/env/CLI HF token.
  token: z.string().min(1).max(256).optional(),
});
router.post('/install/huggingface', asyncHandler(async (req, res) => {
  const data = validateRequest(hfInstallSchema, req.body);
  const sidecar = await installFromHuggingface(data);
  res.status(201).json(sidecar);
}));

// Streaming variant of the HF install for the manager UI. Same install, but
// emits byte-level download `progress` frames over SSE so the form can show a
// percentage instead of a static "Downloading…" (matching the image/video
// model download badge UX). EventSource is GET-only, so url/family ride in the
// query string; the HF token always comes from settings/env (never the query,
// to keep it out of URLs and access logs). Terminal frames:
// `{type:'complete', sidecar}` or `{type:'error', message, code}` — the client
// re-uses `code` (e.g. HF_UNKNOWN_FAMILY) to drive the inline family-confirm
// retry, exactly as the POST path's thrown error does.
const hfInstallStreamSchema = z.object({
  url: z.string().min(1).max(1024),
  family: z.enum(Object.values(VIDEO_LORA_FAMILIES)).optional(),
});
router.get('/install/huggingface/stream', asyncHandler(async (req, res) => {
  const data = validateRequest(hfInstallStreamSchema, req.query);
  const { send, safeEnd } = openSseStream(res);
  // Headers are already flushed once the stream is open, so an install failure
  // must NOT bubble to the error middleware (it would try to re-set status on a
  // committed response). Catch and forward as an SSE `error` frame instead —
  // the sanctioned SSE-boundary exception to the no-try/catch rule.
  // On client disconnect (tab close, navigation, dropped connection) actually
  // ABORT the download via the controller — not just suppress frames — so a
  // multi-GB LoRA transfer doesn't keep running unwatched and a retry can't race
  // a still-in-flight install.
  const controller = new AbortController();
  let aborted = false;
  req.on('close', () => { aborted = true; controller.abort(); });
  await installFromHuggingface(data, {
    signal: controller.signal,
    onProgress: ({ received, total }) => {
      if (aborted) return;
      send({ type: 'progress', received, total, progress: total > 0 ? received / total : null });
    },
  })
    .then((sidecar) => { if (!aborted) send({ type: 'complete', sidecar }); })
    .catch((err) => {
      if (!aborted) send({ type: 'error', message: err?.message || 'HuggingFace install failed', code: err?.code || null });
    });
  safeEnd();
}));

// Trained LoRAs linked to a universe character — used by the character card
// chip in the universe editor + catalog detail page. 2-segment path keeps it
// off the `/:filename` wildcard below.
const byCharacterSchema = z.object({
  entryId: z.preprocess(emptyToUndefined, z.string().max(128).optional()),
  ingredientId: z.preprocess(emptyToUndefined, z.string().max(128).optional()),
}).refine((q) => q.entryId || q.ingredientId, { message: 'entryId or ingredientId required' });
router.get('/by-character', asyncHandler(async (req, res) => {
  const { entryId, ingredientId } = validateRequest(byCharacterSchema, req.query);
  res.json(await findLorasByCharacter({ entryId: entryId || null, ingredientId: ingredientId || null }));
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
  const patch = validateRequest(patchSchema, req.body);
  const next = await patchLoraSidecar(req.params.filename, patch);
  res.json(next);
}));

router.delete('/:filename', asyncHandler(async (req, res) => {
  res.json(await deleteLora(req.params.filename));
}));

export default router;
