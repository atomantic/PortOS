import { Router } from 'express';
import { tmpdir } from 'os';
import { join } from 'path';
import { createReadStream, createWriteStream, promises as fs } from 'fs';
import multer from 'multer';
import { Parse as unzipParse } from 'unzipper';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { healthIngestSchema } from '../lib/appleHealthValidation.js';
import { ingestHealthData } from '../services/appleHealthIngest.js';
import { importAppleHealthXml } from '../services/appleHealthXml.js';
import {
  getMetricSummary,
  getDailyAggregates,
  getAvailableDateRange,
  getCorrelationData,
  getAvailableMetrics
} from '../services/appleHealthQuery.js';

const isZip = (file) =>
  file.mimetype === 'application/zip' ||
  file.mimetype === 'application/x-zip-compressed' ||
  file.originalname.endsWith('.zip');

const isXml = (file) =>
  file.mimetype === 'text/xml' ||
  file.mimetype === 'application/xml' ||
  file.originalname.endsWith('.xml');

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, tmpdir()),
    filename: (req, file, cb) => {
      const ext = isZip(file) ? '.zip' : '.xml';
      cb(null, `apple-health-${Date.now()}${ext}`);
    }
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB max
  fileFilter: (req, file, cb) => {
    if (isXml(file) || isZip(file)) {
      cb(null, true);
    } else {
      cb(new ServerError('Only XML or ZIP files are accepted', { status: 400, code: 'BAD_REQUEST' }));
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

// GET /api/health/metrics/available
// Returns list of metrics that have data in recent day files
router.get('/metrics/available', asyncHandler(async (req, res) => {
  const metrics = await getAvailableMetrics();
  res.json(metrics);
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
// Accepts Apple Health export.xml or ZIP via multipart upload (multer diskStorage — no OOM on 500MB+)
router.post('/import/xml', upload.single('file'), asyncHandler(async (req, res) => {
  const io = req.app.get('io');
  let filePath = req.file?.path;
  if (!filePath) throw new ServerError('No file uploaded', { status: 400, code: 'BAD_REQUEST' });

  // If ZIP, extract export.xml to a temp file
  if (req.file.originalname.endsWith('.zip') || isZip(req.file)) {
    const xmlPath = join(tmpdir(), `apple-health-${Date.now()}.xml`);
    let found = false;

    await new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn) => (...args) => { if (!settled) { settled = true; fn(...args); } };
      createReadStream(filePath)
        .pipe(unzipParse())
        .on('entry', (entry) => {
          if (entry.path === 'apple_health_export/export.xml' || entry.path === 'export.xml') {
            found = true;
            entry.pipe(createWriteStream(xmlPath))
              .on('finish', settle(resolve))
              .on('error', settle(reject));
          } else {
            entry.autodrain();
          }
        })
        .on('close', () => { if (!found) settle(reject)(new ServerError('ZIP does not contain export.xml', { status: 400, code: 'BAD_REQUEST' })); })
        .on('error', settle(reject));
    });

    await fs.unlink(filePath);
    filePath = xmlPath;
  }

  const result = await importAppleHealthXml(filePath, io);
  res.json(result);
}));

export default router;
