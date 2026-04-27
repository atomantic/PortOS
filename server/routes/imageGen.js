/**
 * Image Generation Routes — works against either the external SD API or the
 * local mflux backend, depending on settings.imageGen.mode.
 *
 * Generic endpoints (status, generate, avatar) go through the dispatcher.
 * Local-mode endpoints (events SSE, gallery, loras, cancel, delete) target
 * the local module directly because their shape doesn't apply to external.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import * as imageGen from '../services/imageGen/index.js';
import { local } from '../services/imageGen/index.js';
import {
  REQUIRED_PACKAGES, detectPython, checkPackages, installPackages,
  isExternallyManaged, createVenv, isAllowedPython,
} from '../lib/pythonSetup.js';
import { PATHS } from '../lib/fileUtils.js';
import { join } from 'node:path';

const router = Router();

const generateSchema = z.object({
  prompt: z.string().min(1).max(2000),
  negativePrompt: z.string().max(2000).optional(),
  modelId: z.string().max(64).optional(),
  width: z.number().int().min(64).max(2048).optional(),
  height: z.number().int().min(64).max(2048).optional(),
  steps: z.number().int().min(1).max(150).optional(),
  cfgScale: z.number().min(0).max(30).optional(),
  guidance: z.number().min(0).max(30).optional(),
  seed: z.number().int().min(0).optional(),
  // mflux supports 3/4/5/6/8 bit quantization; 8 is the default.
  quantize: z.union([z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(8), z.literal('3'), z.literal('4'), z.literal('5'), z.literal('6'), z.literal('8')]).optional(),
  // Filenames only (basenames) — server resolves against PATHS.loras and
  // applies the prefix-check. Old payloads sent absolute server paths
  // (`loraPaths`); accept both for back-compat with stored gallery sidecars.
  loraFilenames: z.array(z.string().max(256).regex(/^[^/\\]+$/, 'lora filename must not contain path separators')).max(8).optional(),
  loraPaths: z.array(z.string().max(512)).max(8).optional(),
  loraScales: z.array(z.number().min(0).max(2)).max(8).optional(),
});

const avatarSchema = z.object({
  name: z.string().max(100).optional(),
  characterClass: z.string().max(100).optional(),
  prompt: z.string().max(2000).optional(),
});

router.get('/status', asyncHandler(async (_req, res) => {
  res.json(await imageGen.checkConnection());
}));

router.get('/active', asyncHandler(async (_req, res) => {
  res.json({ activeJob: await imageGen.getActiveJob() });
}));

router.post('/generate', asyncHandler(async (req, res) => {
  const data = validateRequest(generateSchema, req.body);
  res.json(await imageGen.generateImage(data));
}));

router.post('/avatar', asyncHandler(async (req, res) => {
  const data = validateRequest(avatarSchema, req.body);
  res.json(await imageGen.generateAvatar(data));
}));

// Local-only: list image models and LoRAs the local backend can use.
router.get('/models', (_req, res) => {
  res.json(local.listImageModels());
});

router.get('/loras', asyncHandler(async (_req, res) => {
  res.json(await local.listLoras());
}));

router.get('/gallery', asyncHandler(async (_req, res) => {
  res.json(await local.listGallery());
}));

// SSE progress stream for the local backend. EventSource consumers (the
// ImageGen page) attach here using the jobId returned from POST /generate.
router.get('/:jobId/events', (req, res) => {
  const ok = local.attachSseClient(req.params.jobId, res);
  if (!ok) res.status(404).json({ error: 'Job not found or expired' });
});

router.post('/cancel', (_req, res) => {
  const cancelled = local.cancel();
  res.json({ ok: cancelled });
});

router.delete('/:filename', asyncHandler(async (req, res) => {
  res.json(await local.deleteImage(req.params.filename));
}));

// --- Local-mode setup automation ---

router.get('/setup/python', asyncHandler(async (_req, res) => {
  const path = await detectPython();
  res.json({ path });
}));

const checkSchema = z.object({ pythonPath: z.string().min(1) });

router.get('/setup/check', asyncHandler(async (req, res) => {
  const { pythonPath } = validateRequest(checkSchema, req.query);
  if (!isAllowedPython(pythonPath)) {
    return res.status(400).json({ error: 'pythonPath must be a python interpreter (basename python/python3/python3.NN)' });
  }
  const [pkgs, externallyManaged] = await Promise.all([
    checkPackages(pythonPath),
    isExternallyManaged(pythonPath),
  ]);
  res.json({
    pythonPath,
    externallyManaged,
    required: REQUIRED_PACKAGES,
    ...pkgs,
  });
}));

const venvSchema = z.object({
  basePython: z.string().min(1).optional(),
});

router.post('/setup/create-venv', asyncHandler(async (req, res) => {
  const { basePython } = validateRequest(venvSchema, req.body || {});
  if (basePython && !isAllowedPython(basePython)) {
    return res.status(400).json({ error: 'basePython must be a python interpreter (basename python/python3/python3.NN)' });
  }
  const base = basePython || (await detectPython());
  if (!base) {
    return res.status(400).json({ error: 'No base Python 3 found to bootstrap a venv. Install Python 3.10+ first.' });
  }
  const target = join(PATHS.data, 'python', 'venv');
  const venvPython = await createVenv(base, target);
  res.json({ pythonPath: venvPython, target });
}));

// Allowlist: only PortOS's own required pip names (or their pinned variants
// like `transformers<5`) are installable. Without this, the endpoint would
// happily pip-install arbitrary PyPI packages — the install runs as the
// PortOS user and pip itself executes setup.py from the package, so an
// arbitrary package install is effectively arbitrary code execution.
const REQUIRED_PIP_NAMES = new Set([
  ...REQUIRED_PACKAGES,
  // pip-name variants (see PIP_NAMES in pythonSetup.js)
  'opencv-python',
  'transformers<5',
  // Windows torch path also installs torch + diffusers, which are in
  // REQUIRED_PACKAGES on Windows but not on macOS — keep them allowlisted
  // unconditionally so a Windows install requested from a macOS server
  // (unlikely but possible) doesn't 400 unhelpfully.
  'torch',
  'diffusers',
]);

const installSchema = z.object({
  pythonPath: z.string().min(1),
  packages: z.array(z.string().min(1)).min(1).max(40),
});

// EventSource consumers re-run /setup/check on `complete` to refresh status.
router.get('/setup/install', (req, res) => {
  const pythonPath = req.query.pythonPath;
  const packages = String(req.query.packages || '').split(',').filter(Boolean);
  const parsed = installSchema.safeParse({ pythonPath, packages });
  if (!parsed.success) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: parsed.error.message }));
  }
  if (!isAllowedPython(parsed.data.pythonPath)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'pythonPath must be a python interpreter' }));
  }
  const disallowed = parsed.data.packages.filter((p) => !REQUIRED_PIP_NAMES.has(p));
  if (disallowed.length) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: `Packages not in allowlist: ${disallowed.join(', ')}` }));
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  // `send` and `safeEnd` no-op once the response has ended so a late
  // pip-output line (or the promise.then below) doesn't trigger
  // ERR_STREAM_WRITE_AFTER_END or double-end the response.
  const send = (event) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const safeEnd = () => { if (!res.writableEnded) res.end(); };

  const { promise, kill } = installPackages(parsed.data.pythonPath, parsed.data.packages, send);
  promise.then(safeEnd);

  // Client navigation away should kill pip — a torch upgrade can run for
  // 10+ minutes and would otherwise keep going invisibly.
  req.on('close', () => { kill(); safeEnd(); });
});

export default router;
