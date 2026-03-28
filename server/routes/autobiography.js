/**
 * Autobiography API Routes
 *
 * Handles endpoints for the autobiography story prompt feature:
 * - Get themes, prompts, stories
 * - Save and update stories
 * - Configuration for prompt frequency
 * - Manual prompt trigger
 */

import { Router } from 'express';
import { z } from 'zod';
import * as autobiographyService from '../services/autobiography.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';

const router = Router();

// Validation schemas
const saveStorySchema = z.object({
  promptId: z.string().min(1),
  content: z.string().min(1).max(50000),
  parentStoryId: z.string().optional(),
  customPromptText: z.string().optional()
});

const generateFollowUpsSchema = z.object({
  providerId: z.string().optional()
});

const updateStorySchema = z.object({
  content: z.string().min(1).max(50000)
});

const updateConfigSchema = z.object({
  enabled: z.boolean().optional(),
  intervalHours: z.number().min(1).max(168).optional()
});

// =============================================================================
// STATS & CONFIG
// =============================================================================

/**
 * GET /api/digital-twin/autobiography
 * Get autobiography stats and configuration
 */
router.get('/', asyncHandler(async (req, res) => {
  const stats = await autobiographyService.getStats();
  res.json(stats);
}));

/**
 * GET /api/digital-twin/autobiography/config
 * Get configuration
 */
router.get('/config', asyncHandler(async (req, res) => {
  const config = await autobiographyService.getConfig();
  res.json(config);
}));

/**
 * PUT /api/digital-twin/autobiography/config
 * Update configuration
 */
router.put('/config', asyncHandler(async (req, res) => {
  const validated = validateRequest(updateConfigSchema, req.body);
  const config = await autobiographyService.updateConfig(validated);
  res.json(config);
}));

// =============================================================================
// THEMES & PROMPTS
// =============================================================================

/**
 * GET /api/digital-twin/autobiography/themes
 * Get all available themes
 */
router.get('/themes', asyncHandler(async (req, res) => {
  const themes = autobiographyService.getThemes();
  res.json(themes);
}));

/**
 * GET /api/digital-twin/autobiography/prompt
 * Get the next prompt
 */
router.get('/prompt', asyncHandler(async (req, res) => {
  const prompt = await autobiographyService.getNextPrompt(req.query.exclude || undefined);
  res.json(prompt);
}));

/**
 * GET /api/digital-twin/autobiography/prompt/:id
 * Get a specific prompt by ID
 */
router.get('/prompt/:id', asyncHandler(async (req, res) => {
  const prompt = autobiographyService.getPromptById(req.params.id);
  if (!prompt) {
    throw new ServerError('Prompt not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(prompt);
}));

// =============================================================================
// STORIES
// =============================================================================

/**
 * GET /api/digital-twin/autobiography/stories
 * Get all stories, optionally filtered by theme
 */
router.get('/stories', asyncHandler(async (req, res) => {
  const stories = await autobiographyService.getStories(req.query.theme || null);
  res.json(stories);
}));

/**
 * POST /api/digital-twin/autobiography/stories
 * Save a new story
 */
router.post('/stories', asyncHandler(async (req, res) => {
  const validated = validateRequest(saveStorySchema, req.body);
  const story = await autobiographyService.saveStory({
    promptId: validated.promptId,
    content: validated.content,
    parentStoryId: validated.parentStoryId,
    customPromptText: validated.customPromptText
  });
  res.json(story);
}));

/**
 * PUT /api/digital-twin/autobiography/stories/:id
 * Update an existing story
 */
router.put('/stories/:id', asyncHandler(async (req, res) => {
  const validated = validateRequest(updateStorySchema, req.body);
  const story = await autobiographyService.updateStory(req.params.id, validated.content);
  if (!story) {
    throw new ServerError('Story not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(story);
}));

/**
 * DELETE /api/digital-twin/autobiography/stories/:id
 * Delete a story
 */
router.delete('/stories/:id', asyncHandler(async (req, res) => {
  const story = await autobiographyService.deleteStory(req.params.id);
  if (!story) {
    throw new ServerError('Story not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json({ success: true, story });
}));

// =============================================================================
// FOLLOW-UP CHAINS
// =============================================================================

/**
 * POST /api/digital-twin/autobiography/stories/:id/follow-ups
 * Generate LLM-powered follow-up questions for a story
 */
router.post('/stories/:id/follow-ups', asyncHandler(async (req, res) => {
  const validated = validateRequest(generateFollowUpsSchema, req.body);
  const result = await autobiographyService.generateFollowUps(req.params.id, validated.providerId);
  if (result.error) {
    throw new ServerError(result.error, { status: 400, code: 'FOLLOW_UP_ERROR' });
  }
  res.json(result);
}));

/**
 * GET /api/digital-twin/autobiography/stories/:id/chain
 * Get the full chain of stories linked to a story (ancestors + descendants)
 */
router.get('/stories/:id/chain', asyncHandler(async (req, res) => {
  const chain = await autobiographyService.getStoryChain(req.params.id);
  res.json(chain);
}));

// =============================================================================
// PROMPT TRIGGER
// =============================================================================

/**
 * POST /api/digital-twin/autobiography/trigger
 * Manually trigger a story prompt notification
 */
router.post('/trigger', asyncHandler(async (req, res) => {
  const result = await autobiographyService.checkAndPrompt();
  res.json(result);
}));

export default router;
