/**
 * Blender Models (#17874): records, the authored src/ workspace, builds, publishing and the published GLB.
 *
 * Every write here (source writes, builds, publish, open in Blender) needs operator authority through the
 * default-deny host-control gate, like the film routes; builds also need Blender in Trusted local mode (409).
 */
import { Router } from 'express';
import { createReadStream } from 'node:fs';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { streamAttachment } from '../lib/streamAttachment.js';
import { validateRequest } from '../lib/validateRequest.js';
import {
  blenderModelBuildSchema, blenderModelFileQuerySchema, blenderModelFileWriteSchema, blenderModelPublishSchema,
  blenderModelWorkspaceSchema, createBlenderModelSchema, patchBlenderModelSchema,
} from '../lib/blenderModelsValidation.js';

const router = Router();
const models = () => import('../services/blenderModels/models.js');
const builds = () => import('../services/blenderModels/build.js');

router.get('/', asyncHandler(async (_req, res) => {
  const { listBlenderModels } = await models();
  res.json({ models: await listBlenderModels() });
}));

router.post('/', asyncHandler(async (req, res) => {
  const input = validateRequest(createBlenderModelSchema, req.body ?? {});
  const { createBlenderModel, getBlenderModelState } = await models();
  const model = await createBlenderModel(input);
  res.status(201).json(await getBlenderModelState(model.id));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const { getBlenderModelState } = await models();
  res.json(await getBlenderModelState(req.params.id));
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const input = validateRequest(patchBlenderModelSchema, req.body ?? {});
  const { renameBlenderModel } = await models();
  res.json(await renameBlenderModel(req.params.id, input));
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const { deleteBlenderModel } = await models();
  res.json(await deleteBlenderModel(req.params.id));
}));

router.post('/:id/workspace', asyncHandler(async (req, res) => {
  validateRequest(blenderModelWorkspaceSchema, req.body ?? {});
  const { scaffoldBlenderModelWorkspace } = await models();
  res.status(201).json(await scaffoldBlenderModelWorkspace(req.params.id));
}));

router.get('/:id/files', asyncHandler(async (req, res) => {
  const { listBlenderModelFiles } = await models();
  res.json(await listBlenderModelFiles(req.params.id));
}));

router.get('/:id/file', asyncHandler(async (req, res) => {
  const { path } = validateRequest(blenderModelFileQuerySchema, req.query);
  const { readBlenderModelFile } = await models();
  res.json(await readBlenderModelFile(req.params.id, path));
}));

router.put('/:id/file', asyncHandler(async (req, res) => {
  const { path, content } = validateRequest(blenderModelFileWriteSchema, req.body ?? {});
  const { writeBlenderModelFile } = await models();
  res.json(await writeBlenderModelFile(req.params.id, path, content));
}));

router.delete('/:id/file', asyncHandler(async (req, res) => {
  const { path } = validateRequest(blenderModelFileQuerySchema, req.query);
  const { deleteBlenderModelFile } = await models();
  res.json(await deleteBlenderModelFile(req.params.id, path));
}));

// The model's own Python may run for minutes: a build is a job, not a held request.
router.post('/:id/builds', asyncHandler(async (req, res) => {
  const { quality } = validateRequest(blenderModelBuildSchema, req.body ?? {});
  const { startBlenderModelBuild } = await builds();
  res.status(202).json(await startBlenderModelBuild(req.params.id, { quality }));
}));

router.post('/:id/builds/:buildId/cancel', asyncHandler(async (req, res) => {
  const { requireBlenderModel } = await models();
  const { cancelBlenderModelBuild } = await builds();
  await requireBlenderModel(req.params.id);
  res.json({ ok: cancelBlenderModelBuild(req.params.id, req.params.buildId) });
}));

router.post('/:id/builds/:buildId/open', asyncHandler(async (req, res) => {
  const { openBlenderModelBuild } = await models();
  res.json(await openBlenderModelBuild(req.params.id, req.params.buildId));
}));

// model.glb, model.blend, report.json or build.log of one build, for review before publishing.
router.get('/:id/builds/:buildId/files/:name', asyncHandler(async (req, res) => {
  const { getBlenderModelBuildFile } = await models();
  const { absolute, type } = await getBlenderModelBuildFile(req.params.id, req.params.buildId, req.params.name);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.setHeader('Cache-Control', 'private, no-cache');
  res.type(type);
  res.sendFile(absolute, { dotfiles: 'deny' });
}));

router.post('/:id/publish', asyncHandler(async (req, res) => {
  const { buildId } = validateRequest(blenderModelPublishSchema, req.body ?? {});
  const { publishBlenderModelBuild } = await models();
  res.json(await publishBlenderModelBuild(req.params.id, buildId));
}));

router.get('/:id/asset', asyncHandler(async (req, res) => {
  const { getBlenderModelAsset } = await models();
  const { absolute, filename } = await getBlenderModelAsset(req.params.id);
  streamAttachment(res, createReadStream(absolute), {
    filename,
    contentType: 'model/gltf-binary',
    failure: new ServerError('Model file not found', { status: 404, code: 'ASSET_MISSING' }),
    label: 'Blender model asset',
  });
}));

export default router;
