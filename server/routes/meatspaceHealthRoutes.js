/**
 * Meatspace Health Routes
 *
 * Blood tests, body composition, blood pressure, workouts, epigenetic tests, and eye exams.
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  bloodTestSchema,
  bodyEntrySchema,
  bloodPressureSchema,
  workoutSchema,
  epigeneticTestSchema,
  eyeExamSchema,
  eyeExamUpdateSchema,
} from '../lib/meatspaceValidation.js';
import * as healthService from '../services/meatspaceHealth.js';

const router = Router();

// =============================================================================
// BLOOD & BODY
// =============================================================================

/**
 * GET /api/meatspace/blood
 * Blood test history + reference ranges
 */
router.get('/blood', asyncHandler(async (req, res) => {
  const data = await healthService.getBloodTests();
  res.json(data);
}));

/**
 * POST /api/meatspace/blood
 * Add a blood test
 */
router.post('/blood', asyncHandler(async (req, res) => {
  const data = validateRequest(bloodTestSchema, req.body);
  const test = await healthService.addBloodTest(data);
  res.status(201).json(test);
}));

/**
 * GET /api/meatspace/body
 * Body composition history
 */
router.get('/body', asyncHandler(async (req, res) => {
  const history = await healthService.getBodyHistory();
  res.json(history);
}));

/**
 * POST /api/meatspace/body
 * Log a body entry
 */
router.post('/body', asyncHandler(async (req, res) => {
  const data = validateRequest(bodyEntrySchema, req.body);
  const entry = await healthService.addBodyEntry(data);
  res.status(201).json(entry);
}));

/**
 * GET /api/meatspace/blood-pressure
 * Blood pressure history (merged from MortalLoom healthMetrics or local fallback)
 */
router.get('/blood-pressure', asyncHandler(async (req, res) => {
  const readings = await healthService.getBloodPressureHistory();
  res.json({ readings });
}));

/**
 * POST /api/meatspace/blood-pressure
 * Log a blood pressure reading (upserted by date)
 */
router.post('/blood-pressure', asyncHandler(async (req, res) => {
  const data = validateRequest(bloodPressureSchema, req.body);
  const reading = await healthService.addBloodPressureReading(data);
  res.status(201).json(reading);
}));

/**
 * GET /api/meatspace/workouts
 * Workout entries logged via voice, palette, or API
 */
router.get('/workouts', asyncHandler(async (req, res) => {
  const workouts = await healthService.getWorkouts();
  res.json({ workouts });
}));

/**
 * POST /api/meatspace/workouts
 * Log a workout
 */
router.post('/workouts', asyncHandler(async (req, res) => {
  const data = validateRequest(workoutSchema, req.body);
  const workout = await healthService.addWorkout(data);
  res.status(201).json(workout);
}));

/**
 * GET /api/meatspace/epigenetic
 * Elysium results
 */
router.get('/epigenetic', asyncHandler(async (req, res) => {
  const data = await healthService.getEpigeneticTests();
  res.json(data);
}));

/**
 * POST /api/meatspace/epigenetic
 * Add epigenetic test result
 */
router.post('/epigenetic', asyncHandler(async (req, res) => {
  const data = validateRequest(epigeneticTestSchema, req.body);
  const test = await healthService.addEpigeneticTest(data);
  res.status(201).json(test);
}));

/**
 * GET /api/meatspace/eyes
 * Eye Rx history
 */
router.get('/eyes', asyncHandler(async (req, res) => {
  const data = await healthService.getEyeExams();
  res.json(data);
}));

/**
 * POST /api/meatspace/eyes
 * Add eye exam
 */
router.post('/eyes', asyncHandler(async (req, res) => {
  const data = validateRequest(eyeExamSchema, req.body);
  const exam = await healthService.addEyeExam(data);
  res.status(201).json(exam);
}));

/**
 * PUT /api/meatspace/eyes/:index
 * Update an eye exam
 */
router.put('/eyes/:index', asyncHandler(async (req, res) => {
  const index = parseInt(req.params.index, 10);
  if (!Number.isInteger(index) || index < 0) {
    throw new ServerError('Invalid index', { status: 400, code: 'INVALID_INDEX' });
  }
  const data = validateRequest(eyeExamUpdateSchema, req.body);
  const exam = await healthService.updateEyeExam(index, data);
  if (!exam) {
    throw new ServerError('Eye exam not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(exam);
}));

/**
 * DELETE /api/meatspace/eyes/:index
 * Remove an eye exam
 */
router.delete('/eyes/:index', asyncHandler(async (req, res) => {
  const index = parseInt(req.params.index, 10);
  if (!Number.isInteger(index) || index < 0) {
    throw new ServerError('Invalid index', { status: 400, code: 'INVALID_INDEX' });
  }
  const removed = await healthService.removeEyeExam(index);
  if (!removed) {
    throw new ServerError('Eye exam not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(removed);
}));

export default router;
