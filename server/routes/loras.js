/**
 * LoRA management routes.
 *
 * REST surface for the `/models/loras` manager UI. The legacy delete
 * endpoint at `DELETE /api/image-video/models/lora/:filename` is kept for
 * backward compat (the Models page still calls it); the new manager uses
 * these endpoints exclusively so it can also surface Civitai metadata.
 */

import {
  forceQuerySchema,
  suggestionsQuerySchema,
  searchQuerySchema,
  videoSearchQuerySchema,
  authPostSchema,
  installSchema,
  installPreflightSchema,
  hfInstallStreamSchema,
  byCharacterSchema,
  patchSchema,
} from '../lib/lorasValidation.js';
import { Router } from 'express';
import { paginationQuerySchema, isPaginationRequested, paginateArray, parsePagination } from '../lib/queryValidation.js';
import { asyncHandler } from '../lib/errorHandler.js';
import { deepMerge, isPlainObject } from '../lib/objects.js';
import { validateRequest } from '../lib/validateRequest.js';
import {
  deleteLora,
  getLora,
  installFromCivitai,
  installFromHuggingface,
  previewCivitaiInstall,
  previewHuggingfaceInstall,
  listLoras,
  patchLoraSidecar,
} from '../services/loras.js';
import { probeLoraEffect } from '../services/loraEffectProbe.js';
import { getSuggestions, searchLorasInFamily } from '../services/civitaiSuggestions.js';
import { getVideoSuggestions, searchVideoLoras } from '../services/videoLoraSuggestions.js';
import { findLorasByCharacter } from '../services/characterLoraResolver.js';
import { getSettings, updateSettingsWith } from '../services/settings.js';
import { openSseStream } from '../lib/sseDownload.js';

const router = Router();

// `?force=1` / `?force=true` busts a server-side cache. Shared by the suggestions
// refresh and the LoRA effect re-check so the two can't drift on what counts.
const forceRequested = (query) => query.force === '1' || query.force === 'true';

// Backward-compatible by default: returns the full LoRA array. When a client
// passes `limit`/`offset`, the response becomes the bounded
// `{ items, total, limit, offset }` envelope every paginated PortOS list shares.
router.get('/', asyncHandler(async (req, res) => {
  const query = validateRequest(paginationQuerySchema, req.query);
  const loras = await listLoras();
  if (!isPaginationRequested(query)) {
    return res.json(loras);
  }
  res.json(paginateArray(loras, query, { defaultLimit: 50, maxLimit: 500 }));
}));

// LoRA suggestions — Civitai image LoRAs per runner family (mflux / flux2 /
// z-image / ernie …) PLUS a curated list of HuggingFace video LoRAs. Cached
// server-side for 1h. `?force=1` busts both caches for a manual refresh.
// Default 4 cards per family — enough to show breadth without overwhelming the
// panel; users can paste a URL for anything specific.
router.get('/suggestions', asyncHandler(async (req, res) => {
  const query = validateRequest(suggestionsQuerySchema, req.query);
  const force = forceRequested(query);
  const { limit } = parsePagination(query, { defaultLimit: 4, maxLimit: 24 });
  const [civitai, video] = await Promise.all([
    getSuggestions({ force, limit }),
    getVideoSuggestions({ force }),
  ]);
  res.json({ ...civitai, video });
}));

router.get('/search', asyncHandler(async (req, res) => {
  const { runner, query, cursor, limit } = validateRequest(searchQuerySchema, req.query);
  res.json(await searchLorasInFamily({
    runnerFamily: runner,
    query: query || '',
    cursor: cursor || null,
    limit: limit || 12,
  }));
}));

router.get('/search/video', asyncHandler(async (req, res) => {
  const { family, query, author, cursor, limit } = validateRequest(videoSearchQuerySchema, req.query);
  res.json(await searchVideoLoras({
    family: family && family !== 'all' ? family : null,
    query: query || '',
    author: author || '',
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

router.post('/install', asyncHandler(async (req, res) => {
  const data = validateRequest(installSchema, req.body);
  const sidecar = await installFromCivitai(data);
  res.status(201).json(sidecar);
}));

router.post('/install/preflight', asyncHandler(async (req, res) => {
  const data = validateRequest(installPreflightSchema, req.body);
  const preview = data.source === 'huggingface'
    ? await previewHuggingfaceInstall(data)
    : await previewCivitaiInstall(data);
  res.json(preview);
}));

router.post('/install/huggingface/stream', asyncHandler(async (req, res) => {
  const data = validateRequest(hfInstallStreamSchema, req.body);
  const { send, safeEnd } = openSseStream(res);
  // Headers are already flushed once the stream is open, so an install failure
  // must NOT bubble to the error middleware (it would try to re-set status on a
  // committed response). Catch and forward as an SSE `error` frame instead —
  // the sanctioned SSE-boundary exception to the no-try/catch rule.
  // On client disconnect (tab close, navigation, dropped connection) actually
  // ABORT the download via the controller — not just suppress frames — so a
  // multi-GB LoRA transfer doesn't keep running unwatched and a retry can't race
  // a still-in-flight install. Listen on RES, not REQ: this is a POST, and the
  // request stream emits 'close' the instant its body is fully read (Node
  // auto-destroys the consumed readable) — that is NOT a disconnect and would
  // wrongly abort every install. `res` 'close' while the response is not yet
  // finished is the true "client went away" signal; after a normal safeEnd()
  // it fires with writableEnded already true and is a harmless no-op.
  const controller = new AbortController();
  let aborted = false;
  res.on('close', () => {
    if (!res.writableEnded) { aborted = true; controller.abort(); }
  });
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

router.get('/by-character', asyncHandler(async (req, res) => {
  const { entryId, ingredientId } = validateRequest(byCharacterSchema, req.query);
  res.json(await findLorasByCharacter({ entryId: entryId || null, ingredientId: ingredientId || null }));
}));

router.get('/:filename', asyncHandler(async (req, res) => {
  const lora = await getLora(req.params.filename);
  res.json(lora);
}));

// Adapter-effect diagnostic (#4872) — the explicit, user-triggered inspection
// path. Answers "does this LoRA actually change anything" by measuring the
// rank matrices in the file, so a dead adapter is caught here rather than after
// a multi-minute video render. Deliberately a POST: it spawns a Python child
// and writes the measurement back to the sidecar, so it is not a cacheable GET.
// `?force=1` re-measures instead of returning the stored report. Never 500s on
// a probe failure — an unmeasurable verdict is a legitimate answer about this
// machine, and the response carries its reason.
router.post('/:filename/effect', asyncHandler(async (req, res) => {
  const force = forceRequested(validateRequest(forceQuerySchema, req.query));
  res.json(await probeLoraEffect(req.params.filename, { force }));
}));

router.patch('/:filename', asyncHandler(async (req, res) => {
  const patch = validateRequest(patchSchema, req.body);
  const next = await patchLoraSidecar(req.params.filename, patch);
  res.json(next);
}));

router.delete('/:filename', asyncHandler(async (req, res) => {
  res.json(await deleteLora(req.params.filename));
}));

export default router;
