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
import { importClinicalRecords } from '../services/appleHealthClinical.js';
import {
  getMetricSummary,
  getDailyAggregates,
  getAvailableDateRange,
  getCorrelationData,
  getAvailableMetrics,
  getLatestMetricValues
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

// GET /api/health/metrics/latest
// Returns most recent recorded value for each requested metric
router.get('/metrics/latest', asyncHandler(async (req, res) => {
  const metrics = req.query.metrics?.split(',').filter(Boolean) ?? [];
  if (metrics.length === 0) return res.json({});
  const latest = await getLatestMetricValues(metrics);
  res.json(latest);
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

  // If ZIP, extract export.xml to a temp file and collect clinical records
  let clinicalJsons = [];

  if (req.file.originalname.endsWith('.zip') || isZip(req.file)) {
    const xmlPath = join(tmpdir(), `apple-health-${Date.now()}.xml`);
    let foundXml = false;
    let xmlWriteFinished = false;

    await new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn) => (...args) => { if (!settled) { settled = true; fn(...args); } };

      createReadStream(filePath)
        .pipe(unzipParse())
        .on('entry', (entry) => {
          if (entry.path === 'apple_health_export/export.xml' || entry.path === 'export.xml') {
            foundXml = true;
            const ws = createWriteStream(xmlPath);
            entry.pipe(ws)
              .on('finish', () => { xmlWriteFinished = true; })
              .on('error', settle(reject));
          } else if (entry.path.includes('clinical_records/') && entry.path.endsWith('.json')) {
            // Buffer clinical record JSON files (~1-5KB each)
            const chunks = [];
            entry.on('data', (chunk) => chunks.push(chunk));
            entry.on('end', () => clinicalJsons.push(Buffer.concat(chunks).toString('utf-8')));
          } else {
            entry.autodrain();
          }
        })
        .on('close', () => {
          if (!foundXml) return settle(reject)(new ServerError('ZIP does not contain export.xml', { status: 400, code: 'BAD_REQUEST' }));
          // Wait briefly for XML write stream to finish if close fires first
          if (xmlWriteFinished) return settle(resolve)();
          const check = setInterval(() => { if (xmlWriteFinished) { clearInterval(check); settle(resolve)(); } }, 50);
          setTimeout(() => { clearInterval(check); settle(resolve)(); }, 5000);
        })
        .on('error', settle(reject));
    });

    await fs.unlink(filePath);
    filePath = xmlPath;
    console.log(`📋 Found ${clinicalJsons.length} clinical record files in ZIP`);
  }

  const result = await importAppleHealthXml(filePath, io);

  // Import clinical records if any were found
  let clinicalResult = null;
  if (clinicalJsons.length > 0) {
    clinicalResult = await importClinicalRecords(clinicalJsons, io);
  }

  res.json({ ...result, ...(clinicalResult && { clinical: clinicalResult }) });
}));

export default router;
