/**
 * Writers Room routes — folder/work CRUD, draft body I/O, version snapshots,
 * exercise sessions. AI analysis + Creative Director handoff land in Phase 2/3.
 */

import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import {
  validateRequest,
  writersRoomFolderCreateSchema,
  writersRoomWorkCreateSchema,
  writersRoomWorkUpdateSchema,
  writersRoomDraftSaveSchema,
  writersRoomSnapshotSchema,
  writersRoomExerciseCreateSchema,
  writersRoomExerciseFinishSchema,
} from '../lib/validation.js';
import {
  listFolders, createFolder, deleteFolder,
  listWorks, getWorkWithBody, createWork, updateWork, deleteWork,
  saveDraftBody, snapshotDraft, setActiveDraft, getDraftBody,
  listExercises, createExercise, finishExercise, discardExercise,
} from '../services/writersRoom/local.js';

const router = Router();

// ---------- folders ----------

router.get('/folders', asyncHandler(async (_req, res) => {
  res.json(await listFolders());
}));

router.post('/folders', asyncHandler(async (req, res) => {
  const data = validateRequest(writersRoomFolderCreateSchema, req.body);
  res.status(201).json(await createFolder(data));
}));

router.delete('/folders/:id', asyncHandler(async (req, res) => {
  res.json(await deleteFolder(req.params.id));
}));

// ---------- works ----------

router.get('/works', asyncHandler(async (_req, res) => {
  res.json(await listWorks());
}));

router.post('/works', asyncHandler(async (req, res) => {
  const data = validateRequest(writersRoomWorkCreateSchema, req.body);
  res.status(201).json(await createWork(data));
}));

router.get('/works/:id', asyncHandler(async (req, res) => {
  const { manifest, body } = await getWorkWithBody(req.params.id);
  res.json({ ...manifest, activeDraftBody: body });
}));

router.patch('/works/:id', asyncHandler(async (req, res) => {
  const data = validateRequest(writersRoomWorkUpdateSchema, req.body);
  res.json(await updateWork(req.params.id, data));
}));

router.delete('/works/:id', asyncHandler(async (req, res) => {
  res.json(await deleteWork(req.params.id));
}));

// ---------- draft body / versions ----------

router.put('/works/:id/draft', asyncHandler(async (req, res) => {
  const { body } = validateRequest(writersRoomDraftSaveSchema, req.body);
  const { manifest, body: persisted } = await saveDraftBody(req.params.id, body);
  res.json({ ...manifest, activeDraftBody: persisted });
}));

router.post('/works/:id/versions', asyncHandler(async (req, res) => {
  const data = validateRequest(writersRoomSnapshotSchema, req.body || {});
  res.status(201).json(await snapshotDraft(req.params.id, data));
}));

router.patch('/works/:id/versions/:draftId', asyncHandler(async (req, res) => {
  // Only one operation supported here today: set the active draft pointer.
  // Routes stays a PATCH so future label/contentHash updates can land cleanly.
  res.json(await setActiveDraft(req.params.id, req.params.draftId));
}));

router.get('/works/:id/versions/:draftId', asyncHandler(async (req, res) => {
  const body = await getDraftBody(req.params.id, req.params.draftId);
  res.json({ id: req.params.draftId, body });
}));

// ---------- exercises ----------

router.get('/exercises', asyncHandler(async (req, res) => {
  res.json(await listExercises({ workId: req.query.workId || undefined }));
}));

router.post('/exercises', asyncHandler(async (req, res) => {
  const data = validateRequest(writersRoomExerciseCreateSchema, req.body || {});
  res.status(201).json(await createExercise(data));
}));

router.post('/exercises/:id/finish', asyncHandler(async (req, res) => {
  const data = validateRequest(writersRoomExerciseFinishSchema, req.body || {});
  res.json(await finishExercise(req.params.id, data));
}));

router.post('/exercises/:id/discard', asyncHandler(async (req, res) => {
  res.json(await discardExercise(req.params.id));
}));

export default router;
