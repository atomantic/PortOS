/**
 * Meatspace POST (Power On Self Test) Routes
 *
 * Drill config/generation/scoring, scored session history, the training log,
 * and the memory builder (custom memory items + memory drills).
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest, parsePagination } from '../lib/validation.js';
import {
  postSessionSubmitSchema,
  postConfigUpdateSchema,
  postDrillRequestSchema,
  postLlmScoreRequestSchema,
  postRhetoricEvaluationRequestSchema,
  postDrillCacheFillSchema,
  memoryItemCreateSchema,
  memoryItemUpdateSchema,
  memoryPracticeSchema,
  memoryMasteryAttestationSchema,
  memoryDrillRequestSchema,
  morseRoundSchema,
  morseLevelUpdateSchema,
  LLM_DRILL_TYPES,
  MEMORY_DRILL_TYPES,
  trainingEntrySchema,
  trainingRunSubmitSchema,
  postProgressQuerySchema,
} from '../lib/postValidation.js';
import * as postService from '../services/meatspacePost.js';
// Named at their declaring modules, not through a re-export off meatspacePost.js
// (that convenience re-export closed a static import cycle — issue #5690).
import { getPostStats } from '../services/meatspacePostStats.js';
import { getPostRecommendations } from '../services/meatspacePostRecommendations.js';
import { resolveDrillConfig, getAdaptivePreview } from '../services/meatspacePostAdaptive.js';
import * as memoryService from '../services/meatspacePostMemory.js';
import { generateLlmDrill, scoreLlmDrill } from '../services/meatspacePostLlm.js';
import { evaluateRhetoricAttempt } from '../services/meatspacePostRhetoric.js';
import { getCachedDrill, triggerReplenish, getCacheStats, requestCacheFill } from '../services/meatspacePostDrillCache.js';
import * as trainingService from '../services/meatspacePostTraining.js';
import * as morseService from '../services/meatspacePostMorse.js';
// meatspacePostReminder.js is not imported here — updatePostConfig() itself
// reschedules the daily reminder (via meatspacePost.js's postConfigEvents) so
// any current or future caller gets that behavior for free (#2015). Loaded
// once at boot from server/index.js, which is enough to attach its listener
// for the lifetime of the process.

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
  // updatePostConfig() reschedules the daily reminder itself (via its
  // postConfigEvents emitter, subscribed in meatspacePostReminder.js) whenever
  // `data.reminder` is part of the patch — see meatspacePost.js. That
  // reschedule runs fire-and-forget and swallows its own errors, so a
  // rescheduling failure (e.g. timezone settings unreadable) can never
  // surface as a save error here.
  const config = await postService.updatePostConfig(data);
  res.json(config);
}));

/**
 * GET /api/meatspace/post/benchmark/protocol
 * The next fixed-form benchmark and its versioned scoring contract.
 */
router.get('/post/benchmark/protocol', asyncHandler(async (req, res) => {
  const protocol = await postService.getPostBenchmarkProtocol();
  res.json(protocol);
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
  const stats = await getPostStats(days);
  res.json(stats);
}));

/**
 * GET /api/meatspace/post/progress
 * Unified time-series progress: per-day score/accuracy/response-time/minutes
 * buckets, per-domain and per-drill series, totals, ONE unified streak (scored
 * sessions OR training-log activity), and a mastery block (issue #2091).
 */
router.get('/post/progress', asyncHandler(async (req, res) => {
  const { days, bucket } = validateRequest(postProgressQuerySchema, req.query);
  const progress = await postService.getPostProgress({ days, bucket });
  res.json(progress);
}));

/**
 * GET /api/meatspace/post/recommendations
 * Ordered "what to practice next" list (issue #2100): due memory items, due
 * skill re-verifications, the weakest recent skill, and stalled ladder
 * progressions — each with a deep link into the exact drill/mode. Never empty
 * (falls back to a sensible default when nothing specific is actionable).
 *
 * Also returns `recentPractice` (`{ dayKey, drillTypes, memoryItemIds }`), the
 * three-local-day window used to rotate the heuristic tiers (issue #5319). The
 * client hands it straight back to `composeQuickSession` so the Quick session
 * rotates its per-domain picks off exactly the same signal.
 */
router.get('/post/recommendations', asyncHandler(async (req, res) => {
  const rawLimit = req.query.limit != null ? parseInt(req.query.limit, 10) : undefined;
  const limit = Number.isNaN(rawLimit) || rawLimit == null ? undefined : Math.max(1, Math.min(10, rawLimit));
  const result = await getPostRecommendations(limit != null ? { limit } : {});
  res.json(result);
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
    // The saved config scopes the auto-picked (lowest-mastery) item to the ones
    // still enabled in the user's Practice Plan (issue #3252); an explicit
    // memoryItemId bypasses it.
    const drill = await memoryService.generateMemoryDrill(
      { mode, count: data.config?.count, memoryItemId: data.config?.memoryItemId },
      await postService.getPostConfig(),
    );
    if (!drill) {
      throw new ServerError('Failed to generate memory drill', { status: 500, code: 'MEMORY_DRILL_FAILED' });
    }
    return res.json(drill);
  }

  // Adaptive difficulty (opt-in): when the Adaptive toggle is on, math drill
  // params are nudged from recent scored performance; otherwise config passes
  // through unchanged. Attaches an `adaptive` explainer when an adjustment ran.
  const { config: effectiveConfig, adaptive, progression } = await resolveDrillConfig(data.type, data.config);
  const drill = postService.generateDrill(data.type, effectiveConfig);
  if (!drill) {
    throw new ServerError('Unknown drill type', { status: 400, code: 'INVALID_DRILL_TYPE' });
  }
  if (adaptive) drill.adaptive = adaptive;
  // Progressive multiplication ladder explainer (current level + per-rung mastery)
  // so the drill runner can show which rung the user is on and why.
  if (progression) drill.progression = progression;
  // Maintenance-review rep (issue #2096): the drill generators rebuild their own
  // config, so re-stamp the review markers from the requested config onto the
  // returned drill. This ties the scored task back to the review scheduler on
  // submit (getSessionSkillContext reads task.config.reviewSkillId).
  if (effectiveConfig?.review && effectiveConfig?.reviewSkillId) {
    drill.config = { ...(drill.config || {}), review: true, reviewSkillId: effectiveConfig.reviewSkillId };
    drill.isReview = true;
  }
  res.json(drill);
}));

/**
 * GET /api/meatspace/post/multiplication-progress
 * Current progressive-multiplication ladder level + per-rung mastery status,
 * so the config UI can show the ramp before a session starts.
 */
router.get('/post/multiplication-progress', asyncHandler(async (req, res) => {
  const progress = await postService.getMultiplicationProgress();
  res.json(progress);
}));

/** Current technique-anchored Powers ladder level and mastery status. */
router.get('/post/powers-progress', asyncHandler(async (req, res) => {
  const progress = await postService.getPowersProgress();
  res.json(progress);
}));

/**
 * GET /api/meatspace/post/cognitive-progress
 * Per-drill progressive-ladder level + per-rung mastery for the laddered
 * cognitive drills (n-back / digit-span / schulte / mental-rotation / stroop),
 * keyed by drill type, so the config UI can show each drill's current rung.
 */
router.get('/post/cognitive-progress', asyncHandler(async (req, res) => {
  const progress = await postService.getCognitiveProgress();
  res.json(progress);
}));

/**
 * GET /api/meatspace/post/review/reps
 * Ready-to-run "maintenance rep" drill specs for mastered-but-inactive skills
 * currently due for re-verification (issue #2096). The launcher mixes 1–2 of
 * these into a Quick session as labeled review items. Empty until a skill is
 * mastered and its review interval elapses.
 */
router.get('/post/review/reps', asyncHandler(async (req, res) => {
  const rawLimit = req.query.limit != null ? parseInt(req.query.limit, 10) : 2;
  const limit = Number.isNaN(rawLimit) ? 2 : Math.max(0, Math.min(5, rawLimit));
  const reps = await postService.getPostReviewReps(new Date(), limit);
  res.json({ reps });
}));

/**
 * GET /api/meatspace/post/adaptive-preview
 * Transparent per-type preview of effective adaptive difficulty for math drills,
 * so the config UI can show what Adaptive will do before a session starts.
 */
router.get('/post/adaptive-preview', asyncHandler(async (req, res) => {
  const preview = await getAdaptivePreview();
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
 * POST /api/meatspace/post/rhetoric/evaluate
 * Evaluate one rhetoric attempt. The client advances before awaiting this
 * response, and serializes its own requests so a local provider is not flooded.
 */
router.post('/post/rhetoric/evaluate', asyncHandler(async (req, res) => {
  const data = validateRequest(postRhetoricEvaluationRequestSchema, req.body);
  const config = await postService.getPostConfig();
  if (config?.rhetoricEvaluator?.enabled !== true) {
    throw new ServerError(
      'Rhetoric evaluator is disabled — enable it in the POST configuration before evaluating an attempt',
      { status: 409, code: 'POST_RHETORIC_EVALUATOR_DISABLED' },
    );
  }
  const result = await evaluateRhetoricAttempt(data);
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
 * POST /api/meatspace/post/training/runs
 * Atomically persist every attempt in one completed training run.
 */
router.post('/post/training/runs', asyncHandler(async (req, res) => {
  const data = validateRequest(trainingRunSubmitSchema, req.body);
  const run = await trainingService.submitTrainingRun(data);
  res.status(201).json(run);
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
  const { limit } = parsePagination(req.query, { defaultLimit: 20, maxLimit: 100 });
  const entries = await trainingService.getTrainingEntries(limit);
  res.json(entries);
}));

// =============================================================================
// POST - Morse Trainer Progress
// =============================================================================

/**
 * POST /api/meatspace/post/morse/rounds
 * Append a completed Morse round (per-item sent→guessed results).
 */
router.post('/post/morse/rounds', asyncHandler(async (req, res) => {
  const data = validateRequest(morseRoundSchema, req.body);
  const round = await morseService.appendMorseRound(data);
  res.status(201).json(round);
}));

/**
 * GET /api/meatspace/post/morse/progress?days=N
 * Koch level, per-mode accuracy/WPM trends, confusion matrix, and per-character
 * accuracy (worst-first).
 */
router.get('/post/morse/progress', asyncHandler(async (req, res) => {
  const rawDays = req.query.days != null ? parseInt(req.query.days, 10) : 30;
  const days = Number.isNaN(rawDays) ? 30 : rawDays > 0 ? Math.min(rawDays, 365) : 0;
  const progress = await morseService.getMorseProgress(days);
  res.json(progress);
}));

/**
 * PUT /api/meatspace/post/morse/level
 * Explicit Koch level change (advance/reset) or one-time localStorage adoption.
 */
router.put('/post/morse/level', asyncHandler(async (req, res) => {
  const data = validateRequest(morseLevelUpdateSchema, req.body);
  const result = await morseService.setKochLevel(data);
  res.json(result);
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
 * POST /api/meatspace/post/memory-items/:id/attest-mastery
 * Provisionally accept user-attested mastery and schedule one future audit.
 */
router.post('/post/memory-items/:id/attest-mastery', asyncHandler(async (req, res) => {
  validateRequest(memoryMasteryAttestationSchema, req.body);
  const result = await memoryService.attestMemoryItemMastery(req.params.id);
  if (!result) throw new ServerError('Memory item not found or has no practice targets', { status: 404, code: 'NOT_FOUND' });
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
  const drill = await memoryService.generateMemoryDrill(data, await postService.getPostConfig());
  if (!drill) throw new ServerError('No memory items available', { status: 400, code: 'NO_MEMORY_ITEMS' });
  res.json(drill);
}));

export default router;
