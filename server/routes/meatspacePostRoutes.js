/**
 * Meatspace POST (Power On Self Test) Routes
 *
 * Drill config/generation/scoring, scored session history, the training log,
 * and the memory builder (custom memory items + memory drills).
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  postSessionSubmitSchema,
  postConfigUpdateSchema,
  postDrillRequestSchema,
  postLlmScoreRequestSchema,
  postDrillCacheFillSchema,
  memoryItemCreateSchema,
  memoryItemUpdateSchema,
  memoryPracticeSchema,
  memoryDrillRequestSchema,
  LLM_DRILL_TYPES,
  MEMORY_DRILL_TYPES,
  trainingEntrySchema,
} from '../lib/postValidation.js';
import * as postService from '../services/meatspacePost.js';
import * as memoryService from '../services/meatspacePostMemory.js';
import { generateLlmDrill, scoreLlmDrill } from '../services/meatspacePostLlm.js';
import { getCachedDrill, triggerReplenish, getCacheStats, requestCacheFill } from '../services/meatspacePostDrillCache.js';
import * as trainingService from '../services/meatspacePostTraining.js';

const router = Router();

// =============================================================================
// POST (Power On Self Test)
// =============================================================================

/**
 * GET /api/meatspace/post/config
 * Drill configuration and weights
 */
router.get('/post/config', asyncHandler(async (req, res) => {
  const config = await postService.getPostConfig();
  res.json(config);
}));

/**
 * PUT /api/meatspace/post/config
 * Update drill configuration
 */
router.put('/post/config', asyncHandler(async (req, res) => {
  const data = validateRequest(postConfigUpdateSchema, req.body);
  const config = await postService.updatePostConfig(data);
  res.json(config);
}));

/**
 * GET /api/meatspace/post/sessions
 * Session history with optional date range
 */
router.get('/post/sessions', asyncHandler(async (req, res) => {
  const sessions = await postService.getPostSessions(req.query.from, req.query.to);
  res.json(sessions);
}));

/**
 * GET /api/meatspace/post/sessions/:id
 * Single session by ID
 */
router.get('/post/sessions/:id', asyncHandler(async (req, res) => {
  const session = await postService.getPostSession(req.params.id);
  if (!session) {
    throw new ServerError('Session not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(session);
}));

/**
 * POST /api/meatspace/post/sessions
 * Submit a completed session
 */
router.post('/post/sessions', asyncHandler(async (req, res) => {
  const data = validateRequest(postSessionSubmitSchema, req.body);
  const session = await postService.submitPostSession(data);
  res.status(201).json(session);
}));

/**
 * GET /api/meatspace/post/stats
 * Rolling averages and trends
 */
router.get('/post/stats', asyncHandler(async (req, res) => {
  const rawDays = req.query.days != null ? parseInt(req.query.days, 10) : 30;
  const days = Number.isNaN(rawDays) ? 30 : rawDays > 0 ? Math.min(rawDays, 365) : 0;
  const stats = await postService.getPostStats(days);
  res.json(stats);
}));

/**
 * POST /api/meatspace/post/drill
 * Generate a drill with questions and expected answers.
 * Supports both math drills (sync) and LLM drills (async, requires AI provider).
 */
router.post('/post/drill', asyncHandler(async (req, res) => {
  const data = validateRequest(postDrillRequestSchema, req.body);

  if (LLM_DRILL_TYPES.includes(data.type)) {
    // Try pre-generated cache first for instant response
    const cached = getCachedDrill(data.type);
    if (cached) {
      console.log(`⚡ POST drill served from cache: ${data.type}`);
      triggerReplenish(data.type, data.providerId, data.model);
      return res.json(cached);
    }

    const drill = await generateLlmDrill(data.type, data.config, data.providerId, data.model);
    if (!drill) {
      throw new ServerError('Failed to generate LLM drill', { status: 500, code: 'LLM_DRILL_FAILED' });
    }
    // Top up the cache for next time — a no-op if the cache is currently cold
    // (0 cached). Cold fill only happens via POST /post/drill-cache/fill,
    // which requires the user to explicitly opt in and pick a provider/model.
    triggerReplenish(data.type, data.providerId, data.model);
    return res.json(drill);
  }

  if (MEMORY_DRILL_TYPES.includes(data.type)) {
    const mode = data.type.replace('memory-', '');
    const drill = await memoryService.generateMemoryDrill({ mode, count: data.config?.count, memoryItemId: data.config?.memoryItemId });
    if (!drill) {
      throw new ServerError('Failed to generate memory drill', { status: 500, code: 'MEMORY_DRILL_FAILED' });
    }
    return res.json(drill);
  }

  // Adaptive difficulty (opt-in): when the Adaptive toggle is on, math drill
  // params are nudged from recent scored performance; otherwise config passes
  // through unchanged. Attaches an `adaptive` explainer when an adjustment ran.
  const { config: effectiveConfig, adaptive } = await postService.resolveDrillConfig(data.type, data.config);
  const drill = postService.generateDrill(data.type, effectiveConfig);
  if (!drill) {
    throw new ServerError('Unknown drill type', { status: 400, code: 'INVALID_DRILL_TYPE' });
  }
  if (adaptive) drill.adaptive = adaptive;
  res.json(drill);
}));

/**
 * GET /api/meatspace/post/adaptive-preview
 * Transparent per-type preview of effective adaptive difficulty for math drills,
 * so the config UI can show what Adaptive will do before a session starts.
 */
router.get('/post/adaptive-preview', asyncHandler(async (req, res) => {
  const preview = await postService.getAdaptivePreview();
  res.json(preview);
}));

/**
 * POST /api/meatspace/post/score-llm
 * Score an LLM drill's responses using AI evaluation.
 */
router.post('/post/score-llm', asyncHandler(async (req, res) => {
  const data = validateRequest(postLlmScoreRequestSchema, req.body);
  const result = await scoreLlmDrill(
    data.type, data.drillData, data.responses,
    data.timeLimitMs, data.providerId, data.model
  );
  res.json(result);
}));

/**
 * GET /api/meatspace/post/drill-cache/status
 * Per-type cache counts for the wordplay drill cache, so the client can
 * decide whether to prompt the user for a cache-fill (0 cached = cold).
 */
router.get('/post/drill-cache/status', asyncHandler(async (req, res) => {
  res.json(getCacheStats());
}));

/**
 * POST /api/meatspace/post/drill-cache/fill
 * Explicit, user-initiated cache warm-up. This is the ONLY path that performs
 * a cold fill (0 -> several cached drills per type) — the client must prompt
 * the user and let them pick a provider/model before calling this, since it
 * can issue several sequential LLM calls in the background.
 */
router.post('/post/drill-cache/fill', asyncHandler(async (req, res) => {
  const data = validateRequest(postDrillCacheFillSchema, req.body);
  const triggered = requestCacheFill(data.types, data.providerId, data.model);
  res.json({ triggered });
}));

// =============================================================================
// POST - Training Log
// =============================================================================

/**
 * POST /api/meatspace/post/training
 * Submit a training practice entry (separate from scored sessions)
 */
router.post('/post/training', asyncHandler(async (req, res) => {
  const data = validateRequest(trainingEntrySchema, req.body);
  const entry = await trainingService.submitTrainingEntry(data);
  res.status(201).json(entry);
}));

/**
 * GET /api/meatspace/post/training/stats
 * Training stats: practice counts, streaks, accuracy by drill type
 */
router.get('/post/training/stats', asyncHandler(async (req, res) => {
  const rawDays = req.query.days != null ? parseInt(req.query.days, 10) : 30;
  const days = Number.isNaN(rawDays) ? 30 : rawDays > 0 ? Math.min(rawDays, 365) : 0;
  const stats = await trainingService.getTrainingStats(days);
  res.json(stats);
}));

/**
 * GET /api/meatspace/post/training/entries
 * Recent training entries
 */
router.get('/post/training/entries', asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const entries = await trainingService.getTrainingEntries(limit);
  res.json(entries);
}));

// =============================================================================
// POST - Memory Builder
// =============================================================================

/**
 * GET /api/meatspace/post/memory-items
 * List all memory items (includes built-in Elements Song)
 */
router.get('/post/memory-items', asyncHandler(async (req, res) => {
  const items = await memoryService.getMemoryItems();
  res.json(items);
}));

/**
 * GET /api/meatspace/post/memory-items/due
 * List memory items currently due for spaced-repetition review (nextReview <= now),
 * most-overdue first. Declared before /:id so "due" isn't captured as an id.
 */
router.get('/post/memory-items/due', asyncHandler(async (req, res) => {
  const items = await memoryService.getDueMemoryItems();
  res.json(items);
}));

/**
 * GET /api/meatspace/post/memory-items/:id
 * Get a single memory item
 */
router.get('/post/memory-items/:id', asyncHandler(async (req, res) => {
  const item = await memoryService.getMemoryItem(req.params.id);
  if (!item) throw new ServerError('Memory item not found', { status: 404, code: 'NOT_FOUND' });
  res.json(item);
}));

/**
 * POST /api/meatspace/post/memory-items
 * Create a custom memory item
 */
router.post('/post/memory-items', asyncHandler(async (req, res) => {
  const data = validateRequest(memoryItemCreateSchema, req.body);
  const item = await memoryService.createMemoryItem(data);
  res.status(201).json(item);
}));

/**
 * PUT /api/meatspace/post/memory-items/:id
 * Update a memory item (built-in items: mastery only)
 */
router.put('/post/memory-items/:id', asyncHandler(async (req, res) => {
  const data = validateRequest(memoryItemUpdateSchema, req.body);
  const item = await memoryService.updateMemoryItem(req.params.id, data);
  if (!item) throw new ServerError('Memory item not found', { status: 404, code: 'NOT_FOUND' });
  res.json(item);
}));

/**
 * DELETE /api/meatspace/post/memory-items/:id
 * Delete a custom memory item (built-in items cannot be deleted)
 */
router.delete('/post/memory-items/:id', asyncHandler(async (req, res) => {
  const removed = await memoryService.deleteMemoryItem(req.params.id);
  if (!removed) throw new ServerError('Cannot delete item (not found or built-in)', { status: 400, code: 'DELETE_FAILED' });
  res.json(removed);
}));

/**
 * POST /api/meatspace/post/memory-items/:id/practice
 * Submit practice results and update mastery
 */
router.post('/post/memory-items/:id/practice', asyncHandler(async (req, res) => {
  const data = validateRequest(memoryPracticeSchema, req.body);
  const result = await memoryService.submitPractice(req.params.id, data);
  if (!result) throw new ServerError('Memory item not found', { status: 404, code: 'NOT_FOUND' });
  res.json(result);
}));

/**
 * GET /api/meatspace/post/memory-items/:id/mastery
 * Get mastery breakdown for a memory item
 */
router.get('/post/memory-items/:id/mastery', asyncHandler(async (req, res) => {
  const mastery = await memoryService.getMastery(req.params.id);
  if (!mastery) throw new ServerError('Memory item not found', { status: 404, code: 'NOT_FOUND' });
  res.json(mastery);
}));

/**
 * GET /api/meatspace/post/memory-items/:id/chunk-mastery
 * Get chunk mastery order for spaced repetition practice
 */
router.get('/post/memory-items/:id/chunk-mastery', asyncHandler(async (req, res) => {
  const item = await memoryService.getMemoryItem(req.params.id);
  if (!item) throw new ServerError('Memory item not found', { status: 404, code: 'NOT_FOUND' });
  res.json(memoryService.getChunkMasteryOrder(item));
}));

/**
 * POST /api/meatspace/post/memory-drill
 * Generate a memory drill for a POST session
 */
router.post('/post/memory-drill', asyncHandler(async (req, res) => {
  const data = validateRequest(memoryDrillRequestSchema, req.body);
  const drill = await memoryService.generateMemoryDrill(data);
  if (!drill) throw new ServerError('No memory items available', { status: 400, code: 'NO_MEMORY_ITEMS' });
  res.json(drill);
}));

export default router;
