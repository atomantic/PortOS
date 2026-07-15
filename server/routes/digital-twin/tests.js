/**
 * Behavioral test suites for the Digital Twin — the standard behavioral suite
 * plus the M34 P6 values-alignment, adversarial-boundary, and multi-turn
 * suites, and dynamic test generation. Each suite exposes a parse (GET), a run
 * (POST), and a history (GET) endpoint against `/api/digital-twin`.
 */

import { Router } from 'express';
import * as digitalTwinService from '../../services/digital-twin.js';
import { asyncHandler } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validation.js';
import {
  runTestsInputSchema,
  runMultiTestsInputSchema,
  testHistoryQuerySchema,
  generateTestsInputSchema,
} from '../../lib/digitalTwinValidation.js';
import { assertPersonaExists } from './shared.js';

const router = Router();

// =============================================================================
// BEHAVIORAL TESTING
// =============================================================================

/**
 * GET /api/digital-twin/tests
 * Get the behavioral test suite (parsed from BEHAVIORAL_TEST_SUITE.md)
 */
router.get('/tests', asyncHandler(async (req, res) => {
  const tests = await digitalTwinService.parseTestSuite();
  res.json(tests);
}));

/**
 * POST /api/digital-twin/tests/run
 * Run behavioral tests against a single provider/model
 */
router.post('/tests/run', asyncHandler(async (req, res) => {
  const { providerId, model, testIds, personaId } = validateRequest(runTestsInputSchema, req.body);
  await assertPersonaExists(personaId);
  const result = await digitalTwinService.runTests(providerId, model, testIds, personaId);
  res.json(result);
}));

/**
 * POST /api/digital-twin/tests/run-multi
 * Run behavioral tests against multiple providers/models
 */
router.post('/tests/run-multi', asyncHandler(async (req, res) => {
  const { providers, testIds, personaId } = validateRequest(runMultiTestsInputSchema, req.body);
  await assertPersonaExists(personaId);
  const io = req.app.get('io');

  // Run tests for each provider in parallel
  const results = await Promise.all(
    providers.map(async ({ providerId, model }) => {
      const result = await digitalTwinService.runTests(providerId, model, testIds, personaId).catch(err => ({
        providerId,
        model,
        error: err.message
      }));

      // Emit progress via Socket.IO
      if (io) {
        io.emit('digital-twin:test-progress', { providerId, model, result });
      }

      return { providerId, model, ...result };
    })
  );

  res.json(results);
}));

/**
 * GET /api/digital-twin/tests/history
 * Get test run history
 */
router.get('/tests/history', asyncHandler(async (req, res) => {
  const data = validateRequest(testHistoryQuerySchema, req.query);
  const history = await digitalTwinService.getTestHistory(data.limit);
  res.json(history);
}));

/**
 * POST /api/digital-twin/tests/generate
 * Generate behavioral tests from soul content
 */
router.post('/tests/generate', asyncHandler(async (req, res) => {
  const { providerId, model } = validateRequest(generateTestsInputSchema, req.body);
  const result = await digitalTwinService.generateDynamicTests(providerId, model);
  res.json(result);
}));

// =============================================================================
// VALUES-ALIGNMENT TESTING (M34 P6)
// =============================================================================

/**
 * GET /api/digital-twin/values-tests
 * Get the values-alignment dilemma suite (parsed from VALUES_ALIGNMENT_SUITE.md)
 */
router.get('/values-tests', asyncHandler(async (req, res) => {
  const dilemmas = await digitalTwinService.parseValuesAlignmentSuite();
  res.json(dilemmas);
}));

/**
 * POST /api/digital-twin/values-tests/run
 * Run values-alignment dilemmas against a single provider/model, scoring each
 * response against the user's stored values hierarchy
 */
router.post('/values-tests/run', asyncHandler(async (req, res) => {
  const { providerId, model, testIds, personaId } = validateRequest(runTestsInputSchema, req.body);
  await assertPersonaExists(personaId);
  const result = await digitalTwinService.runValuesAlignmentTests(providerId, model, testIds, personaId);
  res.json(result);
}));

/**
 * GET /api/digital-twin/values-tests/history
 * Get values-alignment run history
 */
router.get('/values-tests/history', asyncHandler(async (req, res) => {
  const data = validateRequest(testHistoryQuerySchema, req.query);
  const history = await digitalTwinService.getValuesAlignmentHistory(data.limit);
  res.json(history);
}));

// =============================================================================
// ADVERSARIAL BOUNDARY TESTING (M34 P6)
// =============================================================================

/**
 * GET /api/digital-twin/adversarial-tests
 * Get the adversarial-boundary scenario suite (parsed from ADVERSARIAL_BOUNDARY_SUITE.md)
 */
router.get('/adversarial-tests', asyncHandler(async (req, res) => {
  const scenarios = await digitalTwinService.parseAdversarialSuite();
  res.json(scenarios);
}));

/**
 * POST /api/digital-twin/adversarial-tests/run
 * Run adversarial-boundary scenarios against a single provider/model, scoring
 * whether the embodied twin held or breached each stated boundary
 */
router.post('/adversarial-tests/run', asyncHandler(async (req, res) => {
  const { providerId, model, testIds, personaId } = validateRequest(runTestsInputSchema, req.body);
  await assertPersonaExists(personaId);
  const result = await digitalTwinService.runAdversarialTests(providerId, model, testIds, personaId);
  res.json(result);
}));

/**
 * GET /api/digital-twin/adversarial-tests/history
 * Get adversarial-boundary run history
 */
router.get('/adversarial-tests/history', asyncHandler(async (req, res) => {
  const data = validateRequest(testHistoryQuerySchema, req.query);
  const history = await digitalTwinService.getAdversarialTestHistory(data.limit);
  res.json(history);
}));

// =============================================================================
// MULTI-TURN CONVERSATION TESTING (M34 P6)
// =============================================================================

/**
 * GET /api/digital-twin/multi-turn-tests
 * Get the multi-turn conversation suite (parsed from MULTI_TURN_SUITE.md)
 */
router.get('/multi-turn-tests', asyncHandler(async (req, res) => {
  const scenarios = await digitalTwinService.parseMultiTurnSuite();
  res.json(scenarios);
}));

/**
 * POST /api/digital-twin/multi-turn-tests/run
 * Run multi-turn conversation scenarios against a single provider/model, scoring
 * whether the embodied twin stayed consistent across each conversation
 */
router.post('/multi-turn-tests/run', asyncHandler(async (req, res) => {
  const { providerId, model, testIds, personaId } = validateRequest(runTestsInputSchema, req.body);
  await assertPersonaExists(personaId);
  const result = await digitalTwinService.runMultiTurnTests(providerId, model, testIds, personaId);
  res.json(result);
}));

/**
 * GET /api/digital-twin/multi-turn-tests/history
 * Get multi-turn conversation run history
 */
router.get('/multi-turn-tests/history', asyncHandler(async (req, res) => {
  const data = validateRequest(testHistoryQuerySchema, req.query);
  const history = await digitalTwinService.getMultiTurnTestHistory(data.limit);
  res.json(history);
}));

export default router;
