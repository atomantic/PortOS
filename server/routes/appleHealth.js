import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { healthIngestSchema } from '../lib/appleHealthValidation.js';
import { ingestHealthData } from '../services/appleHealthIngest.js';
import {
  getMetricSummary,
  getDailyAggregates,
  getAvailableDateRange,
  getCorrelationData
} from '../services/appleHealthQuery.js';

const router = Router();

// POST /api/health/ingest
// Accepts Health Auto Export JSON, validates, deduplicates, and persists
router.post('/ingest', asyncHandler(async (req, res) => {
  const validated = validateRequest(healthIngestSchema, req.body);
  const result = await ingestHealthData(validated);
  res.json(result);
}));

// GET /api/health/metrics/:metricName
// Returns summary stats for a metric over a date range
router.get('/metrics/:metricName', asyncHandler(async (req, res) => {
  const { metricName } = req.params;
  const { from, to } = req.query;
  const summary = await getMetricSummary(metricName, from, to);
  res.json(summary);
}));

// GET /api/health/metrics/:metricName/daily
// Returns daily aggregated values for a metric over a date range
router.get('/metrics/:metricName/daily', asyncHandler(async (req, res) => {
  const { metricName } = req.params;
  const { from, to } = req.query;
  const daily = await getDailyAggregates(metricName, from, to);
  res.json(daily);
}));

// GET /api/health/range
// Returns available date range from all health day files
router.get('/range', asyncHandler(async (req, res) => {
  const range = await getAvailableDateRange();
  res.json(range);
}));

// GET /api/health/correlation
// Returns merged HRV + alcohol + steps + blood data for correlation analysis
router.get('/correlation', asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  const data = await getCorrelationData(from, to);
  res.json(data);
}));

export default router;
