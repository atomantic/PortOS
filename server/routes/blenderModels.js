/**
 * Blender Models (#17874): records, the authored src/ workspace, builds, publishing and the published GLB.
 *
 * Every write here (source writes, builds, publish, open in Blender) needs operator authority through the
 * default-deny host-control gate, like the film routes; builds also need Blender in Trusted local mode (409).
 */
import { Router } from 'express';
import { createReadStream } from 'node:fs';
import { assertCancelResult } from '../lib/cancelResponse.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { streamAttachment } from '../lib/streamAttachment.js';
import { validateRequest } from '../lib/validateRequest.js';
import {
  createBlenderModelCameraSchema, createBlenderModelDifferenceSchema, patchBlenderModelCameraSchema, patchBlenderModelDifferenceSchema,
  blenderModelBuildSchema, blenderModelReviewSchema, blenderModelFileQuerySchema, blenderModelFileWriteSchema, blenderModelPublishSchema,
  blenderModelCloseupSchema, blenderModelPartsBriefSchema, blenderModelReferenceImageSchema, blenderModelReferenceReviewSchema,
  blenderModelReferenceSourceSchema, blenderModelReferenceWordsSchema, blenderModelWorkspaceSchema, createBlenderModelSchema, patchBlenderModelSchema,
} from '../lib/blenderModelsValidation.js';

const router = Router();
const models = () => import('../services/blenderModels/models.js');
const references = () => import('../services/blenderModels/references.js');
const builds = () => import('../services/blenderModels/build.js');
const bakes = () => import('../services/blenderModels/bake.js');
const reviews = () => import('../services/blenderModels/review.js');
const compare = () => import('../services/blenderModels/compare.js');

router.get('/', asyncHandler(async (_req, res) => {
  const { listBlenderModels } = await models();
  res.json(await listBlenderModels());
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
  const { updateBlenderModel } = await models();
  res.json(await updateBlenderModel(req.params.id, input));
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
  res.json(assertCancelResult(cancelBlenderModelBuild(req.params.id, req.params.buildId), { notFoundMessage: 'Blender model build job not found' }));
}));

// One set's bake while a full build runs; canceling it ends that build, and an earlier build's baked set stays as it was.
router.post('/:id/builds/:buildId/bakes/:setId/cancel', asyncHandler(async (req, res) => {
  const { requireBlenderModel } = await models();
  const { cancelBlenderModelBake } = await bakes();
  await requireBlenderModel(req.params.id);
  res.json(assertCancelResult(cancelBlenderModelBake(req.params.id, req.params.buildId, req.params.setId), { notFoundMessage: 'Blender model bake job not found' }));
}));

router.post('/:id/builds/:buildId/open', asyncHandler(async (req, res) => {
  const { openBlenderModelBuild } = await models();
  res.json(await openBlenderModelBuild(req.params.id, req.params.buildId));
}));

function sendWorkspaceFile(res, { absolute, type }) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.setHeader('Cache-Control', 'private, no-cache');
  res.type(type);
  res.sendFile(absolute, { dotfiles: 'deny' });
}

// model.glb, model.blend, report.json or build.log of one build, for review before publishing.
router.get('/:id/builds/:buildId/files/:name', asyncHandler(async (req, res) => {
  const { getBlenderModelBuildFile } = await models();
  sendWorkspaceFile(res, await getBlenderModelBuildFile(req.params.id, req.params.buildId, req.params.name));
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

// Reference images and the parts brief (#17876). Only POST .../render queues an image job.
const sendState = async (req, res, status = 200) => {
  const { getBlenderModelState } = await models();
  res.status(status).json(await getBlenderModelState(req.params.id));
};

router.patch('/:id/reference-source', asyncHandler(async (req, res) => {
  const patch = validateRequest(blenderModelReferenceSourceSchema, req.body ?? {});
  await (await references()).updateBlenderModelReferenceSource(req.params.id, patch);
  await sendState(req, res);
}));

router.post('/:id/parts-brief', asyncHandler(async (req, res) => {
  validateRequest(blenderModelPartsBriefSchema, req.body ?? {});
  await (await references()).createBlenderModelPartsBrief(req.params.id);
  await sendState(req, res, 201);
}));

router.post('/:id/references', asyncHandler(async (req, res) => {
  const { mechanism } = validateRequest(blenderModelCloseupSchema, req.body ?? {});
  await (await references()).addBlenderModelCloseup(req.params.id, mechanism);
  await sendState(req, res, 201);
}));

router.delete('/:id/references/:referenceId', asyncHandler(async (req, res) => {
  await (await references()).removeBlenderModelCloseup(req.params.id, req.params.referenceId);
  await sendState(req, res);
}));

router.post('/:id/references/:referenceId/preview', asyncHandler(async (req, res) => {
  const input = validateRequest(blenderModelReferenceWordsSchema, req.body ?? {});
  res.json(await (await references()).previewBlenderModelReference(req.params.id, req.params.referenceId, input));
}));

router.post('/:id/references/:referenceId/render', asyncHandler(async (req, res) => {
  const input = validateRequest(blenderModelReferenceWordsSchema, req.body ?? {});
  res.status(202).json(await (await references()).renderBlenderModelReference(req.params.id, req.params.referenceId, input));
}));

router.post('/:id/references/:referenceId/images', asyncHandler(async (req, res) => {
  const { filename } = validateRequest(blenderModelReferenceImageSchema, req.body ?? {});
  await (await references()).useBlenderModelReferenceImage(req.params.id, req.params.referenceId, filename);
  await sendState(req, res, 201);
}));

router.post('/:id/references/:referenceId/images/:imageId/review', asyncHandler(async (req, res) => {
  const input = validateRequest(blenderModelReferenceReviewSchema, req.body ?? {});
  await (await references()).reviewBlenderModelReference(req.params.id, req.params.referenceId, req.params.imageId, input);
  await sendState(req, res);
}));

// Comparing a build with its references (#17877): review renders, cameras and differences.
router.post('/:id/builds/:buildId/review', asyncHandler(async (req, res) => {
  validateRequest(blenderModelReviewSchema, req.body ?? {});
  res.status(202).json(await (await reviews()).startBlenderModelReview(req.params.id, req.params.buildId));
}));

router.post('/:id/builds/:buildId/review/cancel', asyncHandler(async (req, res) => {
  const { requireBlenderModel } = await models();
  await requireBlenderModel(req.params.id);
  res.json(assertCancelResult((await reviews()).cancelBlenderModelReview(req.params.id, req.params.buildId), { notFoundMessage: 'Blender model review job not found' }));
}));

// <view>-<look>.png, sheet-<look>.jpg, review.json or review.log of one build's review.
router.get('/:id/builds/:buildId/review/:name', asyncHandler(async (req, res) => {
  sendWorkspaceFile(res, await (await reviews()).resolveBlenderModelReviewFile(req.params.id, req.params.buildId, req.params.name));
}));

router.post('/:id/cameras', asyncHandler(async (req, res) => {
  const input = validateRequest(createBlenderModelCameraSchema, req.body ?? {});
  await (await compare()).addBlenderModelCamera(req.params.id, input);
  await sendState(req, res, 201);
}));

router.patch('/:id/cameras/:cameraId', asyncHandler(async (req, res) => {
  const input = validateRequest(patchBlenderModelCameraSchema, req.body ?? {});
  await (await compare()).updateBlenderModelCamera(req.params.id, req.params.cameraId, input);
  await sendState(req, res);
}));

router.delete('/:id/cameras/:cameraId', asyncHandler(async (req, res) => {
  await (await compare()).removeBlenderModelCamera(req.params.id, req.params.cameraId);
  await sendState(req, res);
}));

router.post('/:id/differences', asyncHandler(async (req, res) => {
  const input = validateRequest(createBlenderModelDifferenceSchema, req.body ?? {});
  await (await compare()).addBlenderModelDifference(req.params.id, input);
  await sendState(req, res, 201);
}));

router.patch('/:id/differences/:differenceId', asyncHandler(async (req, res) => {
  const input = validateRequest(patchBlenderModelDifferenceSchema, req.body ?? {});
  await (await compare()).updateBlenderModelDifference(req.params.id, req.params.differenceId, input);
  await sendState(req, res);
}));

router.delete('/:id/differences/:differenceId', asyncHandler(async (req, res) => {
  await (await compare()).removeBlenderModelDifference(req.params.id, req.params.differenceId);
  await sendState(req, res);
}));

export default router;
