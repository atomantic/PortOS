/**
 * Taste questionnaire — profile status, section definitions, per-section
 * question/answer flow, summaries, personalized follow-ups, and section reset.
 *
 * The static `/taste/sections` route is single-segment while the parameterized
 * routes are two-segment (`/taste/:section/...`), and `/taste/answer` /
 * `/taste/summary` are POST-only — so no route shadows another. Keeping them all
 * in this one file preserves that ordering regardless of mount order.
 */

import { Router } from 'express';
import * as tasteService from '../../services/taste-questionnaire.js';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validation.js';
import {
  tasteAnswerInputSchema,
  tasteSummaryInputSchema,
  tasteSectionEnum,
  tastePersonalizedQuestionInputSchema,
} from '../../lib/digitalTwinValidation.js';

const router = Router();

/**
 * GET /api/digital-twin/taste
 * Get taste profile status and progress
 */
router.get('/taste', asyncHandler(async (req, res) => {
  const profile = await tasteService.getTasteProfile();
  res.json(profile);
}));

/**
 * GET /api/digital-twin/taste/sections
 * Get available taste sections with question definitions
 */
router.get('/taste/sections', asyncHandler(async (req, res) => {
  const sections = Object.entries(tasteService.TASTE_SECTIONS).map(([id, config]) => ({
    id,
    label: config.label,
    description: config.description,
    icon: config.icon,
    color: config.color,
    questionCount: config.questions.length
  }));
  res.json(sections);
}));

/**
 * GET /api/digital-twin/taste/:section/next
 * Get the next question for a taste section
 */
router.get('/taste/:section/next', asyncHandler(async (req, res) => {
  const parsed = tasteSectionEnum.safeParse(req.params.section);
  if (!parsed.success) {
    throw new ServerError(`Invalid taste section: ${req.params.section}`, {
      status: 400,
      code: 'VALIDATION_ERROR'
    });
  }
  const question = await tasteService.getNextQuestion(parsed.data);
  res.json(question);
}));

/**
 * POST /api/digital-twin/taste/answer
 * Submit an answer for a taste question
 */
router.post('/taste/answer', asyncHandler(async (req, res) => {
  const { section, questionId, answer, source, generatedQuestion, identityContextUsed } = validateRequest(tasteAnswerInputSchema, req.body);
  const result = await tasteService.submitAnswer(section, questionId, answer, { source, generatedQuestion, identityContextUsed });
  res.json(result);
}));

/**
 * GET /api/digital-twin/taste/:section/responses
 * Get all responses for a taste section
 */
router.get('/taste/:section/responses', asyncHandler(async (req, res) => {
  const parsed = tasteSectionEnum.safeParse(req.params.section);
  if (!parsed.success) {
    throw new ServerError(`Invalid taste section: ${req.params.section}`, {
      status: 400,
      code: 'VALIDATION_ERROR'
    });
  }
  const responses = await tasteService.getSectionResponses(parsed.data);
  res.json(responses);
}));

/**
 * POST /api/digital-twin/taste/summary
 * Generate a taste profile summary (section or overall)
 */
router.post('/taste/summary', asyncHandler(async (req, res) => {
  const { section, providerId, model } = validateRequest(tasteSummaryInputSchema, req.body);

  const result = section
    ? await tasteService.generateSectionSummary(section, providerId, model)
    : await tasteService.generateOverallSummary(providerId, model);

  res.json(result);
}));

/**
 * POST /api/digital-twin/taste/:section/personalized-question
 * Generate a personalized follow-up question using identity context
 */
router.post('/taste/:section/personalized-question', asyncHandler(async (req, res) => {
  const parsed = tasteSectionEnum.safeParse(req.params.section);
  if (!parsed.success) {
    throw new ServerError(`Invalid taste section: ${req.params.section}`, {
      status: 400,
      code: 'VALIDATION_ERROR'
    });
  }
  const { providerId, model } = validateRequest(tastePersonalizedQuestionInputSchema, req.body);
  // `{ question, reason }` — a provider failure throws (502 AI_PROVIDER_ERROR) and
  // bubbles to the error middleware, so a 200 here always means "we asked, and this
  // is the answer": either a question, or a `reason` naming what was missing.
  const result = await tasteService.generatePersonalizedTasteQuestion(parsed.data, providerId, model);
  res.json(result);
}));

/**
 * DELETE /api/digital-twin/taste/:section
 * Reset a taste section
 */
router.delete('/taste/:section', asyncHandler(async (req, res) => {
  const parsed = tasteSectionEnum.safeParse(req.params.section);
  if (!parsed.success) {
    throw new ServerError(`Invalid taste section: ${req.params.section}`, {
      status: 400,
      code: 'VALIDATION_ERROR'
    });
  }
  const result = await tasteService.resetSection(parsed.data);
  res.json(result);
}));

export default router;
