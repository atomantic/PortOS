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
  writersRoomAnalysisCreateSchema,
  writersRoomCharacterCreateSchema,
  writersRoomCharacterUpdateSchema,
  writersRoomSettingCreateSchema,
  writersRoomSettingUpdateSchema,
} from '../lib/validation.js';
import {
  listFolders, createFolder, deleteFolder,
  listWorks, getWorkWithBody, createWork, updateWork, deleteWork,
  saveDraftBody, snapshotDraft, setActiveDraft, getDraftBody,
  listExercises, createExercise, finishExercise, discardExercise,
  ensureWorkMediaCollection,
} from '../services/writersRoom/local.js';
import {
  runAnalysis, listAnalyses, getAnalysis, attachSceneImage,
} from '../services/writersRoom/evaluator.js';
import {
  listCharacters, createCharacter, updateCharacter, deleteCharacter,
} from '../services/writersRoom/characters.js';
import {
  listSettings, createSetting, updateSetting, deleteSetting,
} from '../services/writersRoom/settings.js';
import { addItem as addCollectionItem, ERR_DUPLICATE } from '../services/mediaCollections.js';

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
  // Set the active draft pointer AND return the new active body in the same
  // response. This collapses what used to be a PATCH-then-GET round-trip on
  // the client and eliminates the inconsistency window where the server's
  // active pointer had advanced but the client still showed the old body.
  await setActiveDraft(req.params.id, req.params.draftId);
  const { manifest, body } = await getWorkWithBody(req.params.id);
  res.json({ ...manifest, activeDraftBody: body });
}));

router.get('/works/:id/versions/:draftId', asyncHandler(async (req, res) => {
  const body = await getDraftBody(req.params.id, req.params.draftId);
  res.json({ id: req.params.draftId, body });
}));

// ---------- exercises ----------

router.get('/exercises', asyncHandler(async (req, res) => {
  // Coerce ?workId to a single string. Express parses repeated keys as an
  // array; previously we dropped the filter entirely in that case, which
  // turned a filtered request into an unfiltered one (data leakage). Now we
  // pick the first non-empty string and ignore the rest, so a duplicated
  // param degrades to "filter by the first value" instead of "show all".
  const raw = req.query.workId;
  const candidate = Array.isArray(raw) ? raw.find((v) => typeof v === 'string' && v) : raw;
  const workId = typeof candidate === 'string' && candidate ? candidate : undefined;
  res.json(await listExercises({ workId }));
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

// ---------- analysis ----------

router.get('/works/:id/analysis', asyncHandler(async (req, res) => {
  res.json(await listAnalyses(req.params.id));
}));

router.post('/works/:id/analysis', asyncHandler(async (req, res) => {
  const data = validateRequest(writersRoomAnalysisCreateSchema, req.body || {});
  const snapshot = await runAnalysis(req.params.id, data);
  res.status(snapshot.status === 'succeeded' ? 201 : 200).json(snapshot);
}));

router.get('/works/:id/analysis/:analysisId', asyncHandler(async (req, res) => {
  res.json(await getAnalysis(req.params.id, req.params.analysisId));
}));

// ---------- characters ----------

router.get('/works/:id/characters', asyncHandler(async (req, res) => {
  res.json(await listCharacters(req.params.id));
}));

router.post('/works/:id/characters', asyncHandler(async (req, res) => {
  const data = validateRequest(writersRoomCharacterCreateSchema, req.body || {});
  res.status(201).json(await createCharacter(req.params.id, data));
}));

router.patch('/works/:id/characters/:characterId', asyncHandler(async (req, res) => {
  const data = validateRequest(writersRoomCharacterUpdateSchema, req.body || {});
  res.json(await updateCharacter(req.params.id, req.params.characterId, data));
}));

router.delete('/works/:id/characters/:characterId', asyncHandler(async (req, res) => {
  res.json(await deleteCharacter(req.params.id, req.params.characterId));
}));

// ---------- settings (locations / world bible) ----------

router.get('/works/:id/settings', asyncHandler(async (req, res) => {
  res.json(await listSettings(req.params.id));
}));

router.post('/works/:id/settings', asyncHandler(async (req, res) => {
  const data = validateRequest(writersRoomSettingCreateSchema, req.body || {});
  res.status(201).json(await createSetting(req.params.id, data));
}));

router.patch('/works/:id/settings/:settingId', asyncHandler(async (req, res) => {
  const data = validateRequest(writersRoomSettingUpdateSchema, req.body || {});
  res.json(await updateSetting(req.params.id, req.params.settingId, data));
}));

router.delete('/works/:id/settings/:settingId', asyncHandler(async (req, res) => {
  res.json(await deleteSetting(req.params.id, req.params.settingId));
}));

// Persist a scene→generated-image link on the analysis snapshot, AND mirror
// the image into the work's auto-collection so it appears in MediaGen's
// Collections view. Called by SceneCard when image-gen:completed fires.
router.post('/works/:id/analysis/:analysisId/scene-image', asyncHandler(async (req, res) => {
  const { sceneId, filename, jobId, prompt } = req.body || {};
  const updated = await attachSceneImage(req.params.id, req.params.analysisId, { sceneId, filename, jobId, prompt });
  // Add to the per-work collection. Best-effort — a duplicate (same render
  // already in the collection) is a no-op, not an error.
  const collection = await ensureWorkMediaCollection(req.params.id);
  await addCollectionItem(collection.id, { kind: 'image', ref: filename }).catch((err) => {
    if (err?.code !== ERR_DUPLICATE) throw err;
  });
  res.json({ analysis: updated, collectionId: collection.id });
}));

export default router;
