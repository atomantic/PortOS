/**
 * World Builder Routes
 *
 *   GET    /api/world-builder                        → World[]
 *   POST   /api/world-builder                        → World
 *   GET    /api/world-builder/:id                    → World
 *   PATCH  /api/world-builder/:id                    → World
 *   DELETE /api/world-builder/:id                    → { id }
 *   POST   /api/world-builder/expand                 → { stylePrompt, negativePrompt, categories, llm }
 *   POST   /api/world-builder/:id/render             → { runId, collectionId, jobIds, promptCount }
 *   GET    /api/world-builder/:id/runs               → Run[]
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import * as svc from '../services/worldBuilder.js';
import { expandWorldTemplate } from '../services/worldBuilderExpand.js';
import { enqueueJob } from '../services/mediaJobQueue/index.js';
import { getSettings } from '../services/settings.js';
import { createCollection, NAME_MAX_LENGTH as COLLECTION_NAME_MAX } from '../services/mediaCollections.js';
import { getImageModels, isFlux2 } from '../lib/mediaModels.js';

const router = Router();

const SERVICE_ERROR_STATUS = {
  [svc.ERR_NOT_FOUND]: 404,
  [svc.ERR_VALIDATION]: 400,
};

const mapServiceError = (err) => {
  const status = SERVICE_ERROR_STATUS[err?.code];
  if (status) return new ServerError(err.message, { status, code: err.code });
  return err;
};

// ---- shared zod fragments ----
const variationSchema = z.object({
  label: z.string().trim().min(1).max(svc.VARIATION_LABEL_MAX),
  prompt: z.string().trim().min(1).max(svc.PROMPT_FRAGMENT_MAX),
});
const categoryShape = z.object({
  variations: z.array(variationSchema).max(svc.VARIATIONS_PER_CATEGORY_MAX),
}).optional();
const categoriesSchema = z.object(
  Object.fromEntries(svc.WORLD_CATEGORIES.map((c) => [c, categoryShape])),
).partial();

const llmSchema = z.object({
  provider: z.string().trim().max(80).nullable().optional(),
  model: z.string().trim().max(200).nullable().optional(),
}).optional();

const createSchema = z.object({
  name: z.string().trim().min(1).max(svc.NAME_MAX_LENGTH),
  starterPrompt: z.string().trim().max(svc.STARTER_PROMPT_MAX).optional().default(''),
  stylePrompt: z.string().trim().max(svc.PROMPT_FRAGMENT_MAX).optional().default(''),
  negativePrompt: z.string().trim().max(svc.PROMPT_FRAGMENT_MAX).optional().default(''),
  categories: categoriesSchema.optional(),
  llm: llmSchema,
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(svc.NAME_MAX_LENGTH).optional(),
  starterPrompt: z.string().trim().max(svc.STARTER_PROMPT_MAX).optional(),
  stylePrompt: z.string().trim().max(svc.PROMPT_FRAGMENT_MAX).optional(),
  negativePrompt: z.string().trim().max(svc.PROMPT_FRAGMENT_MAX).optional(),
  categories: categoriesSchema.optional(),
  llm: llmSchema,
}).refine((p) => Object.keys(p).length > 0, { message: 'patch must include at least one field' });

const expandSchema = z.object({
  starterPrompt: z.string().trim().min(1).max(svc.STARTER_PROMPT_MAX),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
});

// `selection` per category: 'all' or array of variation labels.
const selectionValueSchema = z.union([z.literal('all'), z.array(z.string().trim().min(1).max(svc.VARIATION_LABEL_MAX)).max(svc.VARIATIONS_PER_CATEGORY_MAX)]);
const selectionSchema = z.object(
  Object.fromEntries(svc.WORLD_CATEGORIES.map((c) => [c, selectionValueSchema.optional()])),
).partial();

const renderSchema = z.object({
  // Optional friendly name for the resulting collection. If omitted, server
  // synthesizes "World: <name> (timestamp)".
  collectionName: z.string().trim().min(1).max(COLLECTION_NAME_MAX).optional(),
  // Image-gen knobs — these mirror /api/image-gen/generate so the user can
  // pick mode/size/steps without bouncing to the Image page first.
  mode: z.enum(['external', 'local', 'codex']).optional(),
  modelId: z.string().trim().max(64).optional(),
  width: z.number().int().min(64).max(2048).optional(),
  height: z.number().int().min(64).max(2048).optional(),
  steps: z.number().int().min(1).max(150).optional(),
  cfgScale: z.number().min(0).max(30).optional(),
  guidance: z.number().min(0).max(30).optional(),
  // Per-variation render count and per-category subset.
  batchPerVariation: z.number().int().min(1).max(20).optional().default(1),
  selection: selectionSchema.optional(),
});

router.get('/', asyncHandler(async (_req, res) => {
  res.json(await svc.listWorlds());
}));

router.post('/', asyncHandler(async (req, res) => {
  const body = validateRequest(createSchema, req.body ?? {});
  res.status(201).json(await svc.createWorld(body));
}));

// `expand` is a sub-resource — keep it ahead of `/:id` so the wildcard
// doesn't catch "expand" as a world id.
router.post('/expand', asyncHandler(async (req, res) => {
  const body = validateRequest(expandSchema, req.body ?? {});
  const result = await expandWorldTemplate(body);
  res.json(result);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const w = await svc.getWorld(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(w);
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const body = validateRequest(patchSchema, req.body ?? {});
  const w = await svc.updateWorld(req.params.id, body).catch((err) => { throw mapServiceError(err); });
  res.json(w);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const r = await svc.deleteWorld(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(r);
}));

router.get('/:id/runs', asyncHandler(async (req, res) => {
  res.json(await svc.listRuns(req.params.id));
}));

router.post('/:id/render', asyncHandler(async (req, res) => {
  const body = validateRequest(renderSchema, req.body ?? {});
  const world = await svc.getWorld(req.params.id).catch((err) => { throw mapServiceError(err); });

  const compiled = svc.compilePrompts(world, {
    selection: body.selection,
    batchPerVariation: body.batchPerVariation,
  });
  if (!compiled.length) {
    throw new ServerError('No prompts to render — add variations or expand the template first', {
      status: 400, code: 'WORLD_BUILDER_EMPTY',
    });
  }

  const settings = await getSettings();
  const mode = body.mode || settings.imageGen?.mode || 'external';

  // Reject `external` mode upfront — batch rendering against a remote SD-API
  // would block this request for the entire batch, and we don't want to leave
  // an orphaned media collection behind when we discover this mid-loop below.
  if (mode !== 'local' && mode !== 'codex') {
    throw new ServerError(
      'Batch render requires local or codex mode — switch image-gen mode in Settings → Image Gen',
      { status: 400, code: 'WORLD_BUILDER_EXTERNAL_UNSUPPORTED' },
    );
  }

  // Mirror the upfront validation /api/image-gen/generate does so a doomed
  // batch fails before any jobs land in the queue.
  if (mode === 'codex' && !settings.imageGen?.codex?.enabled) {
    throw new ServerError(
      'Codex Imagegen is disabled — enable it in Settings → Image Gen first',
      { status: 400, code: 'CODEX_IMAGEGEN_DISABLED' },
    );
  }
  if (mode === 'local') {
    const py = settings.imageGen?.local?.pythonPath || null;
    const allModels = getImageModels();
    if (body.modelId && !allModels.some((m) => m.id === body.modelId)) {
      throw new ServerError(`Unknown modelId: ${body.modelId}`, { status: 400, code: 'IMAGE_GEN_UNKNOWN_MODEL' });
    }
    const selectedModel = allModels.find((m) => m.id === body.modelId)
      ?? allModels.find((m) => m.id === 'dev')
      ?? allModels[0];
    if (selectedModel && !isFlux2(selectedModel) && !py) {
      throw new ServerError(
        'Local image generation is not configured (settings.imageGen.local.pythonPath is missing).',
        { status: 400, code: 'IMAGE_GEN_NOT_CONFIGURED' },
      );
    }
  }

  // Provision the collection up front so renders can be tagged as they
  // complete. The completion hook (worldBuilderCollectionHook) will add
  // each finished image's filename to this collection.
  const collectionName = body.collectionName?.trim()
    || `World: ${world.name} — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
  const collection = await createCollection({
    name: collectionName.slice(0, COLLECTION_NAME_MAX),
    description: `World Builder run for "${world.name}" (${compiled.length} prompts)`,
  });

  const runId = randomUUID();
  const jobIds = [];
  // Map cfgScale → guidance the same way /api/image-gen/generate does. The
  // mediaJobQueue calls imageGen/local.generateImage() directly (not the
  // dispatcher), so without this mapping the World Builder UI's CFG control
  // would silently no-op for local renders.
  const guidance = body.guidance ?? body.cfgScale;
  const baseParams = {
    width: body.width,
    height: body.height,
    steps: body.steps,
    cfgScale: body.cfgScale,
    guidance,
  };

  for (const item of compiled) {
    const params = {
      ...baseParams,
      prompt: item.prompt,
      negativePrompt: item.negativePrompt || undefined,
      // Tag every job so the completion hook can route the result back
      // into the run's collection without us having to thread additional
      // arguments through the queue.
      worldRun: {
        runId,
        worldId: world.id,
        collectionId: collection.id,
        category: item.category,
        label: item.label,
      },
    };
    if (mode === 'codex') {
      const c = settings.imageGen?.codex || {};
      const queued = enqueueJob({
        kind: 'image',
        params: { mode: 'codex', codexPath: c.codexPath, model: c.model, ...params },
      });
      jobIds.push(queued.jobId);
      continue;
    }
    // mode === 'local' (validated upfront).
    const py = settings.imageGen?.local?.pythonPath || null;
    const queued = enqueueJob({
      kind: 'image',
      params: { pythonPath: py, modelId: body.modelId, ...params },
    });
    jobIds.push(queued.jobId);
  }

  const run = await svc.recordRun({
    id: runId,
    worldId: world.id,
    collectionId: collection.id,
    jobIds,
    promptCount: compiled.length,
    createdAt: new Date().toISOString(),
  });

  console.log(`🌍 World Builder render — world=${world.name} prompts=${compiled.length} mode=${mode} runId=${runId.slice(0, 8)}`);

  res.json({
    runId: run.id,
    collectionId: collection.id,
    collectionName: collection.name,
    promptCount: compiled.length,
    jobIds,
    mode,
  });
}));

export default router;
