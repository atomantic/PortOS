/** Machine-local IdeaLoom list and settings routes. */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { partialWithoutDefaults } from '../lib/zodCompat.js';
import {
  ideaLoomImportInputSchema,
  ideaLoomListInputSchema,
  ideaLoomSettingsInputSchema,
  ideaLoomSyncInputSchema,
} from '../lib/brainValidation.js';
import * as ideaLoomLists from '../services/idealoomLists.js';
import * as ideaLoomObsidian from '../services/idealoomObsidian.js';
import { scheduleAutoSync } from '../services/idealoomAutoSync.js';

const router = Router();

router.get('/ideas/idealoom/settings', asyncHandler(async (_req, res) => {
  res.json(await ideaLoomLists.getSettings());
}));

router.put('/ideas/idealoom/settings', asyncHandler(async (req, res) => {
  const updates = validateRequest(partialWithoutDefaults(ideaLoomSettingsInputSchema), req.body);
  res.json(await ideaLoomLists.updateSettings(updates));
}));

router.post('/ideas/idealoom/import', asyncHandler(async (req, res) => {
  validateRequest(ideaLoomImportInputSchema, req.body);
  res.json(await ideaLoomObsidian.importFromObsidian());
}));

// The explicit export. This is the ONLY caller that can pass recreateMissing,
// so recovering a note the user deleted in the vault always takes a deliberate
// request — automatic sync reports the deletion and writes nothing.
router.post('/ideas/idealoom/sync', asyncHandler(async (req, res) => {
  const { listId, recreateMissing } = validateRequest(ideaLoomSyncInputSchema, req.body);
  res.json(await ideaLoomObsidian.exportToObsidian({ listId, recreateMissing }));
}));

router.get('/ideas/idealoom/lists', asyncHandler(async (_req, res) => {
  res.json(await ideaLoomLists.listLists());
}));

// Only these two user-initiated write routes schedule an automatic export.
// The import and sync routes deliberately do not: keeping the trigger on the
// user's edit path is what stops an import from provoking an export, and that
// export from provoking the next import.
router.post('/ideas/idealoom/lists', asyncHandler(async (req, res) => {
  const data = validateRequest(ideaLoomListInputSchema, req.body);
  const list = await ideaLoomLists.createList(data);
  scheduleAutoSync(list.id);
  res.status(201).json(list);
}));

router.get('/ideas/idealoom/lists/:id', asyncHandler(async (req, res) => {
  const list = await ideaLoomLists.getList(req.params.id);
  if (!list) throw new ServerError('IdeaLoom list not found', { status: 404, code: 'NOT_FOUND' });
  res.json(list);
}));

router.put('/ideas/idealoom/lists/:id', asyncHandler(async (req, res) => {
  const updates = validateRequest(partialWithoutDefaults(ideaLoomListInputSchema), req.body);
  const list = await ideaLoomLists.updateList(req.params.id, updates);
  if (!list) throw new ServerError('IdeaLoom list not found', { status: 404, code: 'NOT_FOUND' });
  scheduleAutoSync(list.id);
  res.json(list);
}));

// Deleting a list deliberately leaves its vault note alone and schedules
// nothing: an implicit remote delete is the one automatic action this
// integration must never take. Removing the note is the user's job in Obsidian.
router.delete('/ideas/idealoom/lists/:id', asyncHandler(async (req, res) => {
  if (!await ideaLoomLists.deleteList(req.params.id)) {
    throw new ServerError('IdeaLoom list not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.status(204).send();
}));

export default router;
