/** List, draft and join catalog stories and manage their video subject links. */

import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import {
  catalogStoryListQuerySchema, catalogStoryParamsSchema, catalogStoryJoinSchema,
  catalogStoryDraftSchema, catalogVideoSubjectsQuerySchema, catalogVideoSubjectLinksSchema,
  catalogVideoSubjectSaveSchema, catalogVideoDescriptionRestoreSchema,
} from '../lib/catalog/catalogValidation.js';
import { draftStoryMember, joinStory, listCatalogStories } from '../services/catalog/catalogStories.js';
import {
  linkVideoSubjects, listVideoSubjectLinks, restoreVideoSubjectDescription,
  saveVideoSubjectToCatalog,
} from '../services/musicVideo/catalogCast.js';

const router = Router();

// Stories (storyboards, music videos, series) and their member counts for one
// type, for the Casting / Environments / Objects story filter.
router.get('/stories', asyncHandler(async (req, res) => {
  const { type } = validateRequest(catalogStoryListQuerySchema, req.query);
  res.json({ stories: await listCatalogStories({ type }) });
}));

// New from prompt: answers with a preview and the exact prompt sent; the
// client saves the record (POST /ingredients) and joins it to the story.
router.post('/stories/draft', asyncHandler(async (req, res) => {
  res.json(await draftStoryMember(validateRequest(catalogStoryDraftSchema, req.body ?? {})));
}));

// A music video's subjects of one kind, each with its linked record or a
// suggested one (same name, age form from "(17)"); link sets or clears them.
router.get('/stories/music-video/:id/subjects', asyncHandler(async (req, res) => {
  const { type } = validateRequest(catalogVideoSubjectsQuerySchema, req.query);
  res.json(await listVideoSubjectLinks(req.params.id, { type }));
}));

router.post('/stories/music-video/:id/subjects/link', asyncHandler(async (req, res) => {
  const { links } = validateRequest(catalogVideoSubjectLinksSchema, req.body ?? {});
  const { project, linked, unlinked } = await linkVideoSubjects(req.params.id, links);
  res.json({ concept: project?.concept || {}, updatedAt: project?.updatedAt ?? null, linked, unlinked });
}));

// One subject's own new record, created and linked; repeating it is a no-op.
router.post('/stories/music-video/:id/subjects/save', asyncHandler(async (req, res) => {
  const { subjectId } = validateRequest(catalogVideoSubjectSaveSchema, req.body ?? {});
  const { project, created, kept } = await saveVideoSubjectToCatalog(req.params.id, subjectId);
  res.json({ concept: project?.concept || {}, updatedAt: project?.updatedAt ?? null, created, kept });
}));

router.post('/stories/music-video/:id/subjects/restore-description', asyncHandler(async (req, res) => {
  const input = validateRequest(catalogVideoDescriptionRestoreSchema, req.body ?? {});
  const { project } = await restoreVideoSubjectDescription(req.params.id, input);
  res.json({ concept: project?.concept || {}, updatedAt: project?.updatedAt ?? null });
}));

router.post('/stories/:kind/:id/members', asyncHandler(async (req, res) => {
  const { kind, id } = validateRequest(catalogStoryParamsSchema, req.params);
  const { ingredientId } = validateRequest(catalogStoryJoinSchema, req.body ?? {});
  res.status(201).json(await joinStory(kind, id, ingredientId));
}));

export default router;
