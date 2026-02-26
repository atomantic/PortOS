import { Router } from 'express';
import { tmpdir } from 'os';
import multer from 'multer';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { healthIngestSchema } from '../lib/appleHealthValidation.js';
import { ingestHealthData } from '../services/appleHealthIngest.js';
import { importAppleHealthXml } from '../services/appleHealthXml.js';
import {
  getMetricSummary,
  getDailyAggregates,
  getAvailableDateRange,
  getCorrelationData
} from '../services/appleHealthQuery.js';

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, tmpdir()),
    filename: (req, file, cb) => cb(null, `apple-health-${Date.now()}.xml`)
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/xml' || file.mimetype === 'application/xml' || file.originalname.endsWith('.xml')) {
      cb(null, true);
    } else {
      cb(new ServerError('Only XML files are accepted', { status: 400, code: 'BAD_REQUEST' }));
    }
  }
});

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

// POST /api/health/import/xml
// Accepts Apple Health export.xml via multipart upload (multer diskStorage — no OOM on 500MB+)
router.post('/import/xml', upload.single('file'), asyncHandler(async (req, res) => {
  const io = req.app.get('io');
  const filePath = req.file?.path;
  if (!filePath) throw new ServerError('No file uploaded', { status: 400, code: 'BAD_REQUEST' });
  const result = await importAppleHealthXml(filePath, io);
  res.json(result);
}));

export default router;
