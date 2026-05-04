import express from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errorHandler.js';
import * as browserService from '../services/browserService.js';

const router = express.Router();

// Validation schemas
const navigateSchema = z.object({
  url: z.string().url()
});

const updateConfigSchema = z.object({
  cdpPort: z.number().int().min(1024).max(65535).optional(),
  cdpHost: z.enum(['127.0.0.1', 'localhost', '::1']).optional(),
  healthPort: z.number().int().min(1024).max(65535).optional(),
  autoConnect: z.boolean().optional(),
  headless: z.boolean().optional(),
  userDataDir: z.string().optional(),
  downloadDir: z.string().refine(
    v => !v || !v.includes('..'),
    { message: 'downloadDir must not contain path traversal' }
  ).optional()
});

// GET /api/browser - Full browser status
router.get('/', asyncHandler(async (req, res) => {
  const status = await browserService.getFullStatus();
  res.json(status);
}));

// GET /api/browser/config - Get browser config
router.get('/config', asyncHandler(async (req, res) => {
  const config = await browserService.getConfig();
  res.json(config);
}));

// PUT /api/browser/config - Update browser config
router.put('/config', asyncHandler(async (req, res) => {
  const updates = updateConfigSchema.parse(req.body);
  const config = await browserService.updateConfig(updates);
  res.json(config);
}));

// POST /api/browser/launch - Start the browser process
router.post('/launch', asyncHandler(async (req, res) => {
  console.log('🌐 Browser launch requested');
  const status = await browserService.launchBrowser();
  res.json(status);
}));

// POST /api/browser/stop - Stop the browser process
router.post('/stop', asyncHandler(async (req, res) => {
  console.log('🛑 Browser stop requested');
  const status = await browserService.stopBrowser();
  res.json(status);
}));

// POST /api/browser/restart - Restart the browser process
router.post('/restart', asyncHandler(async (req, res) => {
  console.log('🔄 Browser restart requested');
  const status = await browserService.restartBrowser();
  res.json(status);
}));

// POST /api/browser/navigate - Open a URL in the CDP browser
router.post('/navigate', asyncHandler(async (req, res) => {
  const { url } = navigateSchema.parse(req.body);
  console.log(`🌐 Navigate requested: ${url}`);
  const page = await browserService.navigateToUrl(url);
  res.json(page);
}));

// GET /api/browser/health - Quick health check
router.get('/health', asyncHandler(async (req, res) => {
  const health = await browserService.getHealthStatus();
  res.json(health);
}));

// GET /api/browser/process - PM2 process status
router.get('/process', asyncHandler(async (req, res) => {
  const processStatus = await browserService.getProcessStatus();
  res.json(processStatus);
}));

// GET /api/browser/pages - List open CDP pages
router.get('/pages', asyncHandler(async (req, res) => {
  const pages = await browserService.getOpenPages();
  res.json(pages);
}));

// GET /api/browser/version - CDP version info
router.get('/version', asyncHandler(async (req, res) => {
  const version = await browserService.getCdpVersion();
  if (!version) {
    return res.status(503).json({ error: 'Browser not reachable' });
  }
  res.json(version);
}));

// GET /api/browser/logs - Recent PM2 logs
router.get('/logs', asyncHandler(async (req, res) => {
  const lines = parseInt(req.query.lines || '50', 10);
  const logs = await browserService.getRecentLogs(lines);
  res.json(logs);
}));

// GET /api/browser/downloads - List downloaded files
router.get('/downloads', asyncHandler(async (req, res) => {
  const downloads = await browserService.getDownloads();
  res.json(downloads);
}));

// Extensions that could execute scripts when served inline at the same origin —
// always force attachment to keep XSS via a downloaded asset off the table.
const RISKY_DOWNLOAD_EXTS = new Set(['.html', '.htm', '.svg', '.js', '.mjs', '.xml']);

// GET /api/browser/downloads/:name - Stream a downloaded file to the client.
// Inline by default so previewable types (images, PDFs, videos) open in the
// browser; the listing UI passes ?attachment=1 + HTML5 `download` for save-to-disk.
router.get('/downloads/:name', asyncHandler(async (req, res) => {
  const file = await browserService.resolveDownload(req.params.name);
  if (!file) return res.status(404).json({ error: 'File not found' });
  res.set('X-Content-Type-Options', 'nosniff');
  // Files of the same name can be replaced by a fresh Chrome download; bypass
  // any aggressive client/intermediary caching so the user always sees current.
  res.set('Cache-Control', 'no-cache, must-revalidate');
  const forceAttachment = RISKY_DOWNLOAD_EXTS.has(file.ext) || req.query.attachment === '1';
  if (forceAttachment) {
    // RFC 5987: ASCII-safe fallback + utf-8 form for non-ASCII names.
    const ascii = file.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    res.set(
      'Content-Disposition',
      `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`
    );
  }
  res.type(file.mime).sendFile(file.absPath);
}));

// DELETE /api/browser/downloads/:name - Remove a downloaded file
router.delete('/downloads/:name', asyncHandler(async (req, res) => {
  const removed = await browserService.deleteDownload(req.params.name);
  if (!removed) return res.status(404).json({ error: 'File not found' });
  console.log(`🗑️ Browser download deleted: ${req.params.name}`);
  res.json({ success: true });
}));

export default router;
