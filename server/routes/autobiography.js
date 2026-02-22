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
  content: z.string().min(1).max(50000)
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
  const prompt = await autobiographyService.getNextPrompt();
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
  const story = await autobiographyService.saveStory(validated);
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
