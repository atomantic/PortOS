import { Router } from 'express';
import { tmpdir } from 'os';
import { join } from 'path';
import { createReadStream, createWriteStream, promises as fs } from 'fs';
import { uploadSingle } from '../lib/multipart.js';
import { parseZip, collectZipEntry } from '../lib/zipStream.js';
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

// Polling interval and timeout for XML write-stream completion (ms)
const XML_WRITE_POLL_INTERVAL_MS = 50;
const XML_WRITE_TIMEOUT_MS = 5000;

const isZip = (file) =>
  file.mimetype === 'application/zip' ||
  file.mimetype === 'application/x-zip-compressed' ||
  file.originalname.endsWith('.zip');

const isXml = (file) =>
  file.mimetype === 'text/xml' ||
  file.mimetype === 'application/xml' ||
  file.originalname.endsWith('.xml');

const uploadXml = uploadSingle('file', {
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
// Accepts Apple Health export.xml or ZIP via multipart upload (streaming — no OOM on 500MB+)
router.post('/import/xml', uploadXml, asyncHandler(async (req, res) => {
  const io = req.app.get('io');
  let filePath = req.file?.path;
  if (!filePath) throw new ServerError('No file uploaded', { status: 400, code: 'BAD_REQUEST' });

  // If ZIP, extract export.xml to a temp file and collect clinical records
  let clinicalJsons = [];

  if (req.file.originalname.endsWith('.zip') || isZip(req.file)) {
    const xmlPath = join(tmpdir(), `apple-health-${Date.now()}.xml`);
    let foundXml = false;
    let xmlWriteFinished = false;
    // Each clinical-record collect is async (entries stream through an inflate
    // pipeline), so track them and await all before resolving — otherwise
    // 'close' can fire and drop records whose buffers haven't finished.
    const clinicalReads = [];

    const src = createReadStream(filePath);
    const parser = parseZip();
    let xmlWriteStream = null;

    await new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn) => (...args) => {
        if (settled) return;
        settled = true;
        // On failure, tear down extraction immediately: stop the read stream,
        // the ZIP parser, and any in-flight XML write so nothing keeps consuming
        // work — and, crucially, so a buffered XML write can't re-create xmlPath
        // right after the cleanup below unlinks it (the write-after-unlink race
        // chatgptZipImport guards against). Destroying the write stream discards
        // its pending writes, so the post-reject unlink is final.
        if (fn === reject) {
          src.destroy();
          parser.destroy?.();
          xmlWriteStream?.destroy();
        }
        fn(...args);
      };

      // `.pipe()` doesn't forward source errors, so handle a read failure on the
      // upload stream explicitly (otherwise it would throw unhandled).
      src.on('error', settle(reject));
      src
        .pipe(parser)
        .on('entry', (entry) => {
          if (entry.path === 'apple_health_export/export.xml' || entry.path === 'export.xml') {
            foundXml = true;
            xmlWriteStream = createWriteStream(xmlPath);
            entry.pipe(xmlWriteStream)
              .on('finish', () => { xmlWriteFinished = true; })
              .on('error', settle(reject));
          } else if (entry.path.includes('clinical_records/') && entry.path.endsWith('.json')) {
            // Buffer clinical record JSON files (~1-5KB each). parseZip() entries
            // aren't EventEmitters (no entry.on('data'/'end') — that throws), so
            // pipe into a collecting Writable via the shared helper (which applies
            // MAX_ZIP_MEMBER_BYTES) and track the read so 'close' can await it.
            clinicalReads.push(
              collectZipEntry(entry)
                .then((buf) => { clinicalJsons.push(buf.toString('utf-8')); })
                .catch(settle(reject))
            );
          } else {
            entry.autodrain();
          }
        })
        .on('close', () => {
          if (!foundXml) return settle(reject)(new ServerError('ZIP does not contain export.xml', { status: 400, code: 'BAD_REQUEST' }));
          // Resolve once the XML write stream has flushed AND every clinical
          // record collect has finished. XML completion is signaled via the
          // polled flag; the clinical collects are awaited as promises.
          const finalize = () => Promise.all(clinicalReads).then(settle(resolve));
          if (xmlWriteFinished) return finalize();
          const check = setInterval(() => { if (xmlWriteFinished) { clearInterval(check); clearTimeout(timer); finalize(); } }, XML_WRITE_POLL_INTERVAL_MS);
          const timer = setTimeout(() => { clearInterval(check); finalize(); }, XML_WRITE_TIMEOUT_MS);
        })
        .on('error', settle(reject));
    }).catch(async (err) => {
      // A rejected parse (missing export.xml, or an oversized/corrupt clinical
      // record member) would otherwise orphan the uploaded ZIP and any partial
      // extracted XML on disk. Clean both up before the error bubbles to the
      // centralized middleware (mirrors chatgptZipImport's reject cleanup).
      //
      // settle(reject) already destroy()'d xmlWriteStream, but createWriteStream
      // opens its fd asynchronously and can finish creating xmlPath *after* an
      // early destroy — so unlinking immediately can no-op and leave the temp
      // file behind. Wait for the stream to emit 'close' (the fd is fully
      // opened-and-closed by then) before unlinking.
      if (xmlWriteStream && !xmlWriteStream.closed) {
        await new Promise((res) => xmlWriteStream.once('close', res));
      }
      await fs.unlink(filePath).catch(() => {});
      await fs.unlink(xmlPath).catch(() => {});
      throw err;
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
