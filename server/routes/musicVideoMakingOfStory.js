/**
 * Making-Of story routes for Music Video projects: capture labeled/tagged
 * stills, video clips, references and notes as you go, and stage Making-Of
 * posts for post-publish management.
 */

import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import {
  makingOfItemCaptureSchema,
  makingOfItemPatchSchema,
  makingOfPostCreateSchema,
  makingOfPostPatchSchema,
} from '../lib/musicVideo/musicVideoMakingOfStory.js';

const router = Router();

router.post('/:id/making-of/items', asyncHandler(async (req, res) => {
  const input = validateRequest(makingOfItemCaptureSchema, req.body ?? {});
  const { captureMakingOfItem } = await import('../services/musicVideo/makingOfStory.js');
  const result = await captureMakingOfItem(req.params.id, input);
  res.status(201).json({ item: result.item, createdPost: result.createdPost, story: result.story });
}));

router.patch('/:id/making-of/items/:itemId', asyncHandler(async (req, res) => {
  const patch = validateRequest(makingOfItemPatchSchema, req.body ?? {});
  const { updateMakingOfItem } = await import('../services/musicVideo/makingOfStory.js');
  const result = await updateMakingOfItem(req.params.id, req.params.itemId, patch);
  res.json({ item: result.item, story: result.story });
}));

router.delete('/:id/making-of/items/:itemId', asyncHandler(async (req, res) => {
  const { deleteMakingOfItem } = await import('../services/musicVideo/makingOfStory.js');
  const result = await deleteMakingOfItem(req.params.id, req.params.itemId);
  res.json({ story: result.story });
}));

router.post('/:id/making-of/posts', asyncHandler(async (req, res) => {
  const input = validateRequest(makingOfPostCreateSchema, req.body ?? {});
  const { createMakingOfPost } = await import('../services/musicVideo/makingOfStory.js');
  const result = await createMakingOfPost(req.params.id, input);
  res.status(201).json({ post: result.post, story: result.story });
}));

router.patch('/:id/making-of/posts/:postId', asyncHandler(async (req, res) => {
  const patch = validateRequest(makingOfPostPatchSchema, req.body ?? {});
  const { updateMakingOfPost } = await import('../services/musicVideo/makingOfStory.js');
  const result = await updateMakingOfPost(req.params.id, req.params.postId, patch);
  res.json({ post: result.post, story: result.story });
}));

router.delete('/:id/making-of/posts/:postId', asyncHandler(async (req, res) => {
  const { deleteMakingOfPost } = await import('../services/musicVideo/makingOfStory.js');
  const result = await deleteMakingOfPost(req.params.id, req.params.postId);
  res.json({ story: result.story });
}));

export default router;
